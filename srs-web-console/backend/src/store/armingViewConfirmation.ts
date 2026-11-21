import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {AlarmConfigError} from './alarmZones.js';
import {PtzError} from './ptzStore.js';
import {samePtzPosition} from '../services/ptzManager.js';

export interface CurrentViewProof {
 frame_id:string; identity:string; resource:string; epoch:string; geometry_revision:string; at:number;
}
export interface CurrentViewSource {
 source:string; processors:string[]; identity:string; resource:string;
 pose:unknown; requirePose:boolean; at:number;
}
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
/** Only the explicitly viewed processor scope; other processor saves cannot certify it. */
export function currentViewScopeDigest(doc:any,processor:string){
 const assignments=(doc.assignments??[]).filter((a:any)=>a.processor_id===processor);
 const counters=(doc.counter_bindings??[]).filter((a:any)=>a.processor_id===processor);
 const referenced=new Set([...assignments,...counters].map((a:any)=>a.zone_id));
 const zones=(doc.zones??[]).filter((z:any)=>z.processor_id===processor||z.legacy_processor_ids?.includes(processor)||referenced.has(z.zone_id));
 const ordered=(rows:any[],key:string)=>[...rows].sort((a,b)=>String(a[key]).localeCompare(String(b[key])));
 return createHash('sha256').update(JSON.stringify(canonical({source_id:doc.source_id,geometry_revision:doc.geometry_revision,
  coordinate_space:doc.coordinate_space??'planar',processor_id:processor,zones:ordered(zones,'zone_id'),
  assignments:ordered(assignments,'assignment_id'),counter_bindings:ordered(counters,'binding_id')}))).digest('hex');
}
const stale=()=>new AlarmConfigError('current_view_confirmation_stale','当前画面核对已失效，请停止云台并重新打开画面核对；草稿已保留',409);
export async function recordCurrentViewConfirmation(c:PoolClient,doc:any,processor:string,actor:string,manual:number,proof:CurrentViewProof){
 // PTZ block/restore uses this same row lock. Validate AFTER obtaining it, and
 // keep it through the arming save commit: a concurrent movement cannot slip in.
 await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
 if(Date.now()-proof.at>10000||proof.at>Date.now())throw stale();
 const {rows:[frame]}=await c.query(`SELECT * FROM arming_scene_frames WHERE frame_id=$1 AND source_id=$2 AND processor_id=$3
  AND actor=$4 AND manual_revision=$5 AND binding_mode='current' AND image_retired_at IS NULL
  AND captured_at>clock_timestamp()-interval '5 minutes' AND captured_at<=clock_timestamp()`,
 [proof.frame_id,doc.source_id,processor,actor,manual]);
 const {rows:[stamp]}=await c.query(`SELECT arming_scene_epoch($1) AS epoch,
  EXISTS(SELECT 1 FROM ptz_view_guards WHERE $1=ANY(source_ids) AND stop_pending) AS moving`,[doc.source_id]);
 if(!frame||stamp.moving||frame.epoch!==stamp.epoch||proof.epoch!==stamp.epoch||
  frame.identity!==proof.identity||frame.resource!==proof.resource||frame.geometry_revision!==doc.geometry_revision||
  frame.geometry_revision!==proof.geometry_revision)throw stale();
 await c.query(`INSERT INTO ptz_arming_confirmations(source_id,processor_id,resource,epoch,identity,geometry_revision,scope_digest,frame_id,captured_at,actor,pose)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(source_id,processor_id) DO UPDATE SET
  resource=EXCLUDED.resource,epoch=EXCLUDED.epoch,identity=EXCLUDED.identity,geometry_revision=EXCLUDED.geometry_revision,
  scope_digest=EXCLUDED.scope_digest,frame_id=EXCLUDED.frame_id,captured_at=EXCLUDED.captured_at,actor=EXCLUDED.actor,pose=EXCLUDED.pose,confirmed_at=clock_timestamp()`,
 [doc.source_id,processor,frame.resource,stamp.epoch,frame.identity,doc.geometry_revision,currentViewScopeDigest(doc,processor),frame.frame_id,frame.captured_at,actor,frame.pose]);
}

/** Called within PtzStore.restore's config-row lock, never a timestamp-only preflight. */
export async function assertCurrentViewConfirmations(c:PoolClient,resource:string,currentSources:string[],processors:string[],sources:CurrentViewSource[]){
 // Only current active execution bindings matter. Historical output aliases or
 // detached/disabled assignments cannot permanently block this physical camera.
 const {rows}=await c.query(`SELECT compiled_rule AS rule FROM alarm_trigger_assignments WHERE active AND compiled_rule IS NOT NULL
  AND source_id=ANY($1::text[]) UNION ALL SELECT compiled_rule AS rule FROM flow_counter_bindings WHERE active AND compiled_rule IS NOT NULL
  AND source_id=ANY($1::text[])`,[currentSources]);
 const bound=(await c.query('SELECT source_id,processor_id,zone_id FROM arming_scene_zones WHERE source_id=ANY($1::text[])',[currentSources])).rows;
 const scope=new Map<string,{source:string;processor:string}>();
 for(const {rule:r} of rows){
  if(!processors.includes(r.channel_id)||!currentSources.includes(r.input_stream_id))continue;
  if(bound.some(b=>b.source_id===r.input_stream_id&&b.processor_id===r.channel_id&&b.zone_id===r.zone_id))continue;
  scope.set(JSON.stringify([r.input_stream_id,r.channel_id]),{source:r.input_stream_id,processor:r.channel_id});
 }
 // Historical monitors are audit/migration input, not execution rules. Only the
 // enabled legacy trigger bindings still published by AlarmTriggerStore count.
 if((await c.query(`SELECT 1 FROM alarm_triggers t CROSS JOIN LATERAL jsonb_array_elements(t.document->'bindings') b
  WHERE t.document->>'state'='enabled' AND
  ((b->>'input_stream_id'=ANY($1::text[]) AND b->>'channel_id'=ANY($2::text[])) OR
   (COALESCE(b->>'input_stream_id','')='' AND (b->>'channel_id'=ANY($1::text[]) OR b->>'channel_id'=ANY($2::text[])))) LIMIT 1`,[currentSources,processors])).rowCount)
  throw new PtzError('ptz_legacy_rearming_required');
 for(const {source,processor} of scope.values()){
  const current=sources.find(s=>s.source===source&&s.processors.includes(processor));
  const {rows:[saved]}=await c.query(`SELECT a.document,c.*,arming_scene_epoch(a.source_id) AS current_epoch
   FROM alarm_arming_sources a LEFT JOIN ptz_arming_confirmations c ON c.source_id=a.source_id AND c.processor_id=$2
   WHERE a.source_id=$1`,[source,processor]);
  if(!current||Date.now()-current.at>5000||current.at>Date.now()||!saved||saved.resource!==current.resource||saved.identity!==current.identity||saved.epoch!==saved.current_epoch||
   saved.geometry_revision!==saved.document.geometry_revision||saved.scope_digest!==currentViewScopeDigest(saved.document,processor)||
   current.requirePose&&!saved.pose||saved.pose&&(!current.pose||!samePtzPosition(saved.pose,current.pose)))
   throw new PtzError('ptz_view_rearming_required');
 }
}
