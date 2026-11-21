import {randomUUID} from 'node:crypto';
import {AlarmConfigError} from '../store/alarmZones.js';
import {ArmingScenes,stale,type SceneEdit,type SceneRow} from '../store/armingScenes.js';
import type {FloorPlanImages} from './floorPlanImages.js';
import {samePtzPosition} from './ptzManager.js';
import {projectScene,sameProjection,type ScenePoint} from './sceneProjection.js';
import type {CaptureContext,SceneImage} from './sceneCapture.js';
import {projectPresetView} from './presetView.js';
import type {PresetHome,PresetSelection} from './presetHome.js';
import type {CurrentViewProof} from '../store/armingViewConfirmation.js';

type Camera={identity:string;resource:string;app:string;stream:string;idle:boolean;pose:unknown};
interface Dependencies{
 experimentalProjection?:boolean;
 presetCapability?:(id:string)=>Promise<{presetBindingAvailable:boolean;presetBindingReason:string}>;
 preset?:(id:string,selection:PresetSelection,actor?:string)=>Promise<PresetHome>;
 source:(id:string,p?:string,observe?:boolean)=>Promise<Camera|null>;
 geometry:(id:string,p:string)=>Promise<{geometry_revision:string;width:number;height:number}|null>;
 eligibleGeometry?:(id:string)=>Promise<boolean>;
 capture:(c:CaptureContext)=>Promise<SceneImage>;
 match:(reference:Buffer,current:SceneImage,timeoutMs?:number)=>Promise<unknown>;
 images:Pick<FloorPlanImages,'read'|'publish'|'cleanup'>;
}
const item=(r:SceneRow,points:ScenePoint[]|null,state:SceneRow['state'],reason:string)=>({
 unavailable:reason.startsWith('布防预置位不可用'),
 binding_mode:r.binding_mode,preset_id:r.preset_home?.preset_id??null,preset_name:r.preset_home?.preset_name??null,preset_fingerprint:r.preset_home?.preset_fingerprint??null,
 zone_id:r.zone_id,processor_id:r.processor_id,revision:r.revision,reference_points:r.reference_points,
 current_points:points,state,reference_frame_id:r.reference_frame_id,reason});
