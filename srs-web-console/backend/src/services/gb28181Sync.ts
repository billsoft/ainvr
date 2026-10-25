import {createHash} from 'node:crypto';
import type {DownstreamProtocol} from '../types/channel.js';
import type {ChannelService} from './channelService.js';
import {GB28181Store,GBError} from '../store/gb28181Store.js';

export class GB28181Sync {
  private pending:Promise<void>|null=null;
  private catalogs=new Map<string,string>();
  private state:Record<string,unknown>={state:'waiting_configuration',validation:'development_unverified'};
  constructor(private store:GB28181Store,private channels:ChannelService){}
  status(){return this.state;}
  private async call(path:string,body?:unknown){
    const {settings}=await this.store.readSettings();
    const token=await this.store.pg.getSecret('gb28181/gateway-token');
    if(!token)throw new GBError('尚未配置网关服务密钥',503);
    const response=await fetch(settings.gatewayUrl.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',
      headers:{'X-Service-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(18000),redirect:'error'});
    if(!response.ok)throw new GBError('网关尚未就绪或拒绝配置，请检查服务及连接设置',503);
    if(response.status===202&&path.includes('catalog-refresh'))return {};
    const reader=response.body?.getReader();
    if(!reader)throw new GBError('网关响应为空',503);
    const chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;
      if(length>4*1024*1024)throw new GBError('网关响应超过容量限制',503);chunks.push(value);}
    }finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async refresh(device:string){return this.call(`/v1/devices/${device}/catalog-refresh`,{});}
  synchronize(){
    if(this.pending)return this.pending;
    this.pending=this.run().catch(()=>{this.state={state:'unavailable',message:'网关未连接或配置尚未应用',validation:'development_unverified'};})
      .finally(()=>{this.pending=null;});
    return this.pending;
  }
  private async run(){
    const start=await this.store.readSettings();
    const devices=await this.store.devices();
    for(const id of this.catalogs.keys())if(!devices.some(d=>d.id===id))this.catalogs.delete(id);
    const credentials=await Promise.all(devices.map(async d=>({id:d.id,version:d.version,enabled:d.enabled,mediaIPs:d.mediaIPs??[],password:await this.store.pg.getSecret(`gb28181/device/${d.id}`)})));
    const {rows:bindings}=await this.store.pg.pool.query(`SELECT b.*,c.document FROM gb28181_bindings b JOIN gb28181_catalog c USING(device_id,channel_id)`);
    // Stream names are reserved before creating inputs. A retry finds the same
    // stream after a crash between the channel write and the mapping write.
    const inputs=bindings.length?await this.channels.listChannels():[];
    const ownsInput=(b:typeof bindings[number])=>inputs.some(i=>i.id===b.input_id&&i.upstreamProtocol==='rtmp'&&(i.app||'live')==='live'&&i.streamName===b.stream_name);
    const invalid=bindings.filter(b=>b.enabled&&b.input_id&&(!ownsInput(b)||inputs.find(i=>i.id===b.input_id)?.inputEnabled===false));
    if(invalid.length){
      const client=await this.store.pg.pool.connect();
      try{
        await client.query('BEGIN');
        const before=await client.query('SELECT revision FROM gb28181_settings WHERE singleton FOR UPDATE');
        // A user may have edited the binding while the input list was loading.
        if(Number(before.rows[0].revision)!==start.revision){await client.query('ROLLBACK');return;}
        await client.query('UPDATE gb28181_bindings SET enabled=false WHERE binding_id=ANY($1::uuid[])',[invalid.map(b=>b.binding_id)]);
        await client.query('UPDATE gb28181_settings SET revision=revision+1,updated_at=now() WHERE singleton');
        await client.query(`INSERT INTO config_audit_logs(actor,action,service,version_before,version_after) VALUES('gb-sync','disable-missing-or-changed-input','gb28181',$1,$2)`,[Number(before.rows[0].revision),Number(before.rows[0].revision)+1]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      return;
    }
    for(const b of bindings){
      if(b.input_id){
        // Deleted or repurposed inputs retain their history but must not block
        // synchronization, or receive metadata belonging to the old GB source.
        if(!ownsInput(b))continue;
        if(b.channel_config&&JSON.stringify(b.channel_config)!==JSON.stringify(b.applied_config)){
          const config=b.channel_config;
          await this.channels.updateChannel(b.input_id,{name:config.name,remark:config.description,downstreamProtocols:config.protocols as DownstreamProtocol[],primaryProtocol:config.primary});
          await this.store.pg.pool.query('UPDATE gb28181_bindings SET applied_config=$1 WHERE binding_id=$2 AND channel_config=$1',[config,b.binding_id]);
        }
        continue;
      }
      let input=inputs.find(c=>c.streamName===b.stream_name);
      if(!input)input=await this.channels.createChannel({name:String(b.channel_config?.name||b.document.name||b.channel_id),upstreamProtocol:'rtmp',app:'live',streamName:b.stream_name,
        downstreamProtocols:b.channel_config?.protocols??['flv','webrtc','hls'],primaryProtocol:b.channel_config?.primary??'flv',inputEnabled:true,remark:b.channel_config?.description??'国标网关输入'});
      b.input_id=input.id;inputs.push(input);
      await this.store.pg.pool.query('UPDATE gb28181_bindings SET input_id=$1 WHERE binding_id=$2 AND input_id IS NULL',[input.id,b.binding_id]);
    }
    if(!start.tokenSet){this.state={state:'waiting_configuration',enabled:false};return;}
    const latest=await this.store.readSettings();
    if(latest.revision!==start.revision)return; // Never send a mixed configuration snapshot.
    const s=start.settings;
    const mediaSecret=await this.store.pg.getSecret('gb28181/media-secret');
    if(s.enabled&&!mediaSecret)throw new GBError('国标媒体组件尚未部署',503);
    await this.call('/v1/config',{revision:start.revision,enabled:s.enabled,
      sip:{serverId:s.serverId,realm:s.realm,listen:`${s.listenIp}:${s.sipPort}`,advertiseIp:s.advertiseIp,maxDevices:1024,maxCatalogItems:10000,heartbeatTimeoutSec:s.heartbeatTimeoutSec,devices:credentials},
      media:{domainId:s.serverId,api:'http://127.0.0.1:8097',secret:mediaSecret??'',listenIp:'0.0.0.0',advertiseIp:s.mediaAdvertiseIp,portStart:s.mediaPortStart,portEnd:s.mediaPortEnd,capacity:s.capacity},
      bridge:{ffmpeg:'/opt/ainvr/gb28181/ffmpeg/bin/ffmpeg',httpBase:'http://127.0.0.1:8097',rtspBase:'rtsp://127.0.0.1:8556',rtmpBase:'rtmp://127.0.0.1:1935'},srsApi:'http://127.0.0.1:1985',
      bindings:bindings.map(b=>({id:b.binding_id,deviceId:b.device_id,channelId:b.channel_id,app:'live',stream:b.stream_name,mode:b.transport,enabled:b.enabled}))});
    const status=await this.call('/v1/status');
    if(status.revision!==start.revision)throw new GBError('等待网关应用配置',503);
    this.state={...status,state:status.error?'failed':!s.enabled?'disabled':status.ready?'running':'applying'};
    // Incomplete or timed-out catalogs never erase a previously discovered row.
    for(const d of status.devices??[]){
      if(!devices.some(v=>v.id===d.id)||!d.catalogComplete||!Array.isArray(d.catalog)||d.catalog.length>10000)continue;
      if(d.catalog.some((item:{id?:string})=>!/^\d{20}$/.test(item.id??'')))continue;
      const fingerprint=createHash('sha256').update(JSON.stringify([start.settings.gatewayUrl,d.generation,[...d.catalog].sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id))])).digest('hex');
      if(this.catalogs.get(d.id)===fingerprint)continue;
      const client=await this.store.pg.pool.connect();
      try{
        await client.query('BEGIN');
        await client.query('UPDATE gb28181_catalog SET available=false WHERE device_id=$1',[d.id]);
        // One bounded bulk write, not one query per camera on every poll.
        await client.query(`INSERT INTO gb28181_catalog(device_id,channel_id,document,available)
          SELECT $1,item->>'id',item,true FROM jsonb_array_elements($2::jsonb) AS item
          ON CONFLICT(device_id,channel_id) DO UPDATE SET document=EXCLUDED.document,available=true,last_seen=now()`,[d.id,JSON.stringify(d.catalog)]);
        await client.query('COMMIT');
        this.catalogs.set(d.id,fingerprint);
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
  }
}
