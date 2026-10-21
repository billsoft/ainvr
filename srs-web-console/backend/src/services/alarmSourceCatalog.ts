import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Channel,AppSettings} from '../types/channel.js';
import type {TriggerSourceCatalog} from '../store/alarmTriggers.js';
import type {PgConfigStore} from '../store/pgStore.js';
import {resolveAiApiKey} from '../routes/aiProxy.js';
import {limitedJson} from '../routes/alarmProxy.js';
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const label=z.object({class_id:z.number().int().nonnegative(),label_id:id,name:z.string().max(4096),description:z.string().max(4096)});
const catalogSchema=z.object({schema_version:z.literal('1.0'),adapter:z.string(),labels:z.array(label).min(1).max(128)});
const modelSchema=z.object({name:z.string(),adapter:z.string(),class_names:z.array(z.string()).nullable().optional(),description:z.string().optional(),label_id:z.string().optional(),label_name:z.string().optional(),prompts:z.array(z.object({description:z.string(),label_id:z.string(),label_name:z.string()})).nullable().optional()}).passthrough();
const channelSchema=z.object({id,state:z.string(),config:z.object({model:modelSchema,stream:z.object({url:z.string()}),inference_fps:z.number().positive(),analytics:z.object({enabled:z.boolean()}).passthrough().optional()}).passthrough()}).passthrough();
const frameSchema=z.object({channel_id:id,stream_url:z.string(),timestamp:z.number().finite(),frame_width:z.number().int().positive().max(32768),frame_height:z.number().int().positive().max(32768),model:z.object({name:z.string()}),model_extra:z.object({label_catalog:catalogSchema,analytics:z.object({status:z.string(),stream_session_id:z.string()}).passthrough().optional()})}).passthrough();
export interface AlarmSourceCatalog extends TriggerSourceCatalog {channel_name:string;input_name:string;labels:z.infer<typeof label>[];width:number;height:number;observed_at:string;stream_fingerprint:string}
export function buildAlarmSourceCatalog(rawChannel:unknown,rawFrame:unknown,inputs:Channel[],now=Date.now()):AlarmSourceCatalog|null {
 const parsedChannel=channelSchema.safeParse(rawChannel),parsedFrame=frameSchema.safeParse(rawFrame);
 if(!parsedChannel.success||!parsedFrame.success)return null;
 const c=parsedChannel.data,f=parsedFrame.data,m=c.config.model,cat=f.model_extra.label_catalog;
 if(c.state!=='running'||c.id!==f.channel_id||f.stream_url!==c.config.stream.url||f.model.name!==m.name||cat.adapter!==m.adapter)return null;
 const age=now-f.timestamp*1000,maxAge=Math.min(600000,Math.max(60000,2000/c.config.inference_fps));
 if(age< -5000||age>maxAge)return null;
 let url:URL;try{url=new URL(c.config.stream.url)}catch{return null}
 if(url.protocol!=='rtmp:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||(url.port&&url.port!=='1935')||url.username||url.password||url.search||url.hash)return null;
 const matches=inputs.filter(ch=>url.pathname===`/${ch.app||'live'}/${ch.streamName}`);
 if(matches.length!==1)return null;const input=matches[0]!;
 if(!id.safeParse(input.id).success||!Number.isFinite(input.createdAt))return null;
 const labels=cat.labels;
 if(new Set(labels.map(l=>l.label_id)).size!==labels.length||labels.some((l,i)=>l.class_id!==i))return null;
 const prompted=['yoloe_bpu','locateanything_bpu'].includes(m.adapter);
 if(prompted){
  if(m.prompts?.length){
   if(m.prompts.length!==labels.length||m.prompts.some((p,i)=>{const l=labels[i]!;return l.label_id!==(p.label_id||`class:${i}`)||l.description!==p.description||l.name!==(m.adapter==='locateanything_bpu'&&!p.label_name?p.description:p.label_name)}))return null;
  }else{
   const descriptions=m.adapter==='locateanything_bpu'?[m.description||'']:(m.class_names?.length?m.class_names:[m.description||'']);
   if(descriptions.length!==labels.length||labels.some((l,i)=>l.description!==descriptions[i]||l.label_id!==(m.label_id?m.label_id+(m.adapter==='yoloe_bpu'&&labels.length>1?`:${i}`:''):`class:${i}`)))return null;
  }
 }else if(m.class_names&&JSON.stringify(m.class_names)!==JSON.stringify(labels.map(l=>l.name)))return null;
 const version='labels-'+createHash('sha256').update(JSON.stringify([cat.adapter,labels])).digest('hex');
 return {channel_id:c.id,channel_name:typeof c.name==='string'?c.name:c.id,input_stream_id:input.id,input_name:input.name,
  label_map_version:version,label_ids:labels.map(l=>l.label_id),labels,
  geometry_revision:`source-frame-v2:${input.id}:${input.inputGeneration||new Date(input.createdAt).toISOString()}:${f.frame_width}x${f.frame_height}`,
  tracking_available:c.config.analytics?.enabled===true&&f.model_extra.analytics?.status==='active',
  width:f.frame_width,height:f.frame_height,observed_at:new Date(f.timestamp*1000).toISOString(),stream_fingerprint:createHash('sha256').update(c.config.stream.url).digest('hex')};
}
export async function readAlarmSourceCatalog(channelId:string,settings:AppSettings,inputs:Channel[],fallbackBaseUrl:string,pgStore:PgConfigStore|null):Promise<AlarmSourceCatalog|null>{
 if(!id.safeParse(channelId).success)return null;
 try{
  const base=new URL(settings.aiService.baseUrl||fallbackBaseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)return null;
  const key=await resolveAiApiKey(settings,pgStore);
  const read=async(path:string)=>{const response=await fetch(new URL(path,base),{headers:key?{'x-api-key':key}:{},redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('AI unavailable');return limitedJson(response)};
  const path=`/api/v1/channels/${encodeURIComponent(channelId)}`;
  const before=await read(path);
  const latest=z.object({has_result:z.literal(true),result:z.unknown()}).parse(await read(`${path}/results/latest`));
  const after=await read(path);
  const a=channelSchema.parse(before),b=channelSchema.parse(after);
  if(JSON.stringify(a.config)!==JSON.stringify(b.config))return null;
  return buildAlarmSourceCatalog(after,latest.result,inputs);
 }catch{return null}
}
