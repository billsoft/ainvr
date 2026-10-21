import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {endpoint,limitedJson,type AlarmConnection} from './alarmProxy.js';
interface Options {
 connection:()=>Promise<AlarmConnection|null>;
 aiConnection:()=>Promise<{baseUrl:string;apiKey:string}>;
 principal:(request:FastifyRequest)=>Promise<string|null>;
 internalPrincipal?:(request:FastifyRequest)=>Promise<boolean>;
}
const text=z.string().min(1).max(512),integer=z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const factSchema=z.object({event_id:z.string(),channel_id:text,stream_session_id:text,track_id:text,label_id:text,
 source_pts_ns:integer,source_frame_index:integer.nullish(),analysis_evidence:z.object({source:z.object({width:z.number().int().positive(),height:z.number().int().positive()})})});
const availableSchema=z.object({state:z.literal('available'),evidence:z.object({kind:z.literal('target_crop'),image_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),channel_id:text,track_id:text,
 stream_session_id:text,source_pts_ns:integer,source_frame_index:integer,frame_width:z.number().int().positive(),frame_height:z.number().int().positive(),
 image_width:z.number().int().positive(),image_height:z.number().int().positive(),label_id:z.string(),variants:z.array(z.enum(['original','processed'])).min(1).max(2),pinned:z.boolean().optional(),retention:z.enum(['alarm','ai_history']).optional(),saved_at:z.string().optional(),expires_at:z.string().optional()})});
