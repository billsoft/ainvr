import type {PoolClient} from 'pg';
import {PtzStore,type PtzCameraDraft} from './ptzStore.js';
import {randomUUID} from 'node:crypto';
import type {PgConfigStore} from './pgStore.js';
import {boardCapacityLimit,defaultGBSettings,gbSettingsSchema,gbDeviceSchema,type GBSettings} from './gbSettings.js';

type GBChannelConfig={deviceId:string;channelId:string;inputId?:string;transport:string;enabled:boolean;config:{name:string;description:string;protocols:string[];primary:string};ptz?:PtzCameraDraft};

export class GBError extends Error {
  constructor(message:string,public statusCode=400){super(message);}
}
/** Every desired-state edit shares a revision lock, including secret rotation. */
export class GB28181Store {
  /** inputIds lists the console inputs that still exist. When a customer deletes
   *  a GB input, the sync disables its mapping but keeps the id for history;
   *  such a disabled mapping to a deleted input is free to add again.
   *  capacityLimit is how many GB streams this board may receive at once. */
  constructor(public pg:PgConfigStore,private inputIds?:()=>Promise<Set<string>>,public readonly capacityLimit=boardCapacityLimit()){}
  /** One input lookup per request, however many catalog rows it covers. */
  private async liveInputs(){
    try{return this.inputIds?await this.inputIds():null;}catch{return null;}
  }
  private deletedInput(binding:{input_id?:string|null;enabled?:boolean}|undefined,live:Set<string>|null){
    return !!binding?.input_id&&!binding.enabled&&!!live&&!live.has(binding.input_id);
  }
  private async markDeleted<T extends {input_id?:string|null;enabled?:boolean}>(rows:T[]){
    if(!rows.some(r=>r.input_id&&!r.enabled))return rows;
    const live=await this.liveInputs();
    for(const row of rows)if(this.deletedInput(row,live))row.input_id=null;
    return rows;
  }
  /** Catalog rows with their mapping; a disabled mapping to a deleted input is reported free. */
  async channelInputs(device:string,client:{query:PoolClient['query']}=this.pg.pool){
    const {rows}=await client.query(`SELECT c.channel_id AS id,c.document,c.available,b.input_id,b.enabled,b.transport
      FROM gb28181_catalog c LEFT JOIN gb28181_bindings b USING(device_id,channel_id) WHERE c.device_id=$1 ORDER BY c.channel_id`,[device]);
    return this.markDeleted(rows);
  }
  private async releaseDeletedInput(client:PoolClient,binding:{binding_id:string;input_id?:string|null;enabled?:boolean}|undefined,live?:Set<string>|null){
    if(!binding?.input_id||binding.enabled)return false;
    if(!this.deletedInput(binding,live===undefined?await this.liveInputs():live))return false;
    await client.query('UPDATE gb28181_bindings SET input_id=NULL WHERE binding_id=$1',[binding.binding_id]);
    return true;
  }
  async readSettings(){
    const {rows}=await this.pg.pool.query('SELECT revision,document FROM gb28181_settings WHERE singleton');
    if(!rows.length)throw new GBError('国标参数库尚未就绪',503);
    // A fresh installation offers the whole board; a saved choice is kept as is.
    return {revision:Number(rows[0].revision),settings:gbSettingsSchema.parse({...defaultGBSettings,capacity:this.capacityLimit,...rows[0].document}),
      tokenSet:await this.pg.hasSecret('gb28181/gateway-token')};
  }
  /** Devices with their registration-relevant fields and how many inputs use them. */
  async deviceOverview(){
    const {rows}=await this.pg.pool.query(`SELECT d.device_id AS id,d.name,d.profile AS version,d.enabled,d.media_ips AS "mediaIPs",d.updated_at,
      coalesce(json_agg(json_build_object('input_id',b.input_id,'enabled',b.enabled)) FILTER (WHERE b.binding_id IS NOT NULL),'[]') AS bindings
      FROM gb28181_devices d LEFT JOIN gb28181_bindings b ON b.device_id=d.device_id GROUP BY d.device_id ORDER BY d.name,d.device_id`);
    const live=await this.liveInputs();
    return rows.map(({bindings,...d}:{bindings:{input_id:string|null;enabled:boolean}[]})=>({...d,
      channels:bindings.filter(b=>b.input_id&&(!live||live.has(b.input_id))).length}));
  }
  private async mutate<T>(expected:number,actor:string,action:string,work:(client:PoolClient)=>Promise<T>){
    const client=await this.pg.pool.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query('SELECT revision FROM gb28181_settings WHERE singleton FOR UPDATE');
      if(Number(rows[0]?.revision)!==expected)throw new GBError('配置已被其他操作修改，请刷新后重试',409);
      const result=await work(client);
      await client.query('UPDATE gb28181_settings SET revision=revision+1,updated_at=now() WHERE singleton');
      await client.query(`INSERT INTO config_audit_logs(actor,action,service,version_before,version_after)
        VALUES($1,$2,'gb28181',$3,$4)`,[actor,action,expected,expected+1]);
      await client.query('COMMIT');
      return {revision:expected+1,result};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  private async secret(client:PoolClient,key:string,value:string){
    await client.query(`INSERT INTO config_secrets(key_path,ciphertext) VALUES($1,$2)
      ON CONFLICT(key_path) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()`,[key,this.pg.encryptSecret(value)]);
  }
  async saveSettings(settings:GBSettings,token:string|undefined,expected:number,actor:string){
    const parsed=gbSettingsSchema.safeParse(settings);
    if(!parsed.success)throw new GBError(parsed.error.issues.map(i=>i.message).join('；'));
    if(token!==undefined&&(token.length<32||token.length>512))throw new GBError('服务密钥需要 32–512 个字符');
    if(settings.capacity>this.capacityLimit)throw new GBError(`本机最多同时接入 ${this.capacityLimit} 路国标视频`);
    return this.mutate(expected,actor,'gb-settings',async client=>{
      if(settings.enabled&&!token&&!await this.pg.hasSecret('gb28181/gateway-token'))throw new GBError('请先配置网关服务密钥');
      if(settings.enabled&&[settings.advertiseIp,settings.mediaAdvertiseIp].some(ip=>ip==='0.0.0.0'||ip.startsWith('127.')))
        throw new GBError('请填写摄像头可以访问的信令与媒体地址');
      const count=await client.query('SELECT count(*) AS n FROM gb28181_bindings WHERE enabled');
      if(Number(count.rows[0].n)>settings.capacity)throw new GBError('已启用通道数超过新的容量，请先停用部分国标通道');
      if(token)await this.secret(client,'gb28181/gateway-token',token);
      await client.query('UPDATE gb28181_settings SET document=$1 WHERE singleton',[parsed.data]);
    });
  }
  async devices(){
    const {rows}=await this.pg.pool.query('SELECT device_id AS id,name,profile AS version,enabled,media_ips AS "mediaIPs",updated_at FROM gb28181_devices ORDER BY name,device_id');
    return rows;
  }
  async saveDevice(input:unknown,expected:number,actor:string){
    const parsed=gbDeviceSchema.safeParse(input);
    if(!parsed.success)throw new GBError('设备标识须为 20 位数字，密码至少 8 个字符');
    const d=parsed.data;
    return this.mutate(expected,actor,'gb-device',async client=>{
      const old=await client.query('SELECT 1 FROM gb28181_devices WHERE device_id=$1',[d.id]);
      if(!old.rowCount&&!d.password)throw new GBError('新设备必须设置独立密码');
      const count=await client.query('SELECT count(*) AS n FROM gb28181_devices');
      if(!old.rowCount&&Number(count.rows[0].n)>=1024)throw new GBError('设备数量已达上限');
      const key=`gb28181/device/${d.id}`;
      if(d.password)await this.secret(client,key,d.password);
      await client.query(`INSERT INTO gb28181_devices(device_id,name,profile,enabled,secret_ref,media_ips) VALUES($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT(device_id) DO UPDATE SET name=EXCLUDED.name,profile=EXCLUDED.profile,enabled=EXCLUDED.enabled,media_ips=EXCLUDED.media_ips,updated_at=now()`,[d.id,d.name,d.version,d.enabled,key,JSON.stringify(d.mediaIPs)]);
    });
  }
  async catalog(device:string){
    const {rows}=await this.pg.pool.query(`SELECT c.channel_id AS id,c.document,c.available,b.binding_id,b.input_id,b.enabled,b.transport
      FROM gb28181_catalog c LEFT JOIN gb28181_bindings b USING(device_id,channel_id)
      WHERE c.device_id=$1 ORDER BY c.channel_id`,[device]);
    return this.markDeleted(rows);
  }
  /** A device can be deleted once none of its channels is in use: no mapping is
   *  enabled and every input it fed has been deleted from the channel list.
   *  Recordings belong to those inputs and are not touched. */
  async removeDevice(device:string,expected:number,actor:string){
    return this.mutate(expected,actor,'gb-device-delete',async client=>{
      const {rows}=await client.query('SELECT input_id,enabled FROM gb28181_bindings WHERE device_id=$1 FOR UPDATE',[device]);
      const live=rows.some(b=>b.input_id&&!b.enabled)?await this.liveInputs():null;
      const inUse=rows.filter(b=>b.enabled||b.input_id&&!this.deletedInput(b,live)).length;
      if(inUse)throw new GBError(`该设备仍有 ${inUse} 路通道在用，请先在通道列表删除这些通道或停用设备`,409);
      await client.query('DELETE FROM gb28181_bindings WHERE device_id=$1',[device]);
      await client.query('DELETE FROM gb28181_catalog WHERE device_id=$1',[device]);
      await client.query('DELETE FROM gb28181_devices WHERE device_id=$1',[device]);
      await client.query('DELETE FROM config_secrets WHERE key_path=$1',[`gb28181/device/${device}`]);
    });
  }
  async saveChannel(input:GBChannelConfig,expected:number,actor:string){
    return this.mutate(expected,actor,'gb-channel-save',client=>this.writeChannel(client,input,actor));
  }
  async saveChannels(inputs:GBChannelConfig[],expected:number,actor:string){
    if(!inputs.length||inputs.length>100||new Set(inputs.map(i=>i.deviceId+':'+i.channelId)).size!==inputs.length)throw new GBError('批量接入目录无效');
    return this.mutate(expected,actor,'gb-channels-save',async client=>{
      const items=[];for(const input of inputs)items.push(await this.writeChannel(client,input,actor));
      return {count:items.length,state:'pending_application'};
    });
  }
  private async writeChannel(client:PoolClient,input:GBChannelConfig,actor:string){
      const known=await client.query('SELECT 1 FROM gb28181_catalog WHERE device_id=$1 AND channel_id=$2',[input.deviceId,input.channelId]);
      if(!known.rowCount)throw new GBError('请先获取并选择设备目录');
      const current=(await client.query('SELECT * FROM gb28181_bindings WHERE device_id=$1 AND channel_id=$2 FOR UPDATE',[input.deviceId,input.channelId])).rows[0];
      const released=!input.inputId&&await this.releaseDeletedInput(client,current);
      const currentInput=released?null:current?.input_id;
      if(input.inputId ? currentInput!==input.inputId : !!currentInput)throw new GBError('该目录通道已接入或映射已变化，请从通道列表编辑',409);
      const settings=(await client.query('SELECT document FROM gb28181_settings WHERE singleton')).rows[0].document;
      const count=(await client.query('SELECT count(*) AS n FROM gb28181_bindings WHERE enabled AND NOT(device_id=$1 AND channel_id=$2)',[input.deviceId,input.channelId])).rows[0].n;
      if(input.enabled&&Number(count)>=Number(settings.capacity??this.capacityLimit))throw new GBError('已达到同时收流上限');
      const bindingId=current?.binding_id??randomUUID();
      await client.query(`INSERT INTO gb28181_bindings(binding_id,device_id,channel_id,stream_name,enabled,transport,channel_config)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id,channel_id) DO UPDATE SET enabled=EXCLUDED.enabled,transport=EXCLUDED.transport,channel_config=EXCLUDED.channel_config`,
        [bindingId,input.deviceId,input.channelId,`gb_${bindingId.replaceAll('-','')}`,input.enabled,input.transport,input.config]);
      if(input.ptz){const key=`gb28181:${input.deviceId}/${input.channelId}`;await new PtzStore(this.pg.pool).writeCamera(client,key,key,input.ptz,actor)}
      return {bindingId,state:'pending_application'};
  }
  async bind(device:string,channel:string,transport:string,enabled:boolean,expected:number,actor:string){
    if(!/^\d{20}$/.test(device)||!/^\d{20}$/.test(channel)||!['udp','tcp-passive','tcp-active'].includes(transport))throw new GBError('接入参数无效');
    return this.mutate(expected,actor,'gb-bind',async client=>{
      const known=await client.query('SELECT 1 FROM gb28181_catalog WHERE device_id=$1 AND channel_id=$2',[device,channel]);
      if(!known.rowCount)throw new GBError('请先获取设备目录');
      const current=await client.query('SELECT * FROM gb28181_bindings WHERE device_id=$1 AND channel_id=$2 FOR UPDATE',[device,channel]);
      await this.releaseDeletedInput(client,current.rows[0]);
      const settings=await client.query('SELECT document FROM gb28181_settings WHERE singleton');
      const count=await client.query('SELECT count(*) AS n FROM gb28181_bindings WHERE enabled AND NOT(device_id=$1 AND channel_id=$2)',[device,channel]);
      if(enabled&&Number(count.rows[0].n)>=Number(settings.rows[0].document.capacity??this.capacityLimit))throw new GBError('已达到同时收流上限');
      const bindingId=current.rows[0]?.binding_id??randomUUID();
      await client.query(`INSERT INTO gb28181_bindings(binding_id,device_id,channel_id,stream_name,enabled,transport)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,channel_id) DO UPDATE SET enabled=EXCLUDED.enabled,transport=EXCLUDED.transport`,
        [bindingId,device,channel,`gb_${bindingId.replaceAll('-','')}`,enabled,transport]);
      return {bindingId};
    });
  }
  async bindMany(device:string,channels:string[],transport:string,expected:number,actor:string){
    if(!/^\d{20}$/.test(device)||channels.length<1||channels.length>100||new Set(channels).size!==channels.length||channels.some(id=>!/^\d{20}$/.test(id))||!['udp','tcp-passive','tcp-active'].includes(transport))throw new GBError('批量接入参数无效');
    return this.mutate(expected,actor,'gb-bind-batch',async client=>{
      const known=await client.query('SELECT channel_id FROM gb28181_catalog WHERE device_id=$1 AND channel_id=ANY($2::text[])',[device,channels]);
      if(known.rowCount!==channels.length)throw new GBError('部分通道不在设备目录中，请刷新后重试');
      const settings=await client.query('SELECT document FROM gb28181_settings WHERE singleton');
      const count=await client.query('SELECT count(*) AS n FROM gb28181_bindings WHERE enabled AND NOT(device_id=$1 AND channel_id=ANY($2::text[]))',[device,channels]);
      if(Number(count.rows[0].n)+channels.length>Number(settings.rows[0].document.capacity??this.capacityLimit))throw new GBError('选择的通道超过同时收流上限，请减少选择或先停用其他通道');
      const live=await this.liveInputs();
      for(const channel of channels){
        await this.releaseDeletedInput(client,(await client.query('SELECT * FROM gb28181_bindings WHERE device_id=$1 AND channel_id=$2 FOR UPDATE',[device,channel])).rows[0],live);
        const id=randomUUID();
        await client.query(`INSERT INTO gb28181_bindings(binding_id,device_id,channel_id,stream_name,enabled,transport)
          VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(device_id,channel_id) DO UPDATE SET enabled=true,transport=EXCLUDED.transport`,
          [id,device,channel,`gb_${id.replaceAll('-','')}`,transport]);
      }
      return {count:channels.length};
    });
  }
}
