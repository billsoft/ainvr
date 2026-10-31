import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AlarmArmingStore} from '../store/alarmArmingStore.js';
import type {AssignmentSource} from '../store/alarmTriggerDefinition.js';
import {bindingApplicability,applicableCoverage,bindingFilters,countingPieces,type BindingVersion,type CounterDefinition,type DefinitionVersion} from '../store/flowCounters.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import {AlarmRuleSync} from '../services/alarmRuleSync.js';
import {endpoint,limitedJson,type AlarmConnection} from './alarmProxy.js';
interface Options{
 store:AlarmArmingStore|null;principal:(r:FastifyRequest)=>Promise<string|null>;
 catalog:(id:string)=>Promise<AssignmentSource|null>;synchronization:AlarmRuleSync|null;
 connection:()=>Promise<AlarmConnection|null>;
}
type Output='in'|'out';
interface SeriesResult{diagnostic?:{reason:string;at:string}|null;key:string;occurrences:number;tracked_targets:number;coverage:{state:'complete'|'partial'|'no_data'|'unknown';gaps:{from:string;to:string}[];expected_ms?:number|null;covered_ms?:number|null;qualifier?:string;unknown_ms?:number;ratio?:number|null;tolerated_ms?:number;intervals?:{from:string;to:string}[];expected_intervals?:{from:string;to:string}[]};buckets:{from:string;to:string;occurrences:number}[]}
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bad=(message:string):never=>{throw new AlarmConfigError('invalid_query',message);};
const outputsOf=(d:CounterDefinition):Output[]=>d.outputs==='both'?['in','out']:['in'];
function range(body:Record<string,unknown>){
 const from=Date.parse(String(body.from)),to=Date.parse(String(body.to));
 if(typeof body.from!=='string'||typeof body.to!=='string'||!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>31*86400000)bad('请选择不超过31天的有效时间范围');
 return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};
}
const LIVE_GRACE_MS=30000;
/** Sum series (history pieces of one zone, or zones of one counter); the same bucket start means the same period. */
function sum(parts:SeriesResult[]){
 const buckets=new Map<string,{from:string;to:string;occurrences:number}>();
 for(const p of parts)for(const b of p.buckets){const old=buckets.get(b.from);if(old)old.occurrences+=b.occurrences;else buckets.set(b.from,{...b});}
 const states=parts.map(p=>p.coverage.state);
 const measured=parts.length>0&&parts.every(p=>typeof p.coverage.expected_ms==='number'&&typeof p.coverage.covered_ms==='number');
 const incomplete=parts.some(p=>p.coverage.expected_ms===null||p.coverage.covered_ms===null);
 const expected_ms=measured?parts.reduce((n,p)=>n+p.coverage.expected_ms!,0):undefined;
 const covered_ms=measured?parts.reduce((n,p)=>n+p.coverage.covered_ms!,0):undefined;
 const measurement:Omit<Partial<SeriesResult['coverage']>,'state'|'gaps'>=measured?{expected_ms,covered_ms,ratio:expected_ms?covered_ms!/expected_ms:null,
  tolerated_ms:parts.reduce((n,p)=>n+(p.coverage.tolerated_ms??0),0),
  intervals:parts.flatMap(p=>p.coverage.intervals??[]),expected_intervals:parts.flatMap(p=>p.coverage.expected_intervals??[]),
  ...(parts.some(p=>p.coverage.qualifier)?{qualifier:'persisted_configuration',unknown_ms:0}:{})}:
  incomplete?{expected_ms:null,covered_ms:null,ratio:null,unknown_ms:parts.reduce((n,p)=>n+(p.coverage.unknown_ms??0),0),
   qualifier:parts.find(p=>p.coverage.expected_ms===null||p.coverage.covered_ms===null)?.coverage.qualifier??'measurement_incomplete'}:{};

 return {...measurement,diagnostic:parts.map(p=>p.diagnostic).filter(Boolean).sort((a,b)=>b!.at.localeCompare(a!.at))[0]??null,occurrences:parts.reduce((n,p)=>n+p.occurrences,0),tracked_targets:parts.reduce((n,p)=>n+p.tracked_targets,0),gaps:parts.flatMap(p=>p.coverage.gaps??[]),buckets:[...buckets.values()].sort((a,b)=>a.from.localeCompare(b.from)),
  coverage:!parts.length||states.every(s=>s==='no_data')?'no_data':states.every(s=>s==='complete')?'complete':states.includes('partial')?'partial':states.includes('unknown')?'unknown':'partial'};
}
export async function flowRoutes(app:FastifyInstance,options:Options){
 const actors=new WeakMap<FastifyRequest,string>();
 app.addHook('preHandler',async(req,reply)=>{
  const actor=await options.principal(req);if(!actor)return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
  actors.set(req,actor);
  if(!options.store)return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数库暂不可用'}});
 });
 app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof AlarmConfigError?e.statusCode:503).send({error:{code:e instanceof AlarmConfigError?e.code:'flow_unavailable',message:e instanceof AlarmConfigError?e.message:'流量服务暂不可用，请稍后重试'}}));
 const store=()=>options.store!;
 async function analyse(series:unknown[],extra:Record<string,unknown>):Promise<SeriesResult[]>{
  if(!series.length)return [];
  const config=await options.connection();if(!config)throw new AlarmConfigError('flow_unavailable','分析服务尚未配置',503);
  const out:SeriesResult[]=[];
  for(let i=0;i<series.length;i+=100){
   const response=await fetch(endpoint(config,'/v1/flow/query'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),
    headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json'},body:JSON.stringify({series:series.slice(i,i+100),...extra})});
   const body=await limitedJson(response) as {items?:SeriesResult[];error?:{code?:string;message?:string}};
   if(!response.ok){if(response.status===422)throw new AlarmConfigError(body.error?.code??'invalid_query',body.error?.message??'查询条件无效');throw new AlarmConfigError('flow_unavailable','分析服务查询失败，未取得统计结果',502);}
   out.push(...(body.items??[]));
  }
  return out;
 }
 async function readCounters(ids?:string[]){
  const all=await store().listCounters() as (CounterDefinition&{version:number})[];
  const live=all.filter(c=>!(c as {deleting?:boolean}).deleting);
  const chosen=ids?ids.map(id=>live.find(c=>c.counter_id===id)??bad('计数器不存在')):live;
  const chosenIds=chosen.map(c=>c.counter_id),rows=await store().counterBindings(chosenIds),history=await store().definitionHistory(chosenIds);
  return chosen.map(counter=>({counter,bindings:rows.filter(r=>r.counter_id===counter.counter_id),definitions:history.filter(h=>h.counter_id===counter.counter_id)}));
 }
 type Row={binding_id:string;active:boolean;created_at:Date;updated_at:Date;versions:BindingVersion[];document:{direction:Parameters<typeof bindingFilters>[0]}}
 /** History pieces of one zone inside the window: the line and targets that applied then. */
 const pieces=(row:Row,definitions:DefinitionVersion[],counter:CounterDefinition,window:{from:string;to:string})=>countingPieces(row,
  row.versions.length?row.versions:[{seq:1,direction:row.document.direction,reclassify:false,effective_from:row.created_at}],
  definitions.length?definitions:[{labels:counter.labels,created_at:row.created_at}],window)
 /** A zone counts only while it is selected; each piece is counted with its own conditions. */
 const seriesOf=(counter:CounterDefinition,row:Row,definitions:DefinitionVersion[],output:Output,window:{from:string;to:string})=>{
  const live=Date.now()-LIVE_GRACE_MS/3
  return pieces(row,definitions,counter,window).map((p,i)=>({key:`${row.binding_id}:${output}:${i}`,rule_id:row.binding_id,label_ids:p.label_ids,filter:bindingFilters(p.direction)[output],from:p.from,to:p.to,
   ...(p.start_grace||Date.parse(p.to)>=live?{grace:{...(p.start_grace?{start_ms:LIVE_GRACE_MS}:{}),...(Date.parse(p.to)>=live?{end_ms:LIVE_GRACE_MS}:{})}}:{})}))
 }
 const zoneTotals=(results:SeriesResult[],binding:string,output:Output)=>{const parts=results.filter(r=>r.key.startsWith(`${binding}:${output}:`));if(!parts.length)return undefined;const total=sum(parts);return {...total,coverage:{state:total.coverage,gaps:total.gaps,...('expected_ms' in total?{expected_ms:total.expected_ms,covered_ms:total.covered_ms,ratio:total.ratio,tolerated_ms:total.tolerated_ms,intervals:total.intervals,expected_intervals:total.expected_intervals,qualifier:total.qualifier,unknown_ms:total.unknown_ms}:{})}}}
 app.get('/flow/counters',async req=>{
  const q=req.query as Record<string,unknown>;
  if(q.include_inactive!==undefined&&q.include_inactive!=='0'&&q.include_inactive!=='1')bad('历史选用参数无效');
  return {items:await store().listCounters(q.include_inactive==='1')};
 });
 app.post('/flow/counters',async req=>{
  const b=req.body,key=req.headers['idempotency-key'];
  if(!object(b)||Object.keys(b).some(k=>!['counter','expected_version'].includes(k))||!object(b.counter)||!Number.isSafeInteger(b.expected_version)||!validId(key))
   throw new AlarmConfigError('invalid_request','保存参数或操作编号无效');
  const result=await store().saveCounter(b.counter,b.expected_version as number,actors.get(req)!,key,options.catalog);
  if(!options.synchronization)return result;
  try{return {...result,application:await options.synchronization.synchronize()};}catch{return result;}
 });
 app.post('/flow/counters/:id/delete',async req=>{
  const id=(req.params as {id?:unknown}).id,b=req.body,key=req.headers['idempotency-key'];
  if(!validId(id)||!object(b)||Object.keys(b).some(k=>k!=='expected_version')||!Number.isSafeInteger(b.expected_version)||!validId(key))
   throw new AlarmConfigError('invalid_request','删除参数或操作编号无效');
  const {binding_ids}=await store().beginDeleteCounter(id,b.expected_version as number,actors.get(req)!,key);
  // Counting stops first, so no new passage is written while the records are removed.
  // Start after the deletion transaction; do not reuse a sync begun before it.
  const stopped=await new AlarmRuleSync(store(),options.connection).synchronize();
  if(stopped.state!=='applied')throw new AlarmConfigError('flow_unavailable','停止计数尚未确认，删除未完成，请稍后重试',503);
  if(binding_ids.length){
   const config=await options.connection();
   if(!config)throw new AlarmConfigError('flow_unavailable','计数器已停止计数，历史记录暂未清除，请稍后重试删除',503);
   for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(endpoint(config,'/v1/flow/purge'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),
     headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json'},body:JSON.stringify({counter_id:id,rule_ids:binding_ids})});
    if(response.ok)break;
    const body=await response.json().catch(()=>null) as {error?:{code?:string}}|null;
    if(response.status===503&&body?.error?.code==='consumer_busy'&&attempt<2){
     await new Promise(resolve=>setTimeout(resolve,150*(attempt+1)));continue;
    }
    throw new AlarmConfigError('flow_unavailable','计数器已停止计数，历史记录暂未清除，请稍后重试删除',503);
   }
  }
  await store().finishDeleteCounter(id);
  return {deleted:true};
 });
 app.post('/flow/counters/:id/clear',async req=>{
  const id=(req.params as {id?:unknown}).id,b=req.body,key=req.headers['idempotency-key'];
  if(!validId(id)||!validId(key)||!object(b)||Object.keys(b).some(k=>!['binding_ids','from','to'].includes(k))||!Array.isArray(b.binding_ids)||!b.binding_ids.length||b.binding_ids.length>1000||!b.binding_ids.every(validId)||new Set(b.binding_ids).size!==b.binding_ids.length)bad('清理范围或操作编号无效');
  const window=range(b as Record<string,unknown>);
  if(Date.parse(window.to)>Date.now()+2000)bad('不能清理未来的统计数据');
  const {bindings}=(await readCounters([id as string]))[0];
  const ids=(b as Record<string,unknown>).binding_ids as string[];
  if(ids.some(id=>!bindings.some(row=>row.binding_id===id)))bad('热区关联不属于该计数器，请刷新后重试');
  const config=await options.connection();if(!config)throw new AlarmConfigError('flow_unavailable','分析服务尚未配置',503);
  const response=await fetch(endpoint(config,'/v1/flow/clear'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json','x-ainvr-actor':actors.get(req)!,'idempotency-key':key as string},body:JSON.stringify({counter_id:id,rule_ids:ids,...window})});
  const result=await limitedJson(response) as {cleared?:boolean;error?:{code?:string;message?:string}};
  if(!response.ok||result.cleared!==true)throw new AlarmConfigError(result.error?.code??'flow_unavailable',response.status===409?'清理范围已变化，请重新打开清理窗口':'清理尚未确认，请重试同一次操作',response.status===409?409:503);
  return result;
 });
 app.post('/flow/query',async req=>{
  const b=req.body;
  if(!object(b)||Object.keys(b).some(k=>!['counter_ids','from','to','bucket','timezone','totals_only'].includes(k)))bad('查询参数无效');
  const body=b as Record<string,unknown>,window=range(body);
  if(body.counter_ids!==undefined&&(!Array.isArray(body.counter_ids)||body.counter_ids.length>50||body.counter_ids.some(v=>!validId(v))||new Set(body.counter_ids).size!==body.counter_ids.length))bad('计数器选择无效');
  if(body.bucket!==undefined&&body.bucket!==null&&!['minute','hour','day'].includes(String(body.bucket)))bad('时间分段无效');
  const counters=await readCounters(body.counter_ids as string[]|undefined);
  const series=counters.flatMap(({counter,bindings,definitions})=>bindings.flatMap(row=>outputsOf(counter).flatMap(o=>seriesOf(counter,row,definitions,o,window))));
  if(body.totals_only!==undefined&&typeof body.totals_only!=='boolean')bad('查询参数无效');
  const [rawResults,arming]=await Promise.all([
   analyse(series,{bucket:body.bucket??null,timezone:body.timezone??'UTC',totals_only:body.totals_only===true}),
   body.totals_only===true||!series.length||typeof store().armingHistory!=='function'?Promise.resolve([]):
    store().armingHistory([...new Set(counters.flatMap(c=>c.bindings.map(b=>b.source_id)))],window),
  ]);
  const requests=new Map(series.map(s=>[s.key,s]));
  // Applicability only changes measured coverage metadata. Raw facts, classification,
  // buckets and legacy state/gaps keep the exact query and response semantics.
  const results=body.totals_only===true?rawResults:rawResults.map(result=>{
   const request=requests.get(result.key),owner=counters.find(c=>c.bindings.some(b=>b.binding_id===request?.rule_id));
   const row=owner?.bindings.find(b=>b.binding_id===request?.rule_id);
   if(!request||!owner||!row)return result;
   const proof=bindingApplicability(row.binding_id,owner.definitions,arming.filter(v=>v.source_id===row.source_id),request,owner.counter.version);
   return {...result,coverage:applicableCoverage(result.coverage,proof)};
  });
  return {from:window.from,to:window.to,items:counters.map(({counter,bindings,definitions})=>{
   // Zones removed before this period have nothing to show here.
   const zones=bindings.filter(row=>pieces(row,definitions,counter,window).length).map(row=>({binding_id:row.binding_id,source_id:row.source_id,processor_id:row.document.processor_id,zone_id:row.document.zone_id,zone_name:row.zone_name,
    active:row.active,counting:row.counting,direction:row.document.direction,
    ...Object.fromEntries(outputsOf(counter).map(o=>[o,zoneTotals(results,row.binding_id,o)]))}));
   return {counter,zones,...Object.fromEntries(outputsOf(counter).map(o=>{const t=sum(zones.map(z=>(z as unknown as Record<Output,SeriesResult>)[o]).filter(Boolean));return [o,{occurrences:t.occurrences,buckets:t.buckets,coverage:t.coverage,...('expected_ms' in t?{coverage_details:{state:t.coverage,expected_ms:t.expected_ms,covered_ms:t.covered_ms,ratio:t.ratio,tolerated_ms:t.tolerated_ms,qualifier:t.qualifier,unknown_ms:t.unknown_ms,basis:'binding_time'}}:{})}]}))};
  })};
 });
 app.post('/flow/records',async req=>{
  const b=req.body;
  if(!object(b)||Object.keys(b).some(k=>!['counter_id','binding_id','output','from','to','cursor','limit'].includes(k))||!validId(b.counter_id)||!validId(b.binding_id)||!['in','out'].includes(String(b.output))||
   b.cursor!==undefined&&(typeof b.cursor!=='string'||b.cursor.length>4096)||b.limit!==undefined&&(!Number.isInteger(b.limit)||(b.limit as number)<1||(b.limit as number)>100))bad('记录查询参数无效');
  const body=b as Record<string,unknown>,window=range(body);
  const [{counter,bindings,definitions}]=await readCounters([body.counter_id as string]);
  const row=bindings.find(r=>r.binding_id===body.binding_id)??bad('计数选用不存在');
  if(!outputsOf(counter).includes(body.output as Output))bad('此计数器只统计一个方向');
  const config=await options.connection();if(!config)throw new AlarmConfigError('flow_unavailable','分析服务尚未配置',503);
  const response=await fetch(endpoint(config,'/v1/flow/query'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),
   headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json'},
   body:JSON.stringify({series:(()=>{const list=seriesOf(counter,row,definitions,body.output as Output,window).map(({grace:_,...s})=>s);return list.length?list:bad('这段时间此热区没有计数')})(),detail:true,...(body.cursor?{cursor:body.cursor}:{}),limit:body.limit??30})});
  const result=await limitedJson(response) as {items?:unknown[];next_cursor?:string|null;error?:{code?:string;message?:string}};
  if(!response.ok)throw new AlarmConfigError(response.status===422?result.error?.code??'invalid_query':'flow_unavailable',response.status===422?result.error?.message??'查询条件无效':'分析服务查询失败',response.status===422?422:502);
  return {items:result.items??[],next_cursor:result.next_cursor??null};
 });
 app.get('/flow/live',async req=>{
  const q=req.query as Record<string,unknown>;
  if(!validId(q.source_id)||typeof q.from!=='string')bad('实时查询参数无效');
  const from=Date.parse(q.from as string),to=Date.now()+60000;
  if(!Number.isFinite(from)||to-from>2*86400000||to<=from)bad('实时查询时间无效');
  const counters=(await readCounters()).map(c=>({...c,bindings:c.bindings.filter(r=>r.active&&r.source_id===q.source_id)})).filter(c=>c.bindings.length);
  const window={from:new Date(from).toISOString(),to:new Date(to).toISOString()};
  const series=counters.flatMap(({counter,bindings,definitions})=>bindings.flatMap(row=>outputsOf(counter).flatMap(o=>seriesOf(counter,row,definitions,o,window))));
  const all=await analyse(series,{totals_only:true}),results=new Map(counters.flatMap(({bindings})=>bindings.flatMap(row=>(['in','out'] as Output[]).map(o=>[`${row.binding_id}:${o}`,zoneTotals(all,row.binding_id,o)?.occurrences??0]))));
  return {items:counters.flatMap(({counter,bindings})=>bindings.map(row=>({binding_id:row.binding_id,counter_id:counter.counter_id,name:counter.name,names:counter.names,
   outputs:counter.outputs,occupancy:counter.occupancy,counting:row.counting,zone_id:row.document.zone_id,direction:row.document.direction,diagnostic:zoneTotals(all,row.binding_id,'in')?.diagnostic??null,
   in:results.get(`${row.binding_id}:in`)??0,...(counter.outputs==='both'?{out:results.get(`${row.binding_id}:out`)??0}:{})})))};
 });
}
