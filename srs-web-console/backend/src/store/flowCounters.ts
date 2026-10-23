import {z} from 'zod';
import {AlarmConfigError} from './alarmZones.js';
import type {AssignmentSource,AssignmentZone} from './alarmTriggerDefinition.js';

/**
 * Counters are a library like triggers: a definition says what is counted and
 * how; a binding (stored in the source's arming) says where the counting line
 * lies on one zone. One binding compiles to one statistics-only rule whose id is
 * the binding id. "In"/"out" are classified when querying, by stable edge ids.
 */
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const outputName=z.string().trim().min(1).max(32);
const definitionSchema=z.object({
  counter_id:id,name:z.string().trim().min(1).max(128),
  labels:z.array(z.object({label_id:id,name:z.string().trim().min(1).max(256)}).strict()).min(1).max(128),
  method:z.enum(['line','gates','zone']),
  outputs:z.enum(['both','in']),
  names:z.object({in:outputName,out:outputName}).strict(),
  occupancy:z.boolean(),
  max_gap_ms:z.number().int().min(0).max(2000),
  state:z.enum(['enabled','paused']),
}).strict();
export type CounterDefinition=z.infer<typeof definitionSchema>;
const angle=z.object({from:z.number().finite().min(0).max(360),to:z.number().finite().min(0).max(360)}).strict();
const directionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('line'),edge:id,in_side:z.enum(['inward','outward'])}).strict(),
  z.object({kind:z.literal('gates'),from:id,to:id}).strict(),
  z.object({kind:z.literal('edges'),entry:z.array(id).min(1).max(32),exit:z.array(id).min(1).max(32)}).strict(),
  z.object({kind:z.literal('angle'),entry:angle,exit:angle}).strict(),
]);
const bindingSchema=z.object({
  binding_id:id.refine(v=>v.startsWith('flow-'),'binding ids start with flow-'),counter_id:id,
  input_stream_id:id,processor_id:id,zone_id:id,zone_version:z.number().int().positive(),
  geometry_revision:id,label_map_version:id,direction:directionSchema,
  // One-off instruction for this save: recount earlier passages with the new line. Never stored.
  reclassify_history:z.literal(true).optional(),
}).strict();
export type CounterBinding=Omit<z.infer<typeof bindingSchema>,'reclassify_history'>;
export type CounterBindingInput=z.infer<typeof bindingSchema>;
export type BindingDirection=CounterBinding['direction'];
const fail=(code:string,message:string,status=422):never=>{throw new AlarmConfigError(code,message,status);};
const methodOf:Record<BindingDirection['kind'],CounterDefinition['method']>={line:'line',gates:'gates',edges:'zone',angle:'zone'};

