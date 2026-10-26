import {z} from 'zod';
import {alarmScheduleSchema} from './alarmSchedule.js';
import {AlarmConfigError} from './alarmZones.js';

const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const percent=z.number().finite().gt(0).max(100);
const definitionSchema=z.object({
  target_model:z.object({name:id,adapter:id,mode:z.enum(['fixed','open'])}).strict().optional(),
  trigger_id:id,name:z.string().trim().min(1).max(128),
  behavior:z.enum(['appearance','region_approach','region_enter','region_traverse']),
  labels:z.array(z.object({label_id:id,name:z.string().trim().min(1).max(256),description:z.string().trim().min(1).max(160).optional()}).strict()).min(1).max(128),
  duration_ms:z.number().int().min(0).max(3600000),
  approach_width_percent:percent.optional(),
  alarm_enabled:z.boolean(),state:z.enum(['draft','enabled','paused','archived']),
  schedule:alarmScheduleSchema,
  review:z.object({enabled:z.boolean(),description:z.string().trim().min(1).max(500),
    reject_below:z.number().min(0).max(0.1),approve_above:z.number().min(0.9).max(1)}).strict().optional(),
}).strict();
export type TriggerDefinition=z.infer<typeof definitionSchema>;
const assignmentSchema=z.object({
  assignment_id:id,trigger_id:id,input_stream_id:id,processor_id:id,
  zone_id:id.nullable(),zone_version:z.number().int().positive().nullable(),
  geometry_revision:id,label_map_version:id,
  entry_edges:z.array(id).max(32),exit_edges:z.array(id).max(32),
  approach_width_percent:percent.optional(),
}).strict();
export type TriggerAssignment=z.infer<typeof assignmentSchema>;
export interface AssignmentSource {
  target_model?:TriggerDefinition['target_model'];
  channel_id:string;input_stream_id:string;geometry_revision:string;label_map_version:string;
  tracking_available:boolean;detection_available?:boolean;labels:{label_id:string;name?:string;description?:string}[];
  width:number;height:number;
  stream_fingerprint?:string;observed_at?:string;
}
export interface AssignmentZone {
  zone_id:string;channel_id:string;geometry_revision:string;version:number;state:string;
  points:[number,number][];edge_ids:string[];erp_wrap?:boolean;
}
const fail=(code:string,message:string):never=>{throw new AlarmConfigError(code,message);};
export function parseTriggerDefinition(input:unknown):TriggerDefinition {
  const parsed=definitionSchema.safeParse(input);
  if(!parsed.success)return fail('invalid_trigger','触发器定义无效');
  const d=parsed.data;
  if(new Set(d.labels.map(l=>l.label_id)).size!==d.labels.length)return fail('invalid_trigger','目标不能重复');
  if(d.target_model){
    const open=['yoloe_bpu','locateanything_bpu'].includes(d.target_model.adapter);
    if(open!==(d.target_model.mode==='open')||d.labels.some(l=>open?!l.description:l.description!==undefined))return fail('invalid_trigger','模型类型与识别标签不匹配');
    if(open&&(d.labels.length>(d.target_model.name==='yoloe-26x-32'?32:8)||d.labels.some(l=>l.description!.includes('<|'))))return fail('invalid_trigger','开放词汇标签数量或描述无效');
  }
  if(d.behavior!=='appearance'&&d.duration_ms!==0)return fail('invalid_trigger','只有出现使用持续时间');
  if((d.behavior==='region_approach')!==(d.approach_width_percent!==undefined))return fail('invalid_trigger','只有接近使用距离且必须设置');
  if(d.review?.enabled&&!d.alarm_enabled)return fail('invalid_review','仅统计不能启用 AI 审核');
  if(d.review?.description.includes('<|'))return fail('invalid_review','审核说明包含保留标记');
  return d;
}
export function parseTriggerAssignment(input:unknown):TriggerAssignment {
  const parsed=assignmentSchema.safeParse(input);
  if(!parsed.success)return fail('invalid_assignment','选用关系无效');
  const a=parsed.data;
  if((a.zone_id===null)!==(a.zone_version===null))return fail('invalid_assignment','区域及版本必须同时设置');
  if(new Set(a.entry_edges).size!==a.entry_edges.length||new Set(a.exit_edges).size!==a.exit_edges.length||a.entry_edges.some(e=>a.exit_edges.includes(e)))return fail('invalid_direction','方向边不能重复');
  if(a.zone_id===null&&(a.entry_edges.length||a.exit_edges.length))return fail('invalid_direction','整个画面不能指定区域方向');
  return a;
}
export function validateAssignmentSet(inputs:unknown[]):TriggerAssignment[] {
  const assignments=inputs.map(parseTriggerAssignment),ids=new Set<string>(),keys=new Set<string>();
  for(const a of assignments){
    const key=JSON.stringify([a.input_stream_id,a.processor_id,a.trigger_id,a.zone_id]);
    if(ids.has(a.assignment_id)||keys.has(key))return fail('duplicate_assignment','重复选用');
    ids.add(a.assignment_id);keys.add(key);
  }
  return assignments;
}
/** Pure rule compiler. Inputs are server-read catalogs and stored versions.
 * executionVersion is a monotonic stored assignment execution version, not a hash
 * or the definition version: geometry and assignment edits also change evidence. */