const unavailableSchema=z.object({state:z.literal('unavailable'),reason:z.enum(['not_saved_or_expired','ambiguous_frame','archive_unavailable','invalid_archive_record'])});
export async function alarmEvidenceRoutes(app:FastifyInstance,options:Options){
 const handle=(image:boolean,internal=false)=>async(req:FastifyRequest,reply:FastifyReply)=>{
  if(internal?!await options.internalPrincipal?.(req):!await options.principal(req))return reply.code(internal?403:401).send({error:{code:'unauthorized',message:'没有证据读取权限'}});
  const id=(req.params as {id:string}).id,query=req.query as Record<string,unknown>;
  if(!/^[a-f0-9]{64}$/.test(id)||Object.keys(query).some(k=>!image||k!=='variant')||query.variant!==undefined&&(typeof query.variant!=='string'||!['processed','original'].includes(query.variant)))return reply.code(422).send({error:{code:'invalid_evidence_query',message:'证据参数无效'}});
  const variant=query.variant??'processed';
  try{
   const connection=await options.connection();if(!connection)return reply.code(503).send({error:{code:'alarm_unavailable',message:'告警服务尚未就绪'}});
   const response=await fetch(endpoint(connection,`/v1/behavior-events/${id}`),{headers:{authorization:`Bearer ${connection.apiToken}`},redirect:'error',signal:AbortSignal.timeout(connection.timeoutMs)});
   if(response.status===404)return reply.code(404).send({error:{code:'not_found',message:'行为记录不存在或已过保留期'}});
   if(!response.ok)throw Error('Alarm evidence identity unavailable');
   const fact=factSchema.parse(await limitedJson(response));if(fact.event_id!==id)throw Error('Behavior identity mismatch');
   if(!fact.source_frame_index){if(image)return reply.code(404).send({error:{code:'frame_identity_unavailable',message:'此记录没有完整原帧身份'}});return reply.send({schema_version:'1.0',state:'unavailable',reason:'frame_identity_unavailable'});}
   if(['.','..'].includes(fact.channel_id))throw Error('Invalid channel identity');
   if(!internal){
    const saved=await fetch(endpoint(connection,`/v1/behavior-events/${id}/evidence`),{headers:{authorization:`Bearer ${connection.apiToken}`},redirect:'error',signal:AbortSignal.timeout(connection.timeoutMs)});
    if(saved.ok){
     const raw=await limitedJson(saved),stateName=z.object({state:z.string()}).parse(raw).state;
     if(stateName==='available'){
      const retained=availableSchema.parse(raw).evidence;assertMatches(retained,fact);
      if(retained.pinned!==true||retained.retention!=='alarm'||!retained.saved_at||!retained.expires_at||!Number.isFinite(Date.parse(retained.saved_at))||!Number.isFinite(Date.parse(retained.expires_at)))throw Error('Invalid retained evidence');
      reply.header('Cache-Control','private, no-store');
      if(!image)return reply.send({schema_version:'1.0',state:'available',evidence:retained});
      if(!retained.variants.includes(variant as 'original'|'processed'))return reply.code(404).send({error:{code:'variant_unavailable',message:'未保留所选截图版本'}});
      const target=endpoint(connection,`/v1/behavior-events/${id}/evidence/image`);target.searchParams.set('variant',String(variant));
      const jpeg=await fetch(target,{headers:{authorization:`Bearer ${connection.apiToken}`},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(jpeg.status===404)return reply.code(404).send({error:{code:'evidence_expired',message:'独立保存的截图已不可用'}});
      return reply.type('image/jpeg').send(await jpegData(jpeg));
     }
     if(['pending','unavailable'].includes(stateName)){
      const state=z.object({state:z.enum(['pending','unavailable']),reason:z.enum(['capture_retry','capture_disabled','capture_timeout','retention','capacity','queue_capacity','frame_identity_unavailable','stored_file_missing'])}).parse(raw);
      if(image)return reply.code(404).send({error:{code:'evidence_unavailable',message:'证据尚未保存或已清理'}});
      return reply.header('Cache-Control','private, no-store').send({schema_version:'1.0',...state});
     }
     if(!['not_configured','not_queued'].includes(stateName))throw Error('Unknown evidence retention state');
    }else if(saved.status!==404)throw Error('Evidence retention service unavailable');
   }
   const ai=await options.aiConnection(),base=new URL(ai.baseUrl);
   if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.hash||base.search||base.pathname!=='/')throw Error('Invalid AI connection');
   const headers=ai.apiKey?{'x-api-key':ai.apiKey}:{};
   const source=new URL(`/api/v1/channels/${encodeURIComponent(fact.channel_id)}/observation-evidence`,base);
   for(const [key,value]of Object.entries({stream_session_id:fact.stream_session_id,source_pts_ns:fact.source_pts_ns,source_frame_index:fact.source_frame_index,track_id:fact.track_id}))source.searchParams.set(key,value);
   const metadata=await fetch(source,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!metadata.ok)throw Error('AI evidence interface unavailable');
   const raw=await limitedJson(metadata),missing=unavailableSchema.safeParse(raw);
   if(missing.success){
    if(image)return reply.code(404).send({error:{code:'evidence_unavailable',message:'原帧截图未保存、已清理或无法确认'}});
    return reply.send({schema_version:'1.0',...missing.data});
   }
   const evidence=availableSchema.parse(raw).evidence;
   assertMatches(evidence,fact);
   reply.header('Cache-Control','private, no-store');
   if(!image)return reply.send({schema_version:'1.0',state:'available',evidence:{...evidence,pinned:false,retention:'ai_history'}});
   if(!evidence.variants.includes(variant as 'original'|'processed'))return reply.code(404).send({error:{code:'variant_unavailable',message:'此截图未保留所选版本'}});
   const target=new URL(`/api/v1/channels/${encodeURIComponent(fact.channel_id)}/snapshots/${encodeURIComponent(evidence.image_id)}/image`,base);target.searchParams.set('variant',String(variant));
   const jpeg=await fetch(target,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
   if(jpeg.status===404)return reply.code(404).send({error:{code:'evidence_expired',message:'原帧截图已不可用'}});
   return reply.type('image/jpeg').send(await jpegData(jpeg));
  }catch{return reply.code(503).send({error:{code:'evidence_unavailable',message:'原帧证据暂不可用，请稍后重试'}});}
 };
 app.get('/alarms/behavior-events/:id/evidence',handle(false));
 app.get('/alarms/behavior-events/:id/evidence/image',handle(true));
 app.get('/internal/alarm-evidence/:id',handle(false,true));
 app.get('/internal/alarm-evidence/:id/image',handle(true,true));
}

function assertMatches(evidence:z.infer<typeof availableSchema>['evidence'],fact:z.infer<typeof factSchema>){
 if(evidence.channel_id!==fact.channel_id||evidence.track_id!==fact.track_id||evidence.stream_session_id!==fact.stream_session_id||evidence.source_pts_ns!==fact.source_pts_ns||evidence.source_frame_index!==fact.source_frame_index||evidence.frame_width!==fact.analysis_evidence.source.width||evidence.frame_height!==fact.analysis_evidence.source.height||evidence.label_id&&evidence.label_id!==fact.label_id)throw Error('Evidence does not match original observation');
}
async function jpegData(response:Response){
 if(!response.ok||!response.body||!response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg'))throw Error('Invalid evidence image');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>8*1024*1024)throw Error('Evidence too large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 const data=Buffer.concat(chunks);if(data.length<4||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)throw Error('Invalid JPEG evidence');return data;
}
