import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {compileAssignment,parseTriggerDefinition,validateAssignmentSet,type TriggerDefinition,type TriggerAssignment,type AssignmentZone} from './alarmTriggerDefinition.js';
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const sourceSchema=z.object({
 stream_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),width:z.number().int().min(1).max(32768),height:z.number().int().min(1).max(32768),
 not_before:z.string().refine(s=>Number.isFinite(Date.parse(s))),input_stream_id:id,label_map_version:id,geometry_revision:id,
});
const bindingSchema=z.object({
 channel_id:id,input_stream_id:id,label_map_version:id,geometry_revision:id,zone_id:id.nullable(),zone_version:z.number().int().positive().nullable(),
 direction:z.object({entry_edges:z.array(z.number().int().nonnegative()),exit_edges:z.array(z.number().int().nonnegative())}),
 approach_px:z.number().finite().positive().optional(),source_binding:z.unknown(),zone_snapshot:z.unknown(),
});
const legacySchema=z.object({
 trigger_id:id,name:z.string(),behavior:z.string(),labels:z.array(z.unknown()),duration_ms:z.number(),
 alarm_enabled:z.boolean(),state:z.enum(['draft','enabled','paused','archived']),schedule:z.unknown().optional(),
 bindings:z.array(bindingSchema).min(1).max(64),
 migration_review:z.object({required:z.boolean(),reason:z.string().optional()}).optional(),
});
export interface LegacyZone extends AssignmentZone {name:string;edge_ids:string[]}
type Rule=ReturnType<typeof compileAssignment>;
export type LegacyConversion={status:'review';reason:string}|{
 status:'converted';definition:TriggerDefinition;zones:LegacyZone[];
 assignments:{document:TriggerAssignment;rule:Rule}[];
};
/** Pure and deterministic. Does not replace frozen geometry with today's geometry
 * or discard direction restrictions. A caller must pause any review result. */
export function convertLegacyTrigger(input:unknown,version:number,zoneRows:unknown[]):LegacyConversion{
 const parsed=legacySchema.safeParse(input);
 if(!parsed.success)return {status:'review',reason:'旧配置格式不能完整转换，请核对目标与选用。'};
 const old=parsed.data;
 if(old.migration_review?.required)return {status:'review',reason:old.migration_review.reason||'旧迁移尚待确认。'};
 try{
  const sources=old.bindings.map(b=>{
   const source=sourceSchema.safeParse(b.source_binding);
   if(!source.success||source.data.input_stream_id!==b.input_stream_id||source.data.geometry_revision!==b.geometry_revision||
     source.data.label_map_version!==b.label_map_version)throw Error('旧配置缺少可核验的来源尺寸或身份，请重新选用。');
   return source.data;
  });
  const base={trigger_id:old.trigger_id,name:old.name,behavior:old.behavior,labels:old.labels,
   duration_ms:old.duration_ms,alarm_enabled:old.alarm_enabled,state:old.state,schedule:old.schedule??{mode:'always'},
   ...(old.behavior==='region_approach'?{approach_width_percent:(old.bindings[0].approach_px??NaN)/sources[0].width*100}:{})};
  const definition=parseTriggerDefinition(base),zones:LegacyZone[]=[];
  const assignments=old.bindings.map((b,i)=>{
   const source=sources[i];let zone:LegacyZone|null=null;
   if(b.zone_id!==null){
    const raw=zoneRows.find((r:any)=>r?.zone_id===b.zone_id) as Record<string,any>|undefined;
    const frozen=b.zone_snapshot as Record<string,any>|null;
    if(!raw||raw.state!=='active'||raw.channel_id!==b.input_stream_id||raw.geometry_revision!==b.geometry_revision||
      raw.version!==b.zone_version||!frozen||frozen.zone_id!==b.zone_id||frozen.version!==b.zone_version||
      !isDeepStrictEqual(raw.points,frozen.points))throw Error('热区已变化或旧快照不完整，请重新确认方向与区域。');
    if(!Array.isArray(raw.points)||raw.points.length<3||raw.points.length>32)throw Error('旧热区形状不能转换。');
    zone={zone_id:b.zone_id,channel_id:b.input_stream_id,geometry_revision:b.geometry_revision,version:b.zone_version!,
     state:'active',name:String(raw.name),points:structuredClone(raw.points),edge_ids:raw.points.map((_:unknown,j:number)=>`edge-${j}`)};
    if(!zones.some(z=>z.zone_id===zone!.zone_id))zones.push(zone);
   }
   const edge=(n:number)=>{
    if(!zone||n>=zone.edge_ids.length)throw Error('旧方向引用的边不存在，请重新确认。');
    return zone.edge_ids[n];
   };
   const document:TriggerAssignment={
    assignment_id:'legacy-'+createHash('sha256').update(JSON.stringify([old.trigger_id,b.channel_id,b.zone_id])).digest('hex').slice(0,32),
    trigger_id:old.trigger_id,input_stream_id:b.input_stream_id,processor_id:b.channel_id,zone_id:b.zone_id,zone_version:b.zone_version,
    geometry_revision:b.geometry_revision,label_map_version:b.label_map_version,
    entry_edges:b.direction.entry_edges.map(edge),exit_edges:b.direction.exit_edges.map(edge),
    ...(definition.behavior==='region_approach'?{approach_width_percent:(b.approach_px??NaN)/source.width*100}:{}),
   };
   const rule=compileAssignment({...definition,state:'enabled'},version,document,{
    channel_id:b.channel_id,input_stream_id:b.input_stream_id,label_map_version:b.label_map_version,geometry_revision:b.geometry_revision,
    labels:definition.labels,tracking_available:true,width:source.width,height:source.height,
    stream_fingerprint:source.stream_fingerprint,observed_at:source.not_before,
   },zone,1);
   return {document,rule:definition.state==='enabled'?rule:null};
  });
  validateAssignmentSet(assignments.map(a=>a.document));
  return {status:'converted',definition,zones,assignments};
 }catch(e){
  return {status:'review',reason:e instanceof Error?e.message:'旧规则无法确认等价，请重新选用。'};
 }
}