export function parseCounterDefinition(input:unknown):CounterDefinition{
  const parsed=definitionSchema.safeParse(input);
  if(!parsed.success)return fail('invalid_counter','计数器参数无效');
  const d=parsed.data;
  if(new Set(d.labels.map(l=>l.label_id)).size!==d.labels.length)return fail('invalid_counter','目标不能重复');
  if(d.outputs==='both'&&d.names.in===d.names.out)return fail('invalid_counter','两个方向的名称不能相同');
  if(d.occupancy&&d.outputs!=='both')return fail('invalid_counter','在场人数需要同时统计两个方向');
  return d;
}
export function parseCounterBinding(input:unknown):CounterBindingInput{
  const parsed=bindingSchema.safeParse(input);
  if(!parsed.success)return fail('invalid_binding','计数选用无效');
  const b=parsed.data,d=b.direction;
  if(d.kind==='gates'&&d.from===d.to)return fail('invalid_binding','双线计数需要两条不同的边');
  if(d.kind==='edges'&&(new Set([...d.entry,...d.exit]).size!==d.entry.length+d.exit.length))return fail('invalid_binding','进入边和离开边不能重复');
  if(d.kind==='angle'&&(d.entry.from%360===d.entry.to%360||d.exit.from%360===d.exit.to%360))return fail('invalid_binding','角度范围不能是整圈');
  return b;
}
export function validateBindingSet(inputs:unknown[]):CounterBindingInput[]{
  const bindings=inputs.map(parseCounterBinding),ids=new Set<string>(),keys=new Set<string>();
  for(const b of bindings){
    const key=JSON.stringify([b.counter_id,b.zone_id,b.processor_id]);
    if(ids.has(b.binding_id)||keys.has(key))return fail('duplicate_binding','同一热区不能重复选用同一计数器');
    ids.add(b.binding_id);keys.add(key);
  }
  return bindings;
}
/** Edge ids the binding needs on its zone; a missing id means the line must be confirmed again. */
export function bindingEdges(d:BindingDirection):string[]{
  return d.kind==='line'?[d.edge]:d.kind==='gates'?[d.from,d.to]:d.kind==='edges'?[...d.entry,...d.exit]:[];
}
export function compileBinding(definition:CounterDefinition,definitionVersion:number,input:unknown,source:AssignmentSource,zone:AssignmentZone|null,executionVersion:number){
  const d=parseCounterDefinition(definition),b=parseCounterBinding(input);
  if(!Number.isSafeInteger(definitionVersion)||definitionVersion<1||!Number.isSafeInteger(executionVersion)||executionVersion<1)return fail('invalid_version','规则版本无效');
  if(b.counter_id!==d.counter_id)return fail('counter_changed','计数选用与计数器不匹配');
  if(methodOf[b.direction.kind]!==d.method)return fail('invalid_binding','计数线与计数方式不一致，请重新设置');
  if(d.state!=='enabled')return null;
  if(source.channel_id!==b.processor_id||source.input_stream_id!==b.input_stream_id||
    source.geometry_revision!==b.geometry_revision||source.label_map_version!==b.label_map_version)return fail('source_changed','来源或模型目录已变化');
  if(!source.stream_fingerprint||!/^[a-f0-9]{64}$/.test(source.stream_fingerprint)||!source.observed_at||!Number.isFinite(Date.parse(source.observed_at)))return fail('source_unavailable','来源证据尚未确认');
  if(!source.tracking_available)return fail('tracking_required','请启用目标跟踪');
  if(!Number.isSafeInteger(source.width)||source.width<=0||!Number.isSafeInteger(source.height)||source.height<=0)return fail('source_unavailable','原图尺寸尚未确认');
  if(d.labels.some(l=>!source.labels.some(s=>s.label_id===l.label_id)))return fail('labels_unavailable','模型不支持所选目标');
  if(!zone||zone.zone_id!==b.zone_id||zone.channel_id!==b.input_stream_id||zone.state!=='active'||
    zone.version!==b.zone_version||zone.geometry_revision!==b.geometry_revision)return fail('zone_changed','热区已变化，请重新确认计数线');
  if(zone.erp_wrap)return fail('invalid_binding','全景环绕区域暂不支持计数');
  // Compilation can also be called outside the arming editor's geometry validation.
  for(let i=0;i<zone.points.length;i++){
    const a=zone.points[i]!,b=zone.points[(i+1)%zone.points.length]!;
    if(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-8)
      return fail('invalid_geometry','相邻顶点不能重合，请调整热区形状。');
  }
  if(bindingEdges(b.direction).some(e=>!zone.edge_ids.includes(e)))return fail('direction_changed','热区的边已变化，请重新确认计数线');
  const index=(e:string)=>zone.edge_ids.indexOf(e);
  const passage=b.direction.kind==='line'?{kind:'line',edges:[index(b.direction.edge)],max_gap_ms:d.max_gap_ms}:
    b.direction.kind==='gates'?{kind:'gates',edges:[index(b.direction.from),index(b.direction.to)],max_gap_ms:d.max_gap_ms}:
    {kind:'zone',max_gap_ms:d.max_gap_ms};
  const tolerance=Math.max(0.5,Math.min(6,Math.min(source.width,source.height)*0.005));
  if(d.method==='zone'){
    const pixels=zone.points.map(p=>[p[0]*source.width,p[1]*source.height]);
    // A rotated narrow region can have a large axis-aligned bounding box.
    // Check enclosing strips along every edge normal in source pixels instead.
    // This is a necessary clearance check, not proof of a traversable concave interior.
    const spans=pixels.map((a,i)=>{
      const b=pixels[(i+1)%pixels.length]!,dx=b[0]!-a[0]!,dy=b[1]!-a[1]!,length=Math.hypot(dx,dy);
      if(length<=1e-9)return 0;
      const projection=pixels.map(p=>(-dy*(p[0]!-a[0]!)+dx*(p[1]!-a[1]!))/length);
      return Math.max(...projection)-Math.min(...projection);
    });
    if(Math.min(...spans)<=2*tolerance+1e-7)
      return fail('zone_too_narrow','区域太窄，没有稳定的内部空间。请扩大区域，或改用单线／双线计数。');
  }
  return {
    hysteresis_px:tolerance,
    id:b.binding_id,assignment_id:b.binding_id,counter_id:d.counter_id,trigger_version:definitionVersion,
    version:executionVersion,name:d.name,state:'enabled',
    channel_id:b.processor_id,input_stream_id:b.input_stream_id,
    label_ids:d.labels.map(l=>l.label_id),label_map_version:b.label_map_version,geometry_revision:b.geometry_revision,
    zone_id:b.zone_id,zone_version:b.zone_version,points:zone.points.map(p=>[...p]),edge_ids:[...zone.edge_ids],
    behavior:'region_traverse',anchor:'bottom_center',duration_ms:0,entry_edges:[],exit_edges:[],
    alarm_enabled:false,schedule:{mode:'always'},review:{enabled:false},passage,
    source_binding:{stream_fingerprint:source.stream_fingerprint,not_before:source.observed_at,width:source.width,height:source.height,
      input_stream_id:b.input_stream_id,label_map_version:b.label_map_version,geometry_revision:b.geometry_revision},
  };
}
type Filter={kind:'line';side:'inward'|'outward'}|{kind:'edges';entry:string[];exit:string[]}|{kind:'angle';entry:{from:number;to:number};exit:{from:number;to:number}};
/** The analysis-service filters for the "in" and "out" outputs of one binding. */
export function bindingFilters(direction:BindingDirection):{in:Filter;out:Filter}{
  const d=direction;
  if(d.kind==='line')return {in:{kind:'line',side:d.in_side},out:{kind:'line',side:d.in_side==='inward'?'outward':'inward'}};
  if(d.kind==='gates')return {in:{kind:'edges',entry:[d.from],exit:[d.to]},out:{kind:'edges',entry:[d.to],exit:[d.from]}};
  if(d.kind==='edges')return {in:{kind:'edges',entry:[...d.entry],exit:[...d.exit]},out:{kind:'edges',entry:[...d.exit],exit:[...d.entry]}};
  return {in:{kind:'angle',entry:{...d.entry},exit:{...d.exit}},out:{kind:'angle',entry:{...d.exit},exit:{...d.entry}}};
}
export interface BindingVersion {seq:number;direction:BindingDirection;reclassify:boolean;effective_from:Date|string}
export interface DefinitionVersion {labels:{label_id:string}[];created_at:Date|string}
export interface CountingPiece {direction:BindingDirection;label_ids:string[];from:string;to:string;start_grace:boolean}
/**
 * The periods of one binding inside a query window, each with the counting line
 * and targets that applied then. Earlier passages keep the meaning they had,
 * unless a later version explicitly recounted history. A piece that starts when
 * the binding or a new line took effect may lack its first seconds of coverage
 * (rule start-up); a piece clipped by the query window may not.
 */