export function compileAssignment(
  definition:TriggerDefinition,definitionVersion:number,input:unknown,
  source:AssignmentSource,zone:AssignmentZone|null,executionVersion:number,
){
  const d=parseTriggerDefinition(definition),a=parseTriggerAssignment(input);
  if(!Number.isSafeInteger(definitionVersion)||definitionVersion<1||!Number.isSafeInteger(executionVersion)||executionVersion<1)return fail('invalid_version','规则版本无效');
  if(a.trigger_id!==d.trigger_id)return fail('trigger_changed','选用与触发器不匹配');
  if(d.state!=='enabled')return null;
  if(source.channel_id!==a.processor_id||source.input_stream_id!==a.input_stream_id||
    source.geometry_revision!==a.geometry_revision||source.label_map_version!==a.label_map_version)return fail('source_changed','来源或模型目录已变化');
  if(!source.stream_fingerprint||!/^[a-f0-9]{64}$/.test(source.stream_fingerprint)||!source.observed_at||!Number.isFinite(Date.parse(source.observed_at)))return fail('source_unavailable','来源证据尚未确认');
  if(!source.tracking_available&&!(source.detection_available&&d.alarm_enabled&&['appearance','region_approach'].includes(d.behavior)&&d.duration_ms===0&&!a.entry_edges.length&&!a.exit_edges.length&&!zone?.erp_wrap))
    return fail('tracking_required','此规则需要可靠跟踪；无跟踪仅支持无持续时间的出现、区内检出及接近带检出。');
  if(!Number.isSafeInteger(source.width)||source.width<=0||!Number.isSafeInteger(source.height)||source.height<=0)return fail('source_unavailable','原图尺寸尚未确认');
  if(d.target_model&&(!source.target_model||d.target_model.name!==source.target_model.name||d.target_model.adapter!==source.target_model.adapter||d.target_model.mode!==source.target_model.mode))return fail('model_unavailable','请选用相同模型的 AI 通道');
  if(d.labels.some(l=>!source.labels.some(s=>s.label_id===l.label_id&&(s.name||s.description||s.label_id)===l.name&&(l.description===undefined||l.description===s.description))))return fail('labels_unavailable','模型不支持所选目标，请确认目标映射');
  if(d.behavior!=='appearance'&&a.zone_id===null)return fail('zone_required','此行为需要热区');
  if(d.behavior!=='region_approach'&&a.approach_width_percent!==undefined)return fail('invalid_assignment','此行为不使用接近距离');
  if(d.behavior==='appearance'&&(a.entry_edges.length||a.exit_edges.length))return fail('invalid_direction','出现不使用方向');
  if(d.behavior!=='region_traverse'&&a.exit_edges.length)return fail('invalid_direction','只有穿过使用离开方向');
  if(a.zone_id!==null){
    if(!zone||zone.zone_id!==a.zone_id||zone.channel_id!==a.input_stream_id||zone.state!=='active'||
      zone.version!==a.zone_version||zone.geometry_revision!==a.geometry_revision)return fail('zone_changed','热区已变化，请重新确认');
    if(zone.edge_ids.length!==zone.points.length||new Set(zone.edge_ids).size!==zone.edge_ids.length||
      [...a.entry_edges,...a.exit_edges].some(e=>!zone.edge_ids.includes(e)))return fail('invalid_direction','方向引用的边不存在');
  }else if(zone!==null)return fail('invalid_assignment','整个画面不能附带区域');
  const distance=a.approach_width_percent??d.approach_width_percent;
  return {
    id:a.assignment_id,assignment_id:a.assignment_id,trigger_id:d.trigger_id,trigger_version:definitionVersion,
    version:executionVersion,name:d.name,state:'enabled',
    channel_id:a.processor_id,input_stream_id:a.input_stream_id,
    labels:d.labels.map(({label_id,name})=>({label_id,name})),label_ids:d.labels.map(l=>l.label_id),label_map_version:a.label_map_version,geometry_revision:a.geometry_revision,
    zone_id:a.zone_id,zone_version:a.zone_version,points:zone?.points.map(p=>[...p]),...(zone?.erp_wrap?{erp_wrap:true}:{}),
    behavior:d.behavior,anchor:'bottom_center',duration_ms:d.duration_ms,
    entry_edges:a.entry_edges.map(e=>zone!.edge_ids.indexOf(e)),exit_edges:a.exit_edges.map(e=>zone!.edge_ids.indexOf(e)),
    ...(distance!==undefined?{approach_px:source.width*distance/100,approach_width_percent:distance}:{}),
    alarm_enabled:d.alarm_enabled,schedule:d.schedule,review:d.review?.enabled?{...d.review,profile_id:'alarm-review-zh-v1',version:definitionVersion}:{enabled:false},
    source_binding:source.stream_fingerprint&&source.observed_at?{
      stream_fingerprint:source.stream_fingerprint,not_before:source.observed_at,width:source.width,height:source.height,
      input_stream_id:a.input_stream_id,label_map_version:a.label_map_version,geometry_revision:a.geometry_revision,
    }:null,
  };
}
