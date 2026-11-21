import {it,expect,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../store/migrator.js';
import {ArmingScenes} from '../store/armingScenes.js';
import {ArmingSceneRuntime} from '../services/armingSceneRuntime.js';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {PtzStore} from '../store/ptzStore.js';
import * as confirmation from '../store/armingViewConfirmation.js';

const enabled=!!process.env.AINVR_SCENE_PG_PORT;
const points=[[.2,.2],[.7,.2],[.7,.7],[.2,.7]];
async function isolated(run:(db:Pool)=>Promise<void>){
 const config={host:'127.0.0.1',port:Number(process.env.AINVR_SCENE_PG_PORT),user:'postgres',database:'scene_test'};
 const admin=new Pool(config),schema='current_view_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new Pool({...config,options:'-c search_path='+schema,max:6});
 try{await runMigrations(db);await run(db);}finally{vi.restoreAllMocks();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
}
const sourceEvidence=(source='cam',processors=['ai'],identity='dev',pose:unknown=null,requirePose=false)=>({source,processors,identity,resource:'motor',pose,requirePose,at:Date.now()});
async function fixture(db:Pool,source='cam'){
 const scenes=new ArmingScenes(db),ptz=new PtzStore(db);
 let idle=true,identity='dev',pose:unknown=null;
 const runtime=new ArmingSceneRuntime(scenes,{
  source:async()=>({identity,resource:'motor',app:'live',stream:'isolated',idle,pose}),
  eligibleGeometry:async()=>true,geometry:async()=>({width:512,height:384,geometry_revision:'g'}),
  capture:async()=>({w:512,h:384,bytes:Buffer.from('isolated-test-frame'),at:new Date()}),
  match:async()=>{throw Error('ordinary confirmation must not run optical matching');},
  images:{read:async()=>Buffer.from('frame'),cleanup:async()=>{},publish:async()=>({ref:'test',w:512,h:384,sha256:'a'.repeat(64),generation:'test'})},
 });
 const arming=new AlarmArmingStore(db,()=>runtime);
 const definition={counter_id:'counter',name:'People',labels:[{label_id:'person',name:'Person'}],method:'zone',outputs:'both',
  names:{in:'In',out:'Out'},occupancy:false,max_gap_ms:1000,state:'enabled'};
 await db.query('INSERT INTO flow_counter_definitions(counter_id,version,document) VALUES($1,1,$2) ON CONFLICT DO NOTHING',['counter',definition]);
 const doc=(p='ai')=>({source_id:source,processor_id:p,geometry_revision:'g',
  zones:[{zone_id:'zone-'+p,processor_id:p,channel_id:source,geometry_revision:'g',version:1,state:'active',name:'Zone '+p,points:structuredClone(points),edge_ids:['a','b','c','d']}],
  assignments:[],counter_bindings:[{binding_id:'flow-'+source+'-'+p,counter_id:'counter',input_stream_id:source,processor_id:p,zone_id:'zone-'+p,
   zone_version:1,geometry_revision:'g',label_map_version:'lm',direction:{kind:'edges',entry:['d'],exit:['b']}}]});
 const lookup=async(p:string)=>({input_stream_id:source,channel_id:p,geometry_revision:'g',label_map_version:'lm',width:512,height:384,
  labels:[{label_id:'person',name:'Person'}],tracking_available:true,observed_at:new Date().toISOString(),stream_fingerprint:'a'.repeat(64)});
 const save=(document:any,revision:number,key=randomUUID())=>arming.saveArming(document,revision,'operator',key,lookup,async()=>'g');
 await save(doc(),0);
 const block=async()=>{const revision=await ptz.block('motor',['cam',source,'historical-output'],'operator');await ptz.stopped('motor',revision);return revision;};
 const revision=await block();
 const freeze=(p='ai')=>runtime.freeze(source,p,'operator');
 const confirm=async(p='ai',manual=1)=>{const frame=await freeze(p);const document={...doc(p),current_view_confirmation:{frame_id:frame.frame_id}};await save(document,manual);return {frame,document};};
 const restore=async(expected=revision,processors=['ai'],currentPose:unknown=null,requirePose=false)=>ptz.restore('motor',expected,'operator',null,
  c=>confirmation.assertCurrentViewConfirmations(c,'motor',[source],processors,[sourceEvidence(source,processors,identity,currentPose,requirePose)]));
 return {scenes,ptz,runtime,arming,doc,save,freeze,confirm,restore,block,revision,setIdle:(v:boolean)=>{idle=v;},setIdentity:(v:string)=>{identity=v;},setPose:(v:unknown)=>{pose=v;}};
}

it.skipIf(!enabled)('migrations create explicit receipts; unchanged count-only confirmation saves and restores, fixed source unaffected',async()=>isolated(async db=>{
 const f=await fixture(db);
 expect((await db.query("SELECT version FROM schema_migrations WHERE version=35")).rowCount).toBe(1);
 expect((await f.runtime.read('cam','ai')).guard_blocked).toBe(true);
 expect((await f.runtime.read('fixed','fixed-ai')).guard_blocked).toBe(false);
 const before=(await f.arming.snapshot()).rules[0];
 await f.confirm();expect((await f.ptz.guard('motor'))?.blocked).toBe(true);
 const after=(await f.arming.snapshot()).rules[0];expect(after).toEqual(before);expect(after.alarm_enabled).toBe(false);
 expect((await db.query('SELECT * FROM alarm_trigger_assignments')).rowCount).toBe(0);
 expect((await db.query('SELECT * FROM ptz_arming_confirmations')).rowCount).toBe(1);
 await f.restore();expect((await f.runtime.read('cam','ai')).guard_blocked).toBe(false);
}));

it.skipIf(!enabled)('ordinary resave and fresh updated_at are not proof; idempotent explicit confirmation remains replayable',async()=>isolated(async db=>{
 const f=await fixture(db);await f.save(f.doc(),1);
 await expect(f.restore()).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 const frame=await f.freeze(),document={...f.doc(),current_view_confirmation:{frame_id:frame.frame_id}},key=randomUUID();
 const saved=await f.save(document,2,key);expect(await f.save(document,2,key)).toEqual(saved);
 expect((await db.query('SELECT * FROM ptz_arming_confirmations')).rowCount).toBe(1);
 await f.restore();
}));

it.skipIf(!enabled).each(['actor','source','processor','manual','age','mode','identity','moving','epoch'] as const)(
 'rejects invalid frozen confirmation: %s',async kind=>isolated(async db=>{
 const f=await fixture(db),frame=await f.freeze();
 const mutation:Record<string,string>={actor:"actor='other'",source:"source_id='other'",processor:"processor_id='other'",
  manual:'manual_revision=99',age:"captured_at=now()-interval '6 minutes'",mode:"binding_mode='preset'"};
 if(mutation[kind])await db.query('UPDATE arming_scene_frames SET '+mutation[kind]+' WHERE frame_id=$1',[frame.frame_id]);
 if(kind==='identity')f.setIdentity('different-device');
 if(kind==='moving')await f.ptz.block('motor',['cam'],'operator');
 if(kind==='epoch')await f.block();
 await expect(f.save({...f.doc(),current_view_confirmation:{frame_id:frame.frame_id}},1)).rejects.toMatchObject({statusCode:409});
 expect((await db.query('SELECT * FROM ptz_arming_confirmations')).rowCount).toBe(0);
 expect((await f.scenes.stamp('cam')).manual).toBe(1);
}));

it.skipIf(!enabled)('confirmation followed by movement is invalid even after stopping; later plain scope edits also invalidate it',async()=>isolated(async db=>{
 const f=await fixture(db);await f.confirm();const newGuard=await f.block();
 await expect(f.restore(newGuard)).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 await f.confirm('ai',2);
 const edited=f.doc();edited.zones[0]!.name='Changed';edited.zones[0]!.version=2;edited.counter_bindings[0]!.zone_version=2;
 await f.save(edited,3);
 await expect(f.restore(newGuard)).rejects.toMatchObject({code:'ptz_view_rearming_required'});
}));

it.skipIf(!enabled)('another processor save cannot certify it or invalidate an unchanged confirmed scope; detached aliases do not block',async()=>isolated(async db=>{
 const f=await fixture(db);await f.confirm();await f.save(f.doc('other'),2);
 const c=await db.connect();try{
  await c.query('BEGIN');await c.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
  await expect(confirmation.assertCurrentViewConfirmations(c,'motor',['cam'],['ai','other'],[sourceEvidence('cam',['ai','other'])])).rejects.toMatchObject({code:'ptz_view_rearming_required'});
  await c.query('ROLLBACK');
 }finally{c.release();}
 // Current graph excludes the detached output. Its old metadata/guard alias is not a current scope.
 await f.restore(f.revision,['ai']);
}));

it.skipIf(!enabled)('all current processor scopes can confirm independently despite source-wide manual revisions',async()=>isolated(async db=>{
 const f=await fixture(db);await f.confirm();await f.save(f.doc('other'),2);await f.confirm('other',3);
 await f.restore(f.revision,['ai','other']);
}));

it.skipIf(!enabled)('migrated historical monitors do not block, but actually published legacy bindings require migration',async()=>isolated(async db=>{
 const f=await fixture(db);await f.confirm();
 await db.query("INSERT INTO alarm_monitors(monitor_id,channel_id,version,document) VALUES('legacy','cam',1,$1)",[{state:'enabled'}]);
 const legacy={trigger_id:'legacy',state:'enabled',bindings:[{channel_id:'ai',input_stream_id:'cam'}]};
 await db.query("INSERT INTO alarm_triggers(trigger_id,version,document) VALUES('legacy',1,$1)",[legacy]);
 await expect(f.restore()).rejects.toMatchObject({code:'ptz_legacy_rearming_required'});
 await db.query("UPDATE alarm_triggers SET document=$1",[{...legacy,bindings:[{channel_id:'cam'}]}]);
 await expect(f.restore()).rejects.toMatchObject({code:'ptz_legacy_rearming_required'});
 await db.query("UPDATE alarm_triggers SET document=$1",[{...legacy,state:'paused'}]);
 await f.restore();
}));

it.skipIf(!enabled)('available ONVIF pose is persisted and external movement with unchanged guard epoch refuses restoration',async()=>isolated(async db=>{
 const f=await fixture(db),pose={position:{Pan:0,Tilt:0,Zoom:.2,PanTiltSpace:'pt',ZoomSpace:'z'},panTilt:'IDLE',zoom:'IDLE'};
 f.setPose(pose);await f.confirm();
 expect((await db.query('SELECT pose FROM ptz_arming_confirmations')).rows[0].pose).toEqual(pose);
 const epoch=(await f.scenes.stamp('cam')).epoch;
 for(const current of [null,{...pose,position:{...pose.position,Pan:.2}},{...pose,panTilt:'MOVING'}])
  await expect(f.restore(f.revision,['ai'],current,true)).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 expect((await f.scenes.stamp('cam')).epoch).toBe(epoch);
 await f.restore(f.revision,['ai'],pose,true);
}));

it.skipIf(!enabled)('ONVIF requiring position cannot use a receipt without pose; GB null-pose confirmation remains available',async()=>isolated(async db=>{
 const f=await fixture(db);await f.confirm();
 await expect(f.restore(f.revision,['ai'],null,true)).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 await f.restore(f.revision,['ai'],null,false);
}));

async function waitForLock(db:Pool){
 await vi.waitFor(async()=>{
  const {rows}=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT revision FROM alarm_configuration_revision%'");
  expect(rows.length).toBeGreaterThan(0);
 },{timeout:3000,interval:10});
}
it.skipIf(!enabled)('shared motor aliases validate their own identities and require coverage for every current source',async()=>isolated(async db=>{
 const main=await fixture(db),sub=await fixture(db,'sub');sub.setIdentity('sub-profile');
 await main.confirm();await sub.confirm();
 const verify=(evidence:confirmation.CurrentViewSource[])=>main.ptz.restore('motor',sub.revision,'operator',null,
  c=>confirmation.assertCurrentViewConfirmations(c,'motor',['cam','sub'],['ai'],evidence));
 await expect(verify([sourceEvidence()])).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 await expect(verify([sourceEvidence(),sourceEvidence('sub')])).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 await expect(verify([sourceEvidence(),sourceEvidence('sub',['different'],'sub-profile')])).rejects.toMatchObject({code:'ptz_view_rearming_required'});
 await verify([sourceEvidence(),sourceEvidence('sub',['ai'],'sub-profile')]);
}));

async function formalFixture(db:Pool){
 const f=await fixture(db),frame=await f.freeze();
 await db.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,
  reference_points,identity,resource,geometry_revision,epoch,state,reason,binding_mode)
  SELECT source_id,processor_id,'zone-ai',1,frame_id,$2,identity,resource,geometry_revision,epoch,'pending','test','preset'
  FROM arming_scene_frames WHERE frame_id=$1`,[frame.frame_id,JSON.stringify(points)]);
 return {f,frame};
}
it.skipIf(!enabled).each(['remove','add','direction','reclassify','move-zone'])(
 'ordinary confirmation rejects formal counter association mutation: %s',async kind=>isolated(async db=>{
 const {f,frame}=await formalFixture(db),doc:any=f.doc();
 if(kind==='remove')doc.counter_bindings=[];
 if(kind==='add')doc.counter_bindings.push({...doc.counter_bindings[0],binding_id:'flow-added',counter_id:'other-counter'});
 if(kind==='direction')doc.counter_bindings[0].direction={kind:'edges',entry:['a'],exit:['c']};
 if(kind==='reclassify')doc.counter_bindings[0].reclassify_history=true;
 if(kind==='move-zone'){
  doc.zones.push({...doc.zones[0],zone_id:'ordinary',name:'Ordinary'});doc.counter_bindings[0].zone_id='ordinary';
 }
 await expect(f.save({...doc,current_view_confirmation:{frame_id:frame.frame_id}},1)).rejects.toMatchObject({code:'scene_changed'});
 expect((await f.arming.snapshot()).rules).toHaveLength(1);
 expect((await f.scenes.stamp('cam')).manual).toBe(1);
}));
it.skipIf(!enabled).each(['remove','add','edit'])(
 'ordinary confirmation rejects formal alarm association mutation: %s',async kind=>isolated(async db=>{
 const {f,frame}=await formalFixture(db),doc:any=f.doc();
 const assignment={assignment_id:'selection',trigger_id:'alarm',input_stream_id:'cam',processor_id:'ai',zone_id:'zone-ai',
  zone_version:1,geometry_revision:'g',label_map_version:'lm',entry_edges:['d'],exit_edges:['b']};
 doc.assignments=[assignment];
 // Seed a previously saved association; rejection must precede compilation or any write.
 await db.query('UPDATE alarm_arming_sources SET document=$1 WHERE source_id=$2',[doc,'cam']);
 if(kind==='remove')doc.assignments=[];
 if(kind==='add')doc.assignments.push({...assignment,assignment_id:'added',trigger_id:'other-alarm'});
 if(kind==='edit')doc.assignments[0]={...assignment,entry_edges:['a']};
 await expect(f.save({...doc,current_view_confirmation:{frame_id:frame.frame_id}},1)).rejects.toMatchObject({code:'scene_changed'});
 expect((await f.scenes.stamp('cam')).manual).toBe(1);
}));
it.skipIf(!enabled)('ordinary zones remain editable while formal geometry and counter associations are preserved',async()=>isolated(async db=>{
 const {f,frame}=await formalFixture(db),doc:any=f.doc();
 doc.zones.push({...doc.zones[0],zone_id:'ordinary',name:'New ordinary zone'});
 doc.counter_bindings.push({...doc.counter_bindings[0],binding_id:'flow-ordinary',zone_id:'ordinary'});
 await f.save({...doc,current_view_confirmation:{frame_id:frame.frame_id}},1);
 expect((await f.arming.snapshot()).rules).toHaveLength(2);
 expect((await f.scenes.rows('cam','ai'))).toHaveLength(1);
}));
it.skipIf(!enabled)('movement owning the config lock first rejects a confirmation that passed preflight',async()=>isolated(async db=>{
 const f=await fixture(db),frame=await f.freeze(),mover=await db.connect();
 await mover.query('BEGIN');await mover.query('SELECT revision FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
 await mover.query("UPDATE ptz_view_guards SET revision=revision+1,stop_pending=true WHERE resource_key='motor'");
 const saving=f.save({...f.doc(),current_view_confirmation:{frame_id:frame.frame_id}},1).then(()=>null,e=>e);
 try{await waitForLock(db);await mover.query('COMMIT');expect(await saving).toMatchObject({code:'current_view_confirmation_stale'});
  expect((await db.query('SELECT * FROM ptz_arming_confirmations')).rowCount).toBe(0);
  expect((await f.scenes.stamp('cam')).manual).toBe(1);
 }finally{await mover.query('ROLLBACK');mover.release();await saving;}
}));

it.skipIf(!enabled)('confirmation owning the config lock first commits, but the next movement invalidates recovery',async()=>isolated(async db=>{
 const f=await fixture(db),frame=await f.freeze();
 let entered!:()=>void,release!:()=>void;
 const inside=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const real=confirmation.recordCurrentViewConfirmation;
 vi.spyOn(confirmation,'recordCurrentViewConfirmation').mockImplementation(async(...args)=>{await real(...args);entered();await gate;});
 const saving=f.save({...f.doc(),current_view_confirmation:{frame_id:frame.frame_id}},1);
 await inside;const movement=f.block();
 try{await waitForLock(db);}finally{release();}
 await saving;const revision=await movement;
 await expect(f.restore(revision)).rejects.toMatchObject({code:'ptz_view_rearming_required'});
}));