export function countingPieces(binding:{created_at:Date|string;updated_at:Date|string;active:boolean},versions:BindingVersion[],definitions:DefinitionVersion[],window:{from:string;to:string}):CountingPiece[]{
  const t=(v:Date|string)=>new Date(v).getTime(),created=t(binding.created_at)
  let lines:{from:number;direction:BindingDirection}[]=[]
  for(const v of [...versions].sort((a,b)=>a.seq-b.seq)){
    if(v.reclassify)lines=[{from:created,direction:v.direction}]
    else lines.push({from:Math.max(created,t(v.effective_from)),direction:v.direction})
  }
  const labels=[...definitions].sort((a,b)=>t(a.created_at)-t(b.created_at))
  const lo=Math.max(t(window.from),created),hi=Math.min(t(window.to),binding.active?Infinity:t(binding.updated_at))
  if(hi<=lo)return []
  const cuts=new Set([lo,hi]);for(const l of lines)if(l.from>lo&&l.from<hi)cuts.add(l.from);for(const d of labels)if(t(d.created_at)>lo&&t(d.created_at)<hi)cuts.add(t(d.created_at))
  // Each change of line or targets restarts the rule, so its first seconds may be uncovered.
  const points=[...cuts].sort((a,b)=>a-b),starts=new Set([created,...lines.map(l=>l.from),...labels.map(d=>t(d.created_at))])
  const out:CountingPiece[]=[]
  for(let i=0;i+1<points.length;i++){
    const from=points[i]!,to=points[i+1]!
    const line=[...lines].reverse().find(l=>l.from<=from)??lines[0],def=[...labels].reverse().find(d=>t(d.created_at)<=from)??labels[0]
    if(!line||!def||to<=from)continue
    out.push({direction:line.direction,label_ids:def.labels.map(l=>l.label_id),from:new Date(from).toISOString(),to:new Date(to).toISOString(),start_grace:starts.has(from)})
  }
  return out
}
