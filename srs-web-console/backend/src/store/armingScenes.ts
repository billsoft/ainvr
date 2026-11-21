import type {Pool,PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {AlarmConfigError} from './alarmZones.js';
import {sameProjection,type ScenePoint} from '../services/sceneProjection.js';
import {presetDefinitionLock,type PresetHome} from '../services/presetHome.js';

export const editSchema=z.object({zone_id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
 expected_revision:z.number().int().nonnegative(),mode:z.enum(['bind','edit','unbind']),frame_id:z.string().uuid(),binding_mode:z.literal('preset').optional()}).strict();
export type SceneEdit=z.infer<typeof editSchema>;
export interface SceneProof{
 frame_id:string;at:number;
 binding_evidence?:Record<string,{revision:number;checked_at:string|null}>;
}
export const stale=()=>new AlarmConfigError('scene_changed','画面、场景版本或绑定已变化，请保留草稿并重新核对',409);
export interface SceneRow{
 binding_mode:'preset'|'experimental_projection';preset_home:PresetHome|null;
 source_id:string;processor_id:string;zone_id:string;zone_version:number;revision:number;identity:string;
 resource:string;geometry_revision:string;reference_frame_id:string;reference_points:ScenePoint[];
 epoch:string;state:'matched'|'pending'|'unmatched';current_points:ScenePoint[]|null;reason:string;changed_at:Date;checked_at:Date;visual_checked_at:Date|null;pose:unknown;
}
type Zone={zone_id:string;version:number;points:ScenePoint[];edge_ids:string[];erp_wrap?:boolean;processor_id?:string};
interface Document{source_id:string;geometry_revision:string;coordinate_space?:string;zones:Zone[];
 counter_bindings:{processor_id:string;zone_id:string;direction:{kind:string}}[]}
export const lockConfig='SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE';
const bump='UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton';
const next="revision=nextval('arming_scene_revision'),changed_at=clock_timestamp()";
const bindingDefinition=(r:SceneRow)=>[r.source_id,r.processor_id,r.zone_id,r.zone_version,
 r.reference_frame_id,r.reference_points,r.identity,r.resource,r.geometry_revision,r.binding_mode,r.preset_home];
async function unchangedPresetBinding(c:PoolClient,current:SceneRow,expected:number){
 if(expected<=0||current.revision<=expected||current.binding_mode!=='preset')return false;
 // Runtime evidence revisions also reset counting epochs. They are not an
 // editor configuration CAS: a freeze can verify a still-pending row itself.
 // Prove continuity through the immutable journal, never accept a replacement
 // binding that happens to have the same final coordinates. Bound work per save.
 const {rows}=await c.query<{revision:number;operation:string;document:SceneRow}>(
  'SELECT revision,operation,document FROM arming_scene_history WHERE source_id=$1 AND processor_id=$2 AND zone_id=$3 AND revision BETWEEN $4 AND $5 ORDER BY id LIMIT 257',
  [current.source_id,current.processor_id,current.zone_id,expected,current.revision]);
 return rows.length>0&&rows.length<=256&&rows[0]!.revision===expected&&rows.at(-1)!.revision===current.revision&&
  rows.every((r,i)=>(r.operation==='UPDATE'||i===0&&r.operation==='INSERT')&&isDeepStrictEqual(bindingDefinition(r.document),bindingDefinition(current)));
}
export class ArmingScenes{
 constructor(readonly pool:Pool){}
 async transaction<T>(action:(c:PoolClient)=>Promise<T>){
  const c=await this.pool.connect();
  try{await c.query('BEGIN');await c.query(lockConfig);const value=await action(c);await c.query('COMMIT');return value;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 // The global mutation lock serializes this decision with bind, edit and
 // unbind. Only recent editor frames can be bound; they get a 15-minute grace.
 async retainedImages():Promise<Set<string>>{
  return this.transaction(async c=>{
   await c.query(`DELETE FROM arming_scene_frames f WHERE f.captured_at<now()-interval '15 minutes'
     AND NOT EXISTS(SELECT 1 FROM arming_scene_zones z WHERE z.reference_frame_id=f.frame_id)
     AND NOT EXISTS(SELECT 1 FROM arming_scene_history h WHERE h.reference_frame_id=f.frame_id)`);
   // The final DELETE journal entry is the time of last unbinding, including
   // frames shared by multiple zones. A frame in any current state is pinned.
   // Keep space for short-lived editor freezes. Current reference frames
   // remain pinned even if they alone exceed the target of 384.
   await c.query(`WITH budget AS (
      SELECT least(256,greatest(0,384-count(DISTINCT reference_frame_id))) AS slots FROM arming_scene_zones
    ), inactive AS (
      SELECT f.frame_id,activity.last_used,row_number() OVER (ORDER BY activity.last_used DESC,f.frame_id) AS priority
      FROM arming_scene_frames f
      CROSS JOIN LATERAL (SELECT recorded_at AS last_used FROM arming_scene_history h
        WHERE h.reference_frame_id=f.frame_id ORDER BY recorded_at DESC LIMIT 1) activity
      WHERE f.image_retired_at IS NULL AND f.captured_at<now()-interval '15 minutes'
        AND NOT EXISTS(SELECT 1 FROM arming_scene_zones z WHERE z.reference_frame_id=f.frame_id)
    ) UPDATE arming_scene_frames f SET image_retired_at=clock_timestamp()
      FROM inactive i CROSS JOIN budget b WHERE i.frame_id=f.frame_id AND (i.last_used<=now()-interval '7 days' OR i.priority>b.slots)`);
   const {rows}=await c.query("SELECT image->>'ref' AS ref FROM arming_scene_frames WHERE image_retired_at IS NULL");
   return new Set(rows.map(r=>r.ref as string));
  });
 }
 async poseHeartbeat(rows:SceneRow[],manual:number,epoch:string){
  return this.transaction(async c=>{
   const stamp=await this.stamp(rows[0]!.source_id,c);
   if(stamp.manual!==manual || stamp.epoch!==epoch || stamp.moving)return;
   await c.query("UPDATE arming_scene_zones SET checked_at=clock_timestamp() WHERE revision=ANY($1::int[]) AND state='matched' AND epoch=$2 AND checked_at>clock_timestamp()-interval '90 seconds' AND visual_checked_at>clock_timestamp()-interval '5 minutes'",[rows.map(r=>r.revision),epoch]);
  });
 }
 async stamp(id:string,c:Pool|PoolClient=this.pool){
  const {rows:[r]}=await c.query(`SELECT arming_scene_epoch($1) AS epoch, EXISTS(SELECT 1 FROM ptz_view_guards
   WHERE $1=ANY(source_ids) AND stop_pending) AS moving,
   EXISTS(SELECT 1 FROM ptz_view_guards WHERE $1=ANY(source_ids) AND blocked) AS guard_blocked,
   COALESCE((SELECT revision FROM alarm_arming_sources WHERE source_id=$1),0) AS manual`,[id]);
  return r as {epoch:string;moving:boolean;guard_blocked:boolean;manual:number};
 }
 async rows(id:string,p?:string,c:Pool|PoolClient=this.pool){
  return (await c.query<SceneRow>('SELECT * FROM arming_scene_zones WHERE source_id=$1 AND ($2::text IS NULL OR processor_id=$2) ORDER BY zone_id',[id,p??null])).rows;
 }
 async invalidate(startup:boolean){
  if(!startup && !(await this.pool.query("SELECT 1 FROM arming_scene_zones WHERE state='matched' AND checked_at<clock_timestamp()-interval '90 seconds' LIMIT 1")).rowCount)return;
  return this.transaction(async c=>{
   const r=await c.query(`UPDATE arming_scene_zones SET state='pending',current_points=NULL,reason=$1,`+next+
    " WHERE state='matched' AND ($2 OR checked_at<clock_timestamp()-interval '90 seconds')",
    [startup?'启动后等待场景核验':'场景核验超时',startup]);
   if(r.rowCount)await c.query(bump);
  });
 }
 async result(row:SceneRow,manual:number,epoch:string,points:ScenePoint[]|null,reason:string,pose:unknown,evidence:unknown,absent:'pending'|'unmatched'='pending'){
  return this.transaction(async c=>{
   const stamp=await this.stamp(row.source_id,c);
   if(stamp.epoch!==epoch||stamp.manual!==manual||stamp.moving&&points)return;
   const {rows:[r]}=await c.query<SceneRow>('SELECT * FROM arming_scene_zones WHERE source_id=$1 AND processor_id=$2 AND zone_id=$3 AND revision=$4 FOR UPDATE',
    [row.source_id,row.processor_id,row.zone_id,row.revision]);
   if(!r)return;
   const state=points?'matched':absent;
   if(r.state===state && r.epoch===epoch && r.reason===reason && sameProjection(r.current_points,points)){
    await c.query('UPDATE arming_scene_zones SET checked_at=clock_timestamp(),visual_checked_at=CASE WHEN state=\'matched\' THEN clock_timestamp() ELSE NULL END,pose=$2,evidence=$3 WHERE revision=$1',[r.revision,pose,evidence]);return;
   }
   await c.query('UPDATE arming_scene_zones SET '+next+',checked_at=clock_timestamp(),visual_checked_at=CASE WHEN $2=\'matched\' THEN clock_timestamp() ELSE NULL END,state=$2,epoch=$3,current_points=$4,reason=$5,pose=$6,evidence=$7 WHERE revision=$1',
    [r.revision,state,epoch,points?JSON.stringify(points):null,reason,pose,evidence]);
   await c.query(bump);
  });
 }
 async save(c:PoolClient,doc:Document,previous:Document|undefined,p:string|undefined,edits:SceneEdit[],actor:string,manual:number,
   proof:SceneProof|null){
  const original=await this.rows(doc.source_id,undefined,c);
  if(!original.length&&!edits.length)return;
  if(!p)throw stale();
  if(new Set(edits.map(e=>e.zone_id)).size!==edits.length||new Set(edits.map(e=>e.frame_id)).size>1)throw stale();
  // Same order as device-list tombstones: config row, then preset definition.
  await c.query(lockConfig);
  let frame:any;
  if(edits.length){
   frame=(await c.query("SELECT * FROM arming_scene_frames WHERE frame_id=$1 AND source_id=$2 AND processor_id=$3 AND actor=$4 AND manual_revision=$5 AND image_retired_at IS NULL AND geometry_revision=$6 AND captured_at>clock_timestamp()-interval '5 minutes'",
    [edits[0]!.frame_id,doc.source_id,p,actor,manual,doc.geometry_revision])).rows[0];
   if(!frame)throw stale();
   if(!proof||proof.frame_id!==frame.frame_id || Date.now()-proof.at>10000)throw stale();
   if(frame.binding_mode==='current'&&edits.some(e=>e.mode!=='unbind'))throw new AlarmConfigError('scene_preset_required','请先返回并核验预置位后绑定区域',422);
   if(edits.some(e=>e.mode!=='unbind'&&e.binding_mode&&e.binding_mode!==frame.binding_mode))throw stale();
   if(frame.binding_mode==='preset'){
    await c.query(presetDefinitionLock);
    const home=frame.preset_home as PresetHome;
    if(!home)throw stale();
    const definition=(await c.query('SELECT version,present FROM arming_preset_definitions WHERE resource=$1 AND preset_id=$2',[home.resource,home.preset_id])).rows[0];
    if(!definition?.present||definition.version!==home.definition_version)throw stale();
    const conflict=await c.query("SELECT 1 FROM arming_scene_zones WHERE binding_mode='preset' AND preset_home->>'motor'=$1 AND (resource<>$2 OR preset_home->>'preset_id'<>$3 OR preset_home->>'preset_fingerprint'<>$4) LIMIT 1",[home.motor,home.resource,home.preset_id,home.preset_fingerprint]);
    if(conflict.rowCount)throw new AlarmConfigError('scene_home_conflict','共享摄像头已有其他布防预置位，请先解除原绑定',409);
   }
  }
  const stamp=await this.stamp(doc.source_id,c);
  if(stamp.manual!==manual||frame&&(stamp.moving||frame.epoch!==stamp.epoch||Date.now()-new Date(frame.captured_at).getTime()>300000))throw stale();
  const scoped=await this.rows(doc.source_id,p,c);
  const existing=new Map(scoped.map(r=>[r.zone_id,r]));
  for(const r of scoped){
   if(edits.some(e=>e.zone_id===r.zone_id))continue;
   const z=doc.zones.find(v=>v.zone_id===r.zone_id),old=previous?.zones.find(v=>v.zone_id===r.zone_id);
   if(!z){await c.query('DELETE FROM arming_scene_zones WHERE revision=$1',[r.revision]);continue;}
   if(!old||doc.coordinate_space==='erp'||z.erp_wrap||doc.geometry_revision!==r.geometry_revision||
     !isDeepStrictEqual(z.points,r.reference_points)||!isDeepStrictEqual(z.edge_ids,old.edge_ids))throw stale();
   if(z.version!==r.zone_version)await c.query('UPDATE arming_scene_zones SET '+next+',zone_version=$2 WHERE revision=$1',[r.revision,z.version]);
  }
  for(const edit of edits){
   const z=doc.zones.find(v=>v.zone_id===edit.zone_id),r=existing.get(edit.zone_id);
   const frozen=frame.items.find((v:any)=>v.zone_id===edit.zone_id);
   if(frame.binding_mode==='preset'){
    const observed=proof?.binding_evidence?.[edit.zone_id];
    if(!observed||!Number.isSafeInteger(observed.revision)||observed.revision<0)throw stale();
    if(r){
     if(observed.revision<=0||r.revision<observed.revision||!observed.checked_at)throw stale();
     // A fresh proof may supersede a pause which preceded its captures. It
     // must never supersede newer negative evidence, including same-state
     // failures (checked_at changes without a journal/revision increment).
     if(r.state!=='matched'){
      const newer=await c.query('SELECT 1 FROM arming_scene_zones WHERE revision=$1 AND checked_at IS DISTINCT FROM $2::timestamptz',[r.revision,observed.checked_at]);
      if(r.revision!==observed.revision||newer.rowCount)throw stale();
     }
     if(r.revision>observed.revision){
      const negative=await c.query("SELECT 1 FROM arming_scene_history WHERE source_id=$1 AND processor_id=$2 AND zone_id=$3 AND revision>$4 AND revision<=$5 AND document->>'state' IN ('pending','unmatched') LIMIT 1",[r.source_id,r.processor_id,r.zone_id,observed.revision,r.revision]);
      if(negative.rowCount)throw stale();
     }
    }else if(observed.revision!==0)throw stale();
   }
   const newPresetZone=frame.binding_mode==='preset'&&edit.mode==='bind'&&!r&&edit.expected_revision===0&&z?.version===1;
   let sameBindingRevision=(r?.revision??0)===edit.expected_revision;
   if(!sameBindingRevision&&r&&frame.binding_mode==='preset'&&frozen?.binding_mode==='preset'&&
     frozen.revision===edit.expected_revision&&frozen.reference_frame_id===r.reference_frame_id&&
     isDeepStrictEqual(frozen.reference_points,r.reference_points))
    sameBindingRevision=await unchangedPresetBinding(c,r,edit.expected_revision);
   if(!z||(!previous?.zones.some(v=>v.zone_id===edit.zone_id)&&!newPresetZone)||z.processor_id!==p||z.erp_wrap||doc.coordinate_space==='erp'||
     !sameBindingRevision||(frozen?.revision??0)!==edit.expected_revision||
     (edit.mode==='bind')!==!r)throw stale();
   if(edit.mode==='unbind'&&(frozen?.state!=='matched'||!frozen?.current_points||!sameProjection(z.points,frozen.current_points)))throw stale();
   if(r)await c.query('DELETE FROM arming_scene_zones WHERE revision=$1',[r.revision]);
   if(edit.mode!=='unbind')await c.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,
    reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason,binding_mode,preset_home)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending','等待场景核验',$11,$12)`,
    [doc.source_id,p,z.zone_id,z.version,frame.frame_id,JSON.stringify(z.points),frame.identity,frame.resource,doc.geometry_revision,stamp.epoch,frame.binding_mode,frame.preset_home]);
  }
  const bound=new Set((await this.rows(doc.source_id,p,c)).map(r=>r.zone_id));
  if(doc.counter_bindings.some(b=>b.processor_id===p&&bound.has(b.zone_id)&&b.direction.kind==='angle'))
   throw new AlarmConfigError('scene_angle_unsupported','场景绑定区域暂不支持图像角度计数，请改用边或门线',422);
 }
}
