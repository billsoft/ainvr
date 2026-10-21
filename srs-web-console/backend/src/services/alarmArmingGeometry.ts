import {z} from 'zod';
import type {SrsStream} from './srsClient.js';
import type {AppSettings,Channel} from '../types/channel.js';
import type {PgConfigStore} from '../store/pgStore.js';
import {readAlarmSourceCatalog} from './alarmSourceCatalog.js';
import {resolveAiApiKey} from '../routes/aiProxy.js';
import {limitedJson} from '../routes/alarmProxy.js';
const channels=z.object({channels:z.array(z.object({id:z.string(),config:z.object({stream:z.object({url:z.string()})})}).passthrough()).max(128)});
/** Even a zone-only draft needs a server-observed source geometry. Client video
 * dimensions are never accepted as authority. Multiple processors must agree. */
export async function readArmingGeometry(sourceId:string,settings:AppSettings,inputs:Channel[],fallback:string,pg:PgConfigStore|null,streams?:()=>Promise<SrsStream[]>):Promise<string|null>{
 const input=inputs.find(c=>c.id===sourceId);
 if(!input)return null;
 if(streams){
  try{
   const matches=(await streams()).filter(s=>s.app===(input.app||'live')&&s.name===input.streamName&&s.publish?.active===true);
   if(matches.length!==1)return null;
   const width=matches[0].video?.width,height=matches[0].video?.height;
   if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width!<1||height!<1||width!>32768||height!>32768)return null;
   const generation=input.inputGeneration||(Number.isFinite(input.createdAt)?new Date(input.createdAt).toISOString():null);
   return generation?`source-frame-v2:${input.id}:${generation}:${width}x${height}`:null;
  }catch{return null;}
 }

 try{
  const base=new URL(settings.aiService.baseUrl||fallback);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)return null;
  const key=await resolveAiApiKey(settings,pg);
  const response=await fetch(new URL('/api/v1/channels',base),{headers:key?{'x-api-key':key}:{},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)return null;
  const list=channels.parse(await limitedJson(response)).channels.filter(c=>{
   try{
    const url=new URL(c.config.stream.url);
    return url.protocol==='rtmp:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&
      url.pathname===`/${input.app||'live'}/${input.streamName}`;
   }catch{return false;}
  });
  const revisions=new Set<string>();
  for(let i=0;i<list.length;i+=4){
   const catalogs=await Promise.all(list.slice(i,i+4).map(c=>readAlarmSourceCatalog(c.id,settings,inputs,fallback,pg)));
   for(const catalog of catalogs)if(catalog?.input_stream_id===sourceId)revisions.add(catalog.geometry_revision);
  }
  return revisions.size===1?[...revisions][0]:null;
 }catch{return null;}
}