// A pose response has no trustworthy observation timestamp in the current
// adapter contract. It can veto a view, but cannot extend visual authorization.
const visualCurrent=(r:SceneRow,now=Date.now())=>{
 const at=r.visual_checked_at?.getTime();
 return at!==undefined&&Number.isFinite(at)&&at<=now&&now-at<300000;
};
function presetFailure(error:unknown){
 const code=(error as {code?:string})?.code;
 if(code==='ptz_preset_not_arrived')return {reason:'已离开布防视角',state:'unmatched' as const};
 if(['ptz_preset_changed','ptz_preset_position_required','ptz_preset_binding_unavailable','scene_preset_unavailable','ptz_source_changed','scene_preset_changed'].includes(code??''))
  return {reason:'布防预置位不可用：位置记录、版本或来源身份已变化，请重新选择并核验',state:'pending' as const};
 return null;
}
export class ArmingSceneRuntime{
 private backgroundActive=false;
 private interactive=false;
 private lastCleanup=0;
 private stopped=false;
 private timer?:ReturnType<typeof setTimeout>;
 private running?:Promise<void>;
 constructor(readonly store:ArmingScenes,private deps:Dependencies){}
 private assertHomePose(context:{pose:unknown},home:PresetHome){
  if(!context.pose||!home.pose||!samePtzPosition(home.pose,context.pose))
   throw new AlarmConfigError('ptz_preset_not_arrived','已离开布防视角或当前到位反馈不可用',409);
 }
 private project(match:unknown,points:ScenePoint[],mode:string,geometry?:{width:number;height:number}){
  return mode==='preset'?projectPresetView(match,points,geometry):this.deps.experimentalProjection?projectScene(match,points):null;
 }
 private async home(id:string,home:PresetHome,actor?:string){
  if(!this.deps.preset)throw new AlarmConfigError('scene_preset_unavailable','当前来源不支持正式预置位布防',422);
  let current:PresetHome;
  try{current=await this.deps.preset(id,{binding_mode:'preset',preset_id:home.preset_id,preset_fingerprint:home.preset_fingerprint},actor);}
  catch(error){
   const failure=presetFailure(error);
   if(failure)throw new AlarmConfigError((error as {code:string}).code,failure.reason,409);
   if((error as {code?:string})?.code==='ptz_preset_goto_required')throw new AlarmConfigError('scene_preset_goto_required','请先返回预置位并等待到位确认，草稿已保留',409);
   throw error;
  }
  if(current.identity!==home.identity||current.resource!==home.resource||current.motor!==home.motor||!samePtzPosition(home.pose,current.pose))throw new AlarmConfigError('scene_preset_changed','布防预置位不可用：来源或位置记录已变化',409);
  return current;
 }
 private async exclusive<T>(fn:()=>Promise<T>,waitUntil?:number){
  const busy=()=>new AlarmConfigError('scene_busy','场景正在核验，请稍后重试',429);
  const expired=()=>new AlarmConfigError('scene_wait_timeout','等待场景核验超时，请重试',503);
  if(this.stopped||this.interactive||waitUntil===undefined&&this.backgroundActive)throw busy();
  if(waitUntil===undefined)this.backgroundActive=true;else this.interactive=true;
  try{
   const client=await this.store.pool.connect();
   let reserved=false,held=false,inTransaction=false,discard=false;
   try{
    if(waitUntil===undefined){
     held=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('arming-scene-hardware',0)) AS held")).rows[0].held;
     if(!held)throw busy();
    }else{
     // One interactive session across processes. PG queues it behind the
     // current hardware holder; background workers only ever try their lock.
     reserved=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('arming-scene-interactive',0)) AS held")).rows[0].held;
     if(!reserved)throw busy();
     const remaining=waitUntil-Date.now();
     if(remaining<=0)throw expired();
     await client.query('BEGIN');inTransaction=true;
     await client.query("SELECT set_config('statement_timeout',$1,true)",[remaining+'ms']);
     try{await client.query("SELECT pg_advisory_lock(hashtextextended('arming-scene-hardware',0))");held=true;}
     catch(error){if((error as {code?:string}).code==='57014')throw expired();throw error;}
     // The hardware lock belongs to the session. No transaction stays open
     // while reading the camera, matching images or saving a frozen frame.
     await client.query('COMMIT');inTransaction=false;
     if(this.stopped||Date.now()>=waitUntil)throw expired();
    }
    return await fn();
   }finally{
    try{
     if(inTransaction)await client.query('ROLLBACK');
     if(held)await client.query("SELECT pg_advisory_unlock(hashtextextended('arming-scene-hardware',0))");
     if(reserved)await client.query("SELECT pg_advisory_unlock(hashtextextended('arming-scene-interactive',0))");
    }catch(error){discard=true;throw error;}finally{client.release(discard);}
   }
  }finally{if(waitUntil===undefined)this.backgroundActive=false;else this.interactive=false;}
 }
 private async context(id:string,p:string){
  const [camera,stamp]=await Promise.all([this.deps.source(id,p,true),this.store.stamp(id)]);
  if(!camera?.idle||stamp.moving)throw stale();
  const geometry=await this.deps.geometry(id,p);
  if(!geometry||geometry.width>4096||geometry.height>4096||geometry.width*geometry.height>8*1024*1024)throw stale();
  return {...camera,...geometry,...stamp};
 }
 private async capture(context:CaptureContext){
  const started=Date.now(),sample=await this.deps.capture(context),ended=Date.now();
  const received=sample.at.getTime();
  // Validate the acquisition contract, not source exposure time. A paced
  // replay can still satisfy this check; receiver time cannot prove freshness.
  if(!Number.isFinite(received)||received<started||received>ended||ended-received>15000)
   throw new AlarmConfigError('scene_capture_time_invalid','采集时间证据无效，请重试',503);
  return sample;
 }
 private async recheck(id:string,p:string,start:Awaited<ReturnType<ArmingSceneRuntime['context']>>,homes:PresetHome[]=[]){
  const end=await this.context(id,p);
  for(const home of homes)this.assertHomePose(end,home);
  if(end.identity!==start.identity||end.resource!==start.resource||end.epoch!==start.epoch||end.manual!==start.manual||
    end.geometry_revision!==start.geometry_revision||Boolean(end.pose)!==Boolean(start.pose)||
    start.pose&&!samePtzPosition(start.pose,end.pose))throw stale();
 }
 async read(id:string,p?:string){
  const [s,rows,camera]=await Promise.all([this.store.stamp(id),this.store.rows(id,p),this.deps.source(id,p,false).catch(()=>null)]);
  const supported=!!camera&&(!this.deps.eligibleGeometry||await this.deps.eligibleGeometry(id).catch(()=>false));
  const names=new Map<string,string>();
  if(rows.some(r=>r.binding_mode==='preset')){
   const labels=await this.store.pool.query("SELECT z.processor_id,z.zone_id,p.name FROM arming_scene_zones z JOIN ptz_presets p ON p.resource_key=z.resource AND p.preset_id=z.preset_home->>'preset_id' WHERE z.source_id=$1 AND ($2::text IS NULL OR z.processor_id=$2)",[id,p??null]);
   for(const r of labels.rows)names.set(JSON.stringify([r.processor_id,r.zone_id]),r.name);
  }
  const displayItem=(r:SceneRow,points:ScenePoint[]|null,state:SceneRow['state'],reason:string)=>({...item(r,points,state,reason),preset_name:names.get(JSON.stringify([r.processor_id,r.zone_id]))??r.preset_home?.preset_name??null});
  const capability=supported&&this.deps.presetCapability?await this.deps.presetCapability(id).catch(()=>null):null;
  const homes=new Map<string,ReturnType<typeof presetFailure>>();
  for(const r of rows)if(r.binding_mode==='preset'&&r.state==='matched'){
   const key=JSON.stringify([r.preset_home,r.pose]);
   if(!homes.has(key)){
    try{if(!r.preset_home)throw new AlarmConfigError('scene_preset_changed','布防预置位记录缺失',409);this.assertHomePose(r,r.preset_home);await this.home(id,r.preset_home);homes.set(key,null);}
    catch(error){homes.set(key,presetFailure(error)??{reason:'等待预置位状态核验',state:'pending'});}
   }
  }
  return {guard_blocked:s.guard_blocked===true,eligible:!!p&&supported,presetBindingAvailable:!!p&&!!capability?.presetBindingAvailable,presetBindingReason:capability?.presetBindingReason||(!capability?'当前来源缺少预置位到位核验证据':''),experimentalProjectionEnabled:!!this.deps.experimentalProjection,identity:camera?.identity??null,epoch:s.epoch,
   items:rows.map(r=>{
    const failure=homes.get(JSON.stringify([r.preset_home,r.pose]));
    if(failure)return displayItem(r,null,failure.state,failure.reason);
    return !supported||r.binding_mode!=='preset'&&!this.deps.experimentalProjection||r.state==='matched'&&!visualCurrent(r)||Date.now()-r.checked_at.getTime()>90000||!camera?.idle||s.moving||r.epoch!==s.epoch||r.identity!==camera.identity?
     displayItem(r,null,'pending','等待当前视角核验'):displayItem(r,r.current_points,r.state,r.reason);
   })};
 }
 // Validate current input, processor and reported source geometry before each rules
 // snapshot. Fence the async result by row revision and persist the failure so
 // the alarm service never receives different contents under the same revision.
 async checkBindings(){
  const rows=(await this.store.pool.query<SceneRow>("SELECT * FROM arming_scene_zones WHERE state='matched'")).rows;
  const groups=new Map<string,SceneRow[]>();
  for(const row of rows){const k=JSON.stringify([row.source_id,row.processor_id]);const g=groups.get(k)??[];g.push(row);groups.set(k,g);}
  for(const group of groups.values()){
   const {source_id:id,processor_id:p}=group[0]!;
   const [source,geometry]=await Promise.all([this.deps.source(id,p,group.some(r=>r.binding_mode==='preset'||!!r.pose)).catch(()=>null),this.deps.geometry(id,p).catch(()=>null)]);
   const homeValidity=new Map<string,boolean>();
   for(const r of group)if(r.binding_mode==='preset'){
    const key=JSON.stringify(r.preset_home);
    if(!homeValidity.has(key))homeValidity.set(key,!!r.preset_home&&!!await this.home(id,r.preset_home).catch(()=>null));
   }
   const bad=group.filter(r=>r.binding_mode==='preset'?!r.pose||!r.preset_home?.pose||!source?.pose||!samePtzPosition(r.preset_home.pose,r.pose)||!samePtzPosition(r.preset_home.pose,source.pose)||!homeValidity.get(JSON.stringify(r.preset_home))||!visualCurrent(r)||!source?.idle||source.identity!==r.identity||source.resource!==r.resource||geometry?.geometry_revision!==r.geometry_revision:
    !this.deps.experimentalProjection||!visualCurrent(r)||!source?.idle||source.identity!==r.identity||source.resource!==r.resource||r.pose&&!samePtzPosition(r.pose,source.pose)||geometry?.geometry_revision!==r.geometry_revision);
   if(bad.length)await this.store.transaction(async c=>{
    const q=await c.query("UPDATE arming_scene_zones SET state='pending',current_points=NULL,reason='来源或视觉核验已失效',revision=nextval('arming_scene_revision'),changed_at=clock_timestamp() WHERE revision=ANY($1::int[])",[bad.map(r=>r.revision)]);
    if(q.rowCount)await c.query('UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton');
   });
  }
 }
 private async reference(frameId:string){
  const {rows:[r]}=await this.store.pool.query('SELECT image FROM arming_scene_frames WHERE frame_id=$1 AND image_retired_at IS NULL',[frameId]);
  if(!r)throw stale();return this.deps.images.read(r.image);
 }
 async confirmCurrentView(id:string,p:string,actor:string,manual:number,frameId:string):Promise<CurrentViewProof>{
  const invalid=()=>new AlarmConfigError('current_view_confirmation_stale','当前画面核对已失效，请停止云台并重新打开画面核对；草稿已保留',409);
  const {rows:[frame]}=await this.store.pool.query(`SELECT * FROM arming_scene_frames WHERE frame_id=$1 AND source_id=$2
   AND processor_id=$3 AND actor=$4 AND manual_revision=$5 AND binding_mode='current' AND image_retired_at IS NULL
   AND captured_at>clock_timestamp()-interval '5 minutes' AND captured_at<=clock_timestamp()`,[frameId,id,p,actor,manual]);
  if(!frame)throw invalid();
  const current=await this.context(id,p);
  if(frame.epoch!==current.epoch||frame.manual_revision!==current.manual||frame.identity!==current.identity||
   frame.resource!==current.resource||frame.geometry_revision!==current.geometry_revision||
   Boolean(frame.pose)!==Boolean(current.pose)||frame.pose&&!samePtzPosition(frame.pose,current.pose))throw invalid();
  return {frame_id:frame.frame_id,identity:current.identity,resource:current.resource,epoch:current.epoch,
   geometry_revision:current.geometry_revision,at:Date.now()};
 }
 async freeze(id:string,p:string,actor:string,selection?:PresetSelection){
  const started=Date.now(),deadline=started+36000;
  const guard=()=>{if(Date.now()>=deadline)throw new AlarmConfigError('scene_timeout','冻结场景核验超时，请重试',503);};
  const job=this.exclusive(async()=>{
   const start=await this.context(id,p),rows=await this.store.rows(id,p);
   const home=selection&&this.deps.preset?await this.deps.preset(id,selection,actor):null;
   if(selection&&!home)throw new AlarmConfigError('scene_preset_unavailable','当前来源不支持正式预置位布防',422);
   if(home&&(home.identity!==start.identity||home.resource!==start.resource||!samePtzPosition(home.pose,start.pose)))throw stale();
   if(home)this.assertHomePose(start,home);
   const mode=home?'preset':this.deps.experimentalProjection?'experimental_projection':'current';
   const image=await this.capture(start);
   const matches=new Map<string,unknown>();
   const confirmations=new Map<string,unknown>();
   const homeValid=new Map<string,boolean>();
   for(const r of rows)if(r.binding_mode==='preset'&&r.preset_home){
    const key=r.preset_home.preset_fingerprint;
    if(!homeValid.has(key))homeValid.set(key,!!start.pose&&samePtzPosition(r.preset_home.pose,start.pose)&&!!await this.home(id,r.preset_home).catch(()=>null));
   }
   const checkedHomes=[...(home?[home]:[]),...rows.filter(r=>r.preset_home&&homeValid.get(r.preset_home.preset_fingerprint)).map(r=>r.preset_home!)];
   await this.recheck(id,p,start,checkedHomes);
   const secondImage=home||[...homeValid.values()].some(Boolean)?await this.capture(start):null;
   if(home&&secondImage){
    await this.recheck(id,p,start,checkedHomes);await this.home(id,home,actor);
    const remaining=deadline-Date.now()-3000;
    if(remaining<100)throw new AlarmConfigError('scene_timeout','冻结场景核验超时，请重试',503);
    const stable=await this.deps.match(image.bytes,secondImage,Math.min(17000,remaining));
    if(!this.project(stable,[[0,0],[1,0],[1,1],[0,1]],'preset',start))
     throw new AlarmConfigError('scene_region_unreliable','预置位画面尚未获得可靠的同视角证据，请停稳并选择清晰、稳定的背景；草稿已保留',422);
   }
   for(const frame of new Set(rows.filter(r=>(r.binding_mode==='preset'?!!r.preset_home&&homeValid.get(r.preset_home.preset_fingerprint):this.deps.experimentalProjection)&&r.identity===start.identity&&r.geometry_revision===start.geometry_revision).map(r=>r.reference_frame_id))){
    // Reserve time for final identity/epoch proof and disk publication.
    const remaining=deadline-Date.now()-3000;
    if(remaining<3000)break;
    matches.set(frame,await this.deps.match(await this.reference(frame),image,Math.min(17000,remaining)));
    if(secondImage){
     const rest=deadline-Date.now()-3000;
     if(rest<100)break;
     confirmations.set(frame,await this.deps.match(await this.reference(frame),secondImage,Math.min(17000,rest)));
    }
   }
   const items=rows.map(r=>{
    const trusted=r.binding_mode!=='preset'||!!r.preset_home&&homeValid.get(r.preset_home.preset_fingerprint)&&
     !!this.project(confirmations.get(r.reference_frame_id),r.reference_points,r.binding_mode,start);
    const points=trusted&&r.identity===start.identity&&r.geometry_revision===start.geometry_revision?
     this.project(matches.get(r.reference_frame_id),r.reference_points,r.binding_mode,start):null;
    const deferred=!matches.has(r.reference_frame_id)&&r.identity===start.identity&&r.geometry_revision===start.geometry_revision;
    return item(r,points,points?'matched':deferred?'pending':'unmatched',points?'':deferred?'本次冻结核验预算已用完':'冻结画面未匹配');
   });
   await this.recheck(id,p,start,checkedHomes);
   if(home)await this.home(id,home,actor);
   guard();
   const ref=await this.deps.images.publish(image.bytes,image.w,image.h);
   const frame_id=randomUUID();
   await this.store.transaction(async c=>{
    const stamp=await this.store.stamp(id,c),now=await this.store.rows(id,p,c);
    guard();
    if(stamp.moving||stamp.epoch!==start.epoch||stamp.manual!==start.manual||
      now.length!==rows.length||now.some((r,i)=>r.revision!==rows[i]?.revision))throw stale();
    await c.query(`INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,geometry_revision,
     captured_at,image,pose,manual_revision,items,binding_mode,preset_home) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
     [frame_id,id,p,actor,start.identity,start.resource,start.epoch,start.geometry_revision,image.at,ref,start.pose,start.manual,JSON.stringify(items),mode,home]);
   });
   return {frame_id,image_url:'/api/alarms/arming/'+encodeURIComponent(id)+'/scenes/frame/'+frame_id,
    width:image.w,height:image.h,captured_at:image.at.toISOString(),geometry_revision:start.geometry_revision,
    identity:start.identity,epoch:start.epoch,items,binding_mode:mode,preset_id:home?.preset_id??null,preset_name:home?.preset_name??null,preset_fingerprint:home?.preset_fingerprint??null};
  },started+18000);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([job,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AlarmConfigError('scene_timeout','冻结场景核验超时，请重试',503)),36000);})]);}
  catch(error){
   if(error instanceof AlarmConfigError)throw error;
   const failure=presetFailure(error);
   if(failure)throw new AlarmConfigError((error as {code:string}).code,failure.reason,409);
   if((error as {code?:string})?.code==='ptz_preset_goto_required')throw new AlarmConfigError('scene_preset_goto_required','请先返回预置位并等待到位确认，草稿已保留',409);
   throw new AlarmConfigError('scene_capture_unavailable','暂时无法冻结当前画面，请稍后重试',503);
  }finally{clearTimeout(timer);}
 }
 async image(id:string,frame:string,actor:string){
  const {rows:[r]}=await this.store.pool.query("SELECT image,image_retired_at,captured_at>clock_timestamp()-interval '5 minutes' AS fresh FROM arming_scene_frames WHERE frame_id=$1 AND source_id=$2 AND actor=$3",[frame,id,actor]);
  if(r?.image_retired_at)throw new AlarmConfigError('scene_image_expired','历史参考图片已到期',410);
  if(!r?.fresh)throw stale();return this.deps.images.read(r.image);
 }
 async prove(id:string,p:string,actor:string,manual:number,edits:SceneEdit[],zones:{zone_id:string;points:ScenePoint[]}[]){
  const started=Date.now(),deadline=started+30000;
  return this.exclusive(async()=>{
   if(!edits.length||new Set(edits.map(e=>e.frame_id)).size!==1)throw stale();
   const {rows:[f]}=await this.store.pool.query("SELECT * FROM arming_scene_frames WHERE frame_id=$1 AND source_id=$2 AND processor_id=$3 AND actor=$4 AND manual_revision=$5 AND image_retired_at IS NULL AND captured_at>clock_timestamp()-interval '5 minutes'",[edits[0]!.frame_id,id,p,actor,manual]);
   if(!f)throw stale();
   const start=await this.context(id,p);
   if(f.binding_mode==='current'||f.binding_mode!=='preset'&&!this.deps.experimentalProjection)throw new AlarmConfigError('scene_preset_required','请先返回并核验预置位后绑定区域',422);
   if(f.binding_mode==='preset'){
    if(!f.preset_home)throw stale();
    this.assertHomePose(start,f.preset_home);
    await this.home(id,f.preset_home,actor);
   }
   for(const e of edits)if(e.mode==='unbind'){
    const frozen=f.items.find((i:any)=>i.zone_id===e.zone_id),zone=zones.find(z=>z.zone_id===e.zone_id);
    if(!frozen||frozen.state!=='matched'||!frozen.current_points||!zone||!sameProjection(zone.points,frozen.current_points))throw stale();
   }
   if(start.manual!==manual||start.epoch!==f.epoch||start.geometry_revision!==f.geometry_revision||start.identity!==f.identity||
     f.pose&&!samePtzPosition(f.pose,start.pose))throw stale();
   // Snapshot before visual acquisition: evidence arriving during or after
   // these captures must be fenced when the arming transaction takes its lock.
   // Preserve PostgreSQL timestamp precision; JS Date truncates microseconds.
   const observed=await this.store.pool.query<{zone_id:string;revision:number;checked_at:string}>(
    'SELECT zone_id,revision,checked_at::text AS checked_at FROM arming_scene_zones WHERE source_id=$1 AND processor_id=$2 AND zone_id=ANY($3::text[])',[id,p,edits.map(e=>e.zone_id)]);
   const binding_evidence=Object.fromEntries(edits.map(e=>{
    const row=observed.rows.find(r=>r.zone_id===e.zone_id);
    return [e.zone_id,row?{revision:row.revision,checked_at:row.checked_at}:{revision:0,checked_at:null}];
   }));
   const sample=await this.capture(start),reference=await this.deps.images.read(f.image);
   const remaining=deadline-Date.now();
   const timeout=()=>new AlarmConfigError('scene_timeout','当前画面核验超时，请重试',503);
   if(remaining<100)throw timeout();
   const match=await this.deps.match(reference,sample,Math.min(17000,remaining));
   await this.recheck(id,p,start,f.binding_mode==='preset'?[f.preset_home]:[]);
   const second=f.binding_mode==='preset'?await this.capture(start):null;
   const remainingSecond=deadline-Date.now();
   if(remainingSecond<100)throw timeout();
   const secondMatch=second?await this.deps.match(reference,second,Math.min(17000,remainingSecond)):match;
   for(const e of edits){
    const z=zones.find(z=>z.zone_id===e.zone_id);
    if(!z)throw stale();
    const projected=this.project(match,z.points,f.binding_mode,start),confirmed=this.project(secondMatch,z.points,f.binding_mode,start);
    if(!projected||!confirmed)throw new AlarmConfigError('scene_region_unreliable',
     '所选区域暂未获得可靠匹配，可能与纹理不足、遮挡或视角差异有关。请重新选择清晰、稳定的背景区域；草稿已保留。',422);
    if(!sameProjection(z.points,projected,.004))throw stale();
   }
   await this.recheck(id,p,start,f.binding_mode==='preset'?[f.preset_home]:[]);
   if(f.binding_mode==='preset')await this.home(id,f.preset_home,actor);
   if(Date.now()>=deadline)throw timeout();
   return {frame_id:String(f.frame_id),at:Date.now(),binding_evidence};
  },started+18000);
 }
 async tick(){
  if(this.interactive||this.backgroundActive||this.stopped)return;
  await this.store.invalidate(false);
  if(Date.now()-this.lastCleanup>600000){
   this.lastCleanup=Date.now();
   // Share admission with freeze, proof and reconciliation across BFF processes.
   // Release the PG mutation lock before file I/O. A newly published image
   // cannot age out relative to this sweep's fixed start time.
   await this.exclusive(async()=>{
    const started=Date.now(),live=await this.store.retainedImages();
    await this.deps.images.cleanup(live,started);
   }).catch(()=>undefined);
  }
  // One immutable reference per background turn. All of its polygons share
  // the same two native matches. Young successful views and failures rest.
  const dueSql=`SELECT source_id,processor_id,reference_frame_id FROM arming_scene_zones
   WHERE ${this.deps.experimentalProjection?'true':"binding_mode='preset'"}
   GROUP BY source_id,processor_id,reference_frame_id HAVING bool_or(
   epoch<>arming_scene_epoch(source_id) OR state='pending' AND checked_at<clock_timestamp()-interval '3 seconds'
   OR state='matched' AND (visual_checked_at IS NULL OR visual_checked_at<=clock_timestamp()-interval '5 minutes')
   OR checked_at<clock_timestamp()-CASE WHEN state='unmatched' THEN
    CASE evidence->>'retry_level' WHEN '1' THEN interval '5 seconds' WHEN '2' THEN interval '10 seconds'
     WHEN '3' THEN interval '20 seconds' ELSE interval '45 seconds' END ELSE interval '20 seconds' END)
   ORDER BY min(checked_at) LIMIT 1`;
  const {rows:[group]}=await this.store.pool.query(dueSql);
  if(!group||this.interactive||this.backgroundActive||this.stopped)return;
  await this.exclusive(async()=>{
   const {rows:[due]}=await this.store.pool.query(dueSql);
   if(!due||due.source_id!==group.source_id||due.processor_id!==group.processor_id||due.reference_frame_id!==group.reference_frame_id)return;
   const id=group.source_id,p=group.processor_id,initial=await this.store.stamp(id);
   const rows=(await this.store.rows(id,p)).filter(r=>r.reference_frame_id===group.reference_frame_id);
   // Persist scheduling evidence so restarts/other BFF workers cannot reset
   // a failing reference to the fastest tier. The global PG hardware lock
   // already serializes all sources, stronger than one task per source.
   const retryRows=await this.store.pool.query<{revision:number;level:string|null}>(
    "SELECT revision,evidence->>'retry_level' AS level FROM arming_scene_zones WHERE source_id=$1 AND processor_id=$2 AND reference_frame_id=$3",[id,p,group.reference_frame_id]);
   const levels=new Map(retryRows.rows.map(r=>[r.revision,Number(r.level)]));
   let pose:unknown=null,evidence:unknown=null;
   const unmatched=new Set<string>();
   const output=new Map<string,ScenePoint[]>();
   let failureReason='';
   try{
    if(initial.moving)throw stale();
    for(const r of rows)if(r.binding_mode==='preset'){
     if(!r.preset_home)throw stale();await this.home(id,r.preset_home);
    }
    const ctx=await this.context(id,p);
    for(const r of rows)if(r.binding_mode==='preset')this.assertHomePose(ctx,r.preset_home!);
    if(ctx.manual!==initial.manual||ctx.epoch!==initial.epoch||rows.some(r=>r.identity!==ctx.identity||
       r.resource!==ctx.resource||r.geometry_revision!==ctx.geometry_revision))throw stale();
    const ref=await this.reference(group.reference_frame_id),first=await this.capture(ctx);
    const m0=await this.deps.match(ref,first);
    // Repeated IDLE may be cached. Every positive result needs two separately
    // acquired direct projections, including ONVIF. This tests consistency,
    // not source-frame freshness (the current capture protocol cannot prove it).
    const needSecond=rows.some(r=>this.project(m0,r.reference_points,r.binding_mode,ctx));
    const checkedHomes=rows.filter(r=>r.binding_mode==='preset').map(r=>r.preset_home!);
    if(needSecond)await this.recheck(id,p,ctx,checkedHomes);
    const second=needSecond?await this.capture(ctx):null;
    const m1=second?await this.deps.match(ref,second):m0;
    await this.recheck(id,p,ctx,checkedHomes);
    for(const r of rows)if(r.binding_mode==='preset')await this.home(id,r.preset_home!);
    pose=ctx.pose;evidence={match:m1,captured_at:(second??first).at.toISOString(),capture_timing:(second??first).timing??null,width:ctx.width,height:ctx.height};
    for(const r of rows){
     const a=this.project(m0,r.reference_points,r.binding_mode,ctx),b=this.project(m1,r.reference_points,r.binding_mode,ctx);
     if(!a&&!b)unmatched.add(r.zone_id);
     else if(a&&b&&sameProjection(a,b))output.set(r.zone_id,b);
    }
   }catch(error){
    const code=(error as {code?:string})?.code;
    if(code==='ptz_preset_not_arrived'){
     failureReason='已离开布防视角';for(const r of rows)unmatched.add(r.zone_id);
    }else if(code==='ptz_preset_changed'||code==='ptz_preset_position_required'||code==='ptz_preset_binding_unavailable'||code==='scene_preset_unavailable'){
     failureReason='布防预置位不可用：位置记录、版本或设备能力已变化，请重新选择并核验';
    }else if(code==='ptz_source_changed')failureReason='布防预置位不可用：摄像头来源身份已变化';
    // Other model/resource/motion failures pause, never extend authorization.
   }
   for(const r of rows){
    const points=output.get(r.zone_id)??null;
    const mismatch=unmatched.has(r.zone_id);
    const reason=failureReason||(mismatch?'画面不匹配或区域超出可靠范围':'等待场景静止或核验资源就绪');
    const previous=levels.get(r.revision)??0;
    const level=mismatch?Math.min(4,(r.state==='unmatched'&&r.epoch===initial.epoch&&Number.isInteger(previous)&&previous>0?previous:0)+1):0;
    const recorded={...(evidence as object??{}),retry_level:level};
    // Both stable and changed states persist evidence through result()'s
    // transaction and revision CAS, including unmatched retry progression.
    await this.store.result(r,initial.manual,initial.epoch,points,points?'':reason,pose,recorded,mismatch?'unmatched':'pending');
   }
  });
 }
 start(report:(error:unknown)=>void){
  const poll=()=>{this.running=this.tick().catch(report).finally(()=>{
   if(!this.stopped){this.timer=setTimeout(poll,2000);this.timer.unref();}
  });};
  poll();
 }
 async close(){this.stopped=true;clearTimeout(this.timer);await this.running;}
}
