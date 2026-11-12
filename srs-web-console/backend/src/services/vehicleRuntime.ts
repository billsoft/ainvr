import {AlarmConfigError} from '../store/alarmZones.js';
import {createHash} from 'node:crypto';
import {endpoint,limitedBytes,type InternalServiceConnection} from './internalServiceHttp.js';
import {createVehicleArtifactReader} from './vehicleArtifacts.js';
import {vehicleOnly,type VehiclePreparation} from '../store/vehiclePreparation.js';
import type {AlarmArmingStore} from '../store/alarmArmingStore.js';
export class VehicleRuntime {
 private sources=new Map<string,{state:string;width?:number;height?:number}>();
 private pending:Promise<void>|null=null;private timer?:ReturnType<typeof setInterval>;private stopped=false;
 private readonly artifacts=createVehicleArtifactReader();private state:any={implemented:false,ready:false};private alarmReady=false;private lastSuccess=0;
 constructor(private store:VehiclePreparation,private arming:AlarmArmingStore,private ai:()=>Promise<InternalServiceConnection|null>,private alarm:()=>Promise<InternalServiceConnection|null>,private channelExists:(id:string)=>Promise<boolean>,private source:(id:string)=>Promise<{width:number;height:number}|null>=async()=>null,private configuredChannels?:()=>Promise<string[]>){}
 private async request(kind:'ai'|'alarm',path:string,body?:unknown,extra?:{jpeg:Buffer;meta:unknown}){
  const c=await (kind==='ai'?this.ai():this.alarm());if(!c)throw Error('vehicle_service_unavailable');
  const headers:Record<string,string>=kind==='ai'?{'x-api-key':c.apiToken}:{authorization:`Bearer ${c.apiToken}`};
  if(extra){headers['content-type']='image/jpeg';headers['x-ainvr-vehicle']=JSON.stringify(extra.meta);}else if(body)headers['content-type']='application/json';
  const response=await fetch(endpoint(c,path),{method:body||extra?'POST':'GET',redirect:'error',headers,signal:AbortSignal.timeout(extra?30000:5000),body:extra?new Uint8Array(extra.jpeg):body?JSON.stringify(body):undefined});
  if(!response.ok){const bytes=await limitedBytes(response,65536);let data:any;try{data=JSON.parse(bytes.toString())}catch{}const code=typeof data?.error?.code==='string'&&/^[a-z_]{1,80}$/.test(data.error.code)?data.error.code:'vehicle_service_unavailable';throw new AlarmConfigError(code,'车辆服务尚未完成处理，请按状态重试',[403,409,422,429,503,504].includes(response.status)?response.status:503);}return JSON.parse((await limitedBytes(response,65536)).toString());
 }
 async sync():Promise<void>{if(this.pending){await this.pending;return this.sync();}if(this.stopped)return;
  this.pending=this.apply().catch(()=>{this.alarmReady=false;}).finally(()=>{this.pending=null});await this.pending;}
 private async apply(){
  const artifacts=await this.artifacts(),needed=artifacts.slice(0,2);if(needed.some(a=>a.state!=='verified_file'||!a.sha256))throw Error('vehicle_model_unavailable');
  const wanted=this.configuredChannels?await this.configuredChannels():await this.store.requestedChannels(),channels=[];this.sources.clear();for(const id of wanted)if(await this.channelExists(id)){const status=await this.preflight(id,false);if(status.state==='supported')channels.push(id);}
  const counters=(await this.arming.listCounters(true)).filter(c=>vehicleOnly(c.labels)&&!c.deleting);
  const watch=await this.store.read('watchlist');const now=Date.now(),model_pin=createHash('sha256').update(needed.map(a=>a.sha256).join('|')).digest('hex');
  const config={issued_ms:now,expires_ms:now+45000,channels,authorized_channels:wanted,model_pin,counter_ids:counters.map(c=>c.counter_id),watchlist:{version:watch.version,digest:createHash('sha256').update(JSON.stringify([watch.version,(watch.document as any).entries.map((e:any)=>e.plate).sort()])).digest('hex')}};
  this.state=await this.request('ai','/api/v1/vehicles/configure',{issued_ms:now,expires_ms:config.expires_ms,channels,model_pin});
  const alarm=await this.request('alarm','/v1/vehicles/configure',config);this.alarmReady=alarm.ready===true;this.lastSuccess=Date.now();
 }
 async configured(id:string){return this.configuredChannels?(await this.configuredChannels()).includes(id):null;}
 async watchlist(version:number){const list=await this.store.watchlistVersion(version);return {...list,digest:createHash('sha256').update(JSON.stringify([version,list.entries.map(e=>e.plate).sort()])).digest('hex')};}
 async preflight(id:string,reject=true){
  let source=null;try{source=await this.source(id)}catch{}
  const status=source?{...source,state:source.width%2||source.height%2||source.width<16||source.height<16||source.width*source.height>8*1024*1024?'unsupported':'supported'}:{state:'awaiting_video'};
  this.sources.set(id,status);
  if(reject&&status.state==='unsupported')throw new AlarmConfigError('unsupported_image','当前视频尺寸不支持车牌识别：需偶数尺寸且不超过8388608像素',422);
  return status;
 }
 async capability(){let fresh:any=null;try{fresh=await this.request('ai','/api/v1/vehicles/status');this.state=fresh;}catch{}
  const queue=await this.request('alarm','/v1/vehicles/status').catch(()=>null);
  const effective=!!fresh?.ready&&this.alarmReady&&Date.now()-this.lastSuccess<45000;
  return {state:fresh?.implemented?'available':'unavailable',effective,reason:effective?'车牌识别已运行；真实场景准确率尚未验收':[...this.sources.values()].some(s=>s.state==='unsupported')?'视频尺寸不支持，车牌识别已暂停':[...this.sources.values()].some(s=>s.state==='awaiting_video')?'配置已保存，等待视频尺寸核验':fresh?.error?'车牌模型加载失败，请检查模型契约和设备资源':fresh?.configured_channels?.length?'配置已保存，模型加载或服务同步尚未完成':fresh?.implemented?'车牌功能已接入，按通道配置启用；请绑定车辆计数器':'车牌服务暂不可用',blockers:fresh?.implemented?[]:['runtime_unavailable'],accuracy_verified:false,queue,source_states:Object.fromEntries(this.sources),runtime:this.state,artifacts:(await this.artifacts()).map((a,i)=>({...a,adapter_integrated:!!fresh?.implemented&&i<2}))};
 }
 async recognize(meta:any,jpeg:Buffer){
  if(!meta||!Array.isArray(meta.vehicle_roi)||meta.vehicle_roi.length!==4||!meta.vehicle_roi.every(Number.isSafeInteger)||typeof meta.channel_id!=='string'||!Number.isSafeInteger(meta.expires_ms)||meta.expires_ms<=Date.now()||meta.expires_ms>Date.now()+30000||jpeg.length<4||jpeg.length>8*1024*1024||createHash('sha256').update(jpeg).digest('hex')!==meta.jpeg_sha256)throw Error('invalid_vehicle_request');
  if(this.configuredChannels){if(!(await this.configuredChannels()).includes(meta.channel_id))throw Error('vehicle_disabled');}else {const requested=await this.store.read('channel:'+meta.channel_id);if(!(requested.document as any).requested)throw Error('vehicle_disabled');}
  return this.request('ai','/api/v1/vehicles/recognize',undefined,{jpeg,meta});
 }
 async alarmFetch(path:string,method='GET',body?:unknown,actor?:string){
  const c=await this.alarm();if(!c)throw Error('vehicle_service_unavailable');const headers:Record<string,string>={authorization:`Bearer ${c.apiToken}`};if(body)headers['content-type']='application/json';if(actor)headers['x-ainvr-actor']=actor;
  const r=await fetch(endpoint(c,path),{method,redirect:'error',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
  if(!r.ok){let payload:any;try{payload=JSON.parse((await limitedBytes(r,65536)).toString())}catch{}const code=typeof payload?.error?.code==='string'?payload.error.code:'vehicle_record_unavailable';const messages:Record<string,string>={version_conflict:'记录已更新，请重新载入后修改',evidence_expired:'证据已过保留期，无法重试',evidence_missing:'缺少原始证据，无法重试',vehicle_disabled:'请先恢复原通道的车牌配置和模型',vehicle_busy:'识别队列已满，请稍后重试',invalid_correction:'车牌格式不支持，请输入普通、新能源或挂/学/警/港/澳后缀车牌'};throw new AlarmConfigError(code,messages[code]??(r.status===404?'记录或证据已过期':'车辆记录暂不可用'),[404,409,422,429].includes(r.status)?r.status:503);} return {bytes:await limitedBytes(r,path.includes('/images/')?8*1024*1024:1024*1024),type:r.headers.get('content-type')??'application/json'};
 }
 start(){void this.sync();this.timer=setInterval(()=>{void this.sync();},10000);this.timer.unref();}
 async close(){this.stopped=true;clearInterval(this.timer);await this.pending;}
}
