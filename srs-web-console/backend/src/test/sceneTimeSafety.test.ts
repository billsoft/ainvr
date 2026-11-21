import {expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../store/migrator.js';
import {ArmingScenes} from '../store/armingScenes.js';
import {ArmingSceneRuntime} from '../services/armingSceneRuntime.js';
import Fastify from 'fastify';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {alarmArmingRoutes} from '../routes/alarmArmingRoutes.js';
import {PtzManager} from '../services/ptzManager.js';
import type {PtzStore} from '../store/ptzStore.js';
import type {PtzAdapter} from '../services/ptzAdapter.js';
import type {Channel} from '../types/channel.js';
import {PtzGuardedSnapshot} from '../services/ptzGuardedSnapshot.js';

const enabled=!!process.env.AINVR_SCENE_PG_PORT;
const points:[number,number][]=[[.3,.3],[.6,.3],[.6,.6],[.3,.6]];
const pose={position:{Pan:0,Tilt:0,Zoom:.2,PanTiltSpace:'pt',ZoomSpace:'z'},panTilt:'IDLE',zoom:'IDLE'};
const native={schema:'ainvr.scene-match.v2',localEvidence:'s'.repeat(128*96),matched:true,backend:'neuflow-bpu',candidateCount:800,inliers:800,
 supportGrid:{columns:8,rows:6,cells:Array<boolean>(48).fill(true)},coverage:1,reprojectionErrorPx:.2,
 supportBounds:[.02,.02,.98,.98],homography:[1,0,0,0,1,0,0,0,1]};
function managerFixture(db:Pool){
 const root:Channel={id:'cam',name:'Camera',streamName:'cam',upstreamProtocol:'rtsp',downstreamProtocols:['flv'],inputGeneration:'g1',
  onvif:{deviceId:'device',deviceVersion:1,service:'media1',profileToken:'main',videoSource:'sensor'},createdAt:1,updatedAt:1};
 let revision=0,position=structuredClone(pose),name='Home',stopConfirmed=true,listMode:'present'|'missing'|'failure'='present';
 const calls:string[]=[];
 const store={pool:db,settings:async()=>({settings:{enabled:true,capacity:4,leaseMs:10000}}),
  camera:async()=>({revision:0,settings:{enabled:true,panTilt:true,zoom:true,presets:true}}),
  guard:async()=>({revision,stop_pending:false,blocked:true}),block:async()=>++revision,
  record:async()=>{},stopped:async()=>{},invalidateCalibration:async()=>{},guards:async()=>[],
  presets:async()=>[{id:'1',name,position:pose}],checkPresetShortcut:async()=>{},
  savePreset:async()=>{},removePreset:async()=>{},updatePresetMetadata:async(_r:string,_id:string,value:string)=>{name=value;},
 } as unknown as PtzStore;
 const adapter:PtzAdapter={resource:'motor',protocol:'onvif',identity:'binding',caps:{panTilt:true,zoom:true,presets:true,presetWrite:true,position:true,moveStatus:true},
  call:async(action,body)=>{calls.push(action);if(action==='presets'){if(listMode==='failure')throw Error('query unavailable');return listMode==='present'?[{id:'1',name}]:[];}if(action==='status')return position;
   if(action==='preset-save')return {id:'1'};return {stopConfirmed:body?.command?stopConfirmed:true};}};
 const manager=new PtzManager(store,{presetBindings:true,channels:async()=>[root],ai:async()=>[],prepare:async()=>adapter,
  synchronize:async()=>({state:'applied'}),resetProcessors:async()=>{} });
 return {manager,adapter,root,calls,list:(mode:typeof listMode)=>{listMode=mode;},position:(v:typeof pose)=>{position=v;},stopFails:()=>{stopConfirmed=false;},bump:()=>{revision++;}};
}
async function isolated(run:(db:Pool)=>Promise<void>){
 const config={host:'127.0.0.1',port:Number(process.env.AINVR_SCENE_PG_PORT),user:'postgres',database:'scene_test'};
 const admin=new Pool(config),schema='scene_time_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);
 const db=new Pool({...config,options:'-c search_path='+schema});
 try{await runMigrations(db);await run(db);}
 finally{await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
}
async function fixture(db:Pool,formal=false){
 const store=new ArmingScenes(db),frame=randomUUID();
 const camera={identity:'dev',resource:'motor',app:'live',stream:'controlled-test-only',idle:true,pose:structuredClone(pose) as unknown};
 let captures=0,matches=0,failed=false,oldTime=false,inconsistent=false,losePose=false;
 let matchOverride:unknown;
 const home={resource:'motor',motor:'motor',identity:'dev',preset_id:'1',preset_name:'Home',preset_fingerprint:'a'.repeat(64),definition_version:randomUUID(),pose};
 let presetFailure:string|undefined;
 let captureGate:(()=>Promise<void>)|undefined;
 const deps:ConstructorParameters<typeof ArmingSceneRuntime>[1]={
  experimentalProjection:!formal,
  presetCapability:async()=>({presetBindingAvailable:formal,presetBindingReason:''}),
  preset:async(_id,selection)=>{if(presetFailure)throw {code:presetFailure};if(selection.preset_fingerprint!==home.preset_fingerprint)throw {code:'ptz_preset_changed'};return structuredClone(home);},
  source:async()=>({...camera}),geometry:async()=>({width:512,height:384,geometry_revision:'g'}),
  capture:async()=>{captures++;await captureGate?.();if(failed)throw Error('controlled_capture_unavailable');if(losePose)camera.pose=null;
   return {w:512,h:384,bytes:Buffer.from('controlled-frame-'+captures),at:new Date(Date.now()-(oldTime?60000:0))};},
  match:async()=>{matches++;return matchOverride??(inconsistent&&matches%2===0?{...native,homography:[1,0,.04,0,1,0,0,0,1]}:native);},
  images:{read:async()=>Buffer.from('reference'),cleanup:async()=>{},publish:async()=>({ref:'controlled-reference',w:512,h:384,sha256:'a'.repeat(64),generation:'test'})},
 };
 const runtime=new ArmingSceneRuntime(store,deps);
 const stamp=await store.stamp('cam');
 await db.query("INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,geometry_revision,captured_at,image,manual_revision,items) VALUES($1,'cam','ai','operator','dev','motor',$2,'g',now(),'{}',0,'[]')",[frame,stamp.epoch]);
 await db.query("INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason,checked_at) VALUES('cam','ai','zone',1,$1,$2,'dev','motor','g',$3,'pending','test',now()-interval '4 seconds')",[frame,JSON.stringify(points),stamp.epoch]);
 if(formal){
  await db.query('INSERT INTO arming_preset_definitions(resource,preset_id,version) VALUES($1,$2,$3)',[home.resource,home.preset_id,home.definition_version]);
  await db.query("UPDATE arming_scene_frames SET binding_mode='preset',preset_home=$1,pose=$2",[home,pose]);
  await db.query("UPDATE arming_scene_zones SET binding_mode='preset',preset_home=$1",[home]);
 }
 const row=async()=>(await store.rows('cam','ai'))[0]!;
 const matched=async()=>store.result(await row(),0,stamp.epoch,points,'',pose,{fixture:true});
 const age=async(seconds:number)=>{await db.query("UPDATE arming_scene_zones SET checked_at=now()-$1*interval '1 second'",[seconds]);};
 return {store,runtime,camera,row,matched,age,frame,home,presetFail:(code:string)=>{presetFailure=code;},defaultRuntime:()=>new ArmingSceneRuntime(store,{...deps,experimentalProjection:false}),another:()=>new ArmingSceneRuntime(store,deps),gate:(fn:()=>Promise<void>)=>{captureGate=fn;},result:(value:unknown)=>{matchOverride=value;},counts:()=>({captures,matches}),fail:()=>{failed=true;},old:()=>{oldTime=true;},move:()=>{inconsistent=true;},losePose:()=>{losePose=true;}};
}
it.skipIf(!enabled)('preset goto proof survives confirmed stop, excludes rename and rejects actor, epoch and source changes',async()=>isolated(async db=>{
 const f=managerFixture(db);let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
 try{
  const first=(await f.manager.presets('cam')).items[0] as any;expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const selection={binding_mode:'preset' as const,preset_id:'1',preset_fingerprint:first.fingerprint};
  await expect(f.manager.scenePreset('cam',selection,'operator')).rejects.toMatchObject({code:'ptz_preset_goto_required'});
  const info=await f.manager.inspect('cam'),lease=await f.manager.acquire('cam','operator',info.identity!);
  const zero={pan:0,tilt:0,zoom:0};await f.manager.command('cam',lease.sessionId,'operator',1,zero,'1');
  now+=1100;await f.manager.command('cam',lease.sessionId,'operator',2,zero,undefined,true);
  now+=600;const arrived=await f.manager.command('cam',lease.sessionId,'operator',3,zero,undefined,true);expect(arrived.motionFinished).toBe(true);
  expect(await f.manager.scenePreset('cam',selection,'operator')).toMatchObject({preset_id:'1',preset_fingerprint:first.fingerprint});
  await expect(f.manager.scenePreset('cam',selection,'other')).rejects.toMatchObject({code:'ptz_preset_goto_required'});
  await f.manager.updatePresetMetadata('cam','operator','1',{name:'Renamed',shortcut:null});
  expect((await f.manager.presets('cam')).items[0]).toMatchObject({fingerprint:first.fingerprint,name:'Renamed'});
  f.bump();await expect(f.manager.scenePreset('cam',selection,'operator')).rejects.toMatchObject({code:'ptz_preset_goto_required'});
  f.root.inputGeneration='changed';await expect(f.manager.scenePreset('cam',selection)).rejects.toMatchObject({code:'ptz_preset_changed'});
 }finally{clock.mockRestore();await f.manager.close();}
}));
it.skipIf(!enabled)('manual stop without arrival cannot mint a formal freeze proof; GB remains unavailable',async()=>isolated(async db=>{
 const f=managerFixture(db);
 try{
  const preset=(await f.manager.presets('cam')).items[0] as any,info=await f.manager.inspect('cam');
  const lease=await f.manager.acquire('cam','operator',info.identity!);
  await f.manager.command('cam',lease.sessionId,'operator',1,{pan:0,tilt:0,zoom:0},'1');
  await f.manager.stop('cam',lease.sessionId,'operator');
  await expect(f.manager.scenePreset('cam',{binding_mode:'preset',preset_id:'1',preset_fingerprint:preset.fingerprint},'operator')).rejects.toMatchObject({code:'ptz_preset_goto_required'});
  f.adapter.protocol='gb28181';expect(await f.manager.presetBindingCapability('cam')).toMatchObject({presetBindingAvailable:false});
 }finally{await f.manager.close();}
}));
it.skipIf(!enabled)('confirmed missing preset rotates once, query failure only pauses, same ID reappearance cannot revive fingerprint',async()=>isolated(async db=>{
 const f=managerFixture(db);
 try{
  const first=(await f.manager.presets('cam')).items[0] as any;
  const definition=async()=>(await db.query('SELECT * FROM arming_preset_definitions')).rows[0];
  const before=await definition();f.list('failure');expect((await f.manager.presets('cam')).reason).toBeTruthy();expect(await definition()).toEqual(before);
  f.list('present');expect((await f.manager.presets('cam')).items[0]).toMatchObject({fingerprint:first.fingerprint});
  f.list('missing');await f.manager.presets('cam');const absent=await definition();expect(absent.present).toBe(false);expect(absent.version).not.toBe(before.version);
  await f.manager.presets('cam');expect(await definition()).toEqual(absent);
  f.list('present');const returned=(await f.manager.presets('cam')).items[0] as any;
  expect(returned.fingerprint).not.toBe(first.fingerprint);expect((await definition()).version).toBe(absent.version);
  await expect(f.manager.scenePreset('cam',{binding_mode:'preset',preset_id:'1',preset_fingerprint:first.fingerprint})).rejects.toMatchObject({code:'ptz_preset_changed'});
 }finally{await f.manager.close();}
}));
it.skipIf(!enabled)('300-device preset reconciliation uses bounded queries and does not rewrite unchanged definitions',async()=>isolated(async db=>{
 let queries=0;
 const counted={query:db.query.bind(db),connect:async()=>{
  const c=await db.connect();return {query:(...args:any[])=>{queries++;return (c.query as any)(...args);},release:()=>c.release()};
 }} as unknown as Pool;
 const f=managerFixture(counted),original=f.adapter.call;
 f.adapter.call=async(action,body)=>action==='presets'?Array.from({length:301},(_,i)=>({id:String(i+1),name:'Preset '+(i+1)})):original(action,body);
 try{
  await f.manager.presets('cam');expect(queries).toBeLessThanOrEqual(8);
  const rows=async()=>(await db.query('SELECT preset_id,version,present,xmin::text AS xmin FROM arming_preset_definitions ORDER BY preset_id')).rows;
  const before=await rows();expect(before).toHaveLength(301);queries=0;
  await f.manager.presets('cam');expect(queries).toBeLessThanOrEqual(8);expect(await rows()).toEqual(before);
 }finally{await f.manager.close();}
}));
it.skipIf(!enabled)('missing preset invalidates pending row CAS and configuration so in-flight old match cannot revive it',async()=>isolated(async db=>{
 const f=await fixture(db,true),m=managerFixture(db);
 try{
  await m.manager.presets('cam');const old=await f.row(),stamp=await f.store.stamp('cam');
  const config=async()=>Number((await db.query('SELECT revision FROM alarm_configuration_revision WHERE singleton')).rows[0].revision);
  const before=await config();m.list('missing');await m.manager.presets('cam');const invalid=await f.row();
  expect(invalid).toMatchObject({state:'pending',current_points:null,visual_checked_at:null});expect(invalid.revision).not.toBe(old.revision);expect(await config()).toBe(before+1);
  await f.store.result(old,stamp.manual,stamp.epoch,points,'',pose,{captured_at:new Date().toISOString()});expect(await f.row()).toEqual(invalid);
  await m.manager.presets('cam');expect(await f.row()).toEqual(invalid);expect(await config()).toBe(before+1);
 }finally{await m.manager.close();}
}));
it.skipIf(!enabled).each([null,{...pose,position:{...pose.position,Pan:.2}}])('independent home success cannot authorize missing or alternate capture context pose %j',async badPose=>isolated(async db=>{
 const f=await fixture(db,true);f.camera.pose=badPose;
 await f.runtime.tick();expect((await f.row()).state).not.toBe('matched');expect(f.counts().captures).toBe(0);
 const selection={binding_mode:'preset' as const,preset_id:'1',preset_fingerprint:f.home.preset_fingerprint};
 await expect(f.runtime.freeze('cam','ai','operator',selection)).rejects.toMatchObject({statusCode:409});
 await expect(f.runtime.prove('cam','ai','operator',0,[{zone_id:'zone',mode:'edit',expected_revision:(await f.row()).revision,frame_id:f.frame}], [{zone_id:'zone',points}])).rejects.toMatchObject({statusCode:409});
}));
it.skipIf(!enabled)('pose lost during capture cannot be joined to separate successful home observation',async()=>isolated(async db=>{
 const f=await fixture(db,true);f.gate(async()=>{f.camera.pose=null;});await f.runtime.tick();
 expect(await f.row()).toMatchObject({current_points:null,visual_checked_at:null});expect((await f.row()).state).not.toBe('matched');
}));
it.skipIf(!enabled).each(['tick','freeze','prove'] as const)('absolute home pose tolerance is enforced after capture in %s',async action=>isolated(async db=>{
 const f=await fixture(db,true);f.camera.pose={...pose,position:{...pose.position,Pan:.00009}};
 f.gate(async()=>{f.camera.pose={...pose,position:{...pose.position,Pan:.00018}};});
 if(action==='tick'){
  await f.runtime.tick();expect((await f.row()).state).not.toBe('matched');
 }else if(action==='freeze'){
  await expect(f.runtime.freeze('cam','ai','operator',{binding_mode:'preset',preset_id:'1',preset_fingerprint:f.home.preset_fingerprint})).rejects.toMatchObject({statusCode:409});
 }else await expect(f.runtime.prove('cam','ai','operator',0,[{zone_id:'zone',mode:'edit',expected_revision:(await f.row()).revision,frame_id:f.frame}],[{zone_id:'zone',points}])).rejects.toMatchObject({statusCode:409});
}));
it.skipIf(!enabled).each([null,{...pose,position:{...pose.position,Pan:.2}}])('matched row cannot publish stale or absent stored pose %j',async badPose=>isolated(async db=>{
 const f=await fixture(db,true);await f.runtime.tick();await db.query('UPDATE arming_scene_zones SET pose=$1',[badPose]);
 expect((await f.runtime.read('cam','ai')).items[0]?.current_points).toBeNull();await f.runtime.checkBindings();expect(await f.row()).toMatchObject({state:'pending',current_points:null});
}));
it.skipIf(!enabled)('bound preset cannot be overwritten or deleted, and metadata rename retains fingerprint',async()=>isolated(async db=>{
 const f=managerFixture(db);await fixture(db,true);
 try{
  await expect(f.manager.savePreset('cam','operator',{id:'1',name:'Override',shortcut:null})).rejects.toMatchObject({code:'ptz_preset_bound_unbind_first',statusCode:409});
  await expect(f.manager.removePreset('cam','operator','1')).rejects.toMatchObject({code:'ptz_preset_bound_unbind_first',statusCode:409});
  expect(f.calls).not.toContain('preset-save');expect(f.calls).not.toContain('preset-remove');
  await db.query('DELETE FROM arming_scene_zones');const before=(await f.manager.presets('cam')).items[0] as any;
  await f.manager.savePreset('cam','operator',{id:'1',name:'New position',shortcut:null});
  expect((await f.manager.presets('cam')).items[0]).not.toMatchObject({fingerprint:before.fingerprint});
 }finally{await f.manager.close();}
}));
it.skipIf(!enabled)('formal preset uses two checks and canonical points; pose departure stops before capture',async()=>isolated(async db=>{
 const f=await fixture(db,true);await f.runtime.tick();expect(f.counts()).toEqual({captures:2,matches:2});
 expect(await f.row()).toMatchObject({state:'matched',current_points:points,binding_mode:'preset'});
 const before=await f.row();await db.query("INSERT INTO ptz_presets(resource_key,preset_id,name) VALUES('motor','1','Renamed Home')");
 expect((await f.runtime.read('cam','ai')).items[0]).toMatchObject({preset_name:'Renamed Home',preset_fingerprint:f.home.preset_fingerprint});expect(await f.row()).toEqual(before);
 f.presetFail('ptz_preset_not_arrived');await f.age(21);await f.runtime.tick();
 expect(f.counts()).toEqual({captures:2,matches:2});expect(await f.row()).toMatchObject({state:'unmatched',current_points:null,visual_checked_at:null,reason:'已离开布防视角'});
}));
it.skipIf(!enabled)('formal unsupported preset is explicitly unavailable and cannot use arbitrary projection',async()=>isolated(async db=>{
 const f=await fixture(db,true);f.presetFail('ptz_preset_changed');await f.runtime.tick();
 expect(f.counts().captures).toBe(0);expect((await f.row()).reason).toContain('布防预置位不可用');
 expect((await f.runtime.read('cam','ai')).items[0]).toMatchObject({unavailable:true,current_points:null});
}));
it.skipIf(!enabled)('current-mode freeze cannot display a preset match without home verification',async()=>isolated(async db=>{
 const f=await fixture(db,true);f.presetFail('ptz_preset_not_arrived');
 const frame=await f.runtime.freeze('cam','ai','operator');
 expect(frame.binding_mode).toBe('current');expect(frame.items[0]).toMatchObject({current_points:null});
 expect(frame.items[0]!.state).not.toBe('matched');expect(f.counts().matches).toBe(0);
 await expect(f.runtime.prove('cam','ai','operator',0,[{zone_id:'zone',mode:'unbind',expected_revision:(await f.row()).revision,frame_id:frame.frame_id,binding_mode:'preset'}],[{zone_id:'zone',points}])).rejects.toMatchObject({code:'scene_preset_required'});
}));
it.skipIf(!enabled)('API rejects all-unbind on unmatched frozen frame and retains protection',async()=>isolated(async db=>{
 const f=await fixture(db,true),arming=new AlarmArmingStore(db,()=>f.runtime),app=Fastify();
 const row=await f.row();
 await db.query('UPDATE arming_scene_frames SET items=$1',[JSON.stringify([{zone_id:'zone',revision:row.revision,state:'unmatched',current_points:null}])]);
 await app.register(alarmArmingRoutes,{store:arming,scenes:f.runtime,principal:async()=>'operator',catalog:async()=>{throw Error('must reject before catalog');},sourceGeometry:async()=>'g',synchronization:null});
 try{
  const response=await app.inject({method:'POST',url:'/alarms/arming/cam',headers:{'idempotency-key':'unsafe-unbind'},payload:{expected_revision:0,arming:{source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[{zone_id:'zone',processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'zone',points,edge_ids:['a','b','c','d']}],assignments:[],scene_edits:[{zone_id:'zone',mode:'unbind',expected_revision:row.revision,frame_id:f.frame,binding_mode:'preset'}]}}});
  expect(response.statusCode,response.body).toBe(409);expect(await f.row()).toEqual(row);
  expect((await db.query('SELECT count(*)::int AS n FROM alarm_config_operations')).rows[0].n).toBe(0);
 }finally{await app.close();}
}));
it.skipIf(!enabled)('legacy scene authorization is disabled by default without deleting history or reference',async()=>isolated(async db=>{
 const f=await fixture(db);await f.matched();const runtime=f.defaultRuntime();
 expect((await runtime.read('cam','ai')).items[0]).toMatchObject({state:'pending',current_points:null});
 await runtime.checkBindings();await runtime.tick();expect(f.counts().captures).toBe(0);
 expect(await f.row()).toMatchObject({state:'pending',reference_frame_id:f.frame});
 expect((await db.query('SELECT count(*)::int AS n FROM arming_scene_history')).rows[0].n).toBeGreaterThan(0);
}));
it.skipIf(!enabled)('formal rule application preserves count identity and pauses missing evidence without inventing zero',async()=>isolated(async db=>{
 const f=await fixture(db,true);await f.runtime.tick();
 const rule={state:'enabled',channel_id:'ai',input_stream_id:'cam',zone_id:'zone',zone_version:1,geometry_revision:'g',points,counter_id:'count-1'};
 const snapshot=new PtzGuardedSnapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules:[rule]})},db,undefined,f.store,()=>f.runtime.checkBindings());
 const first=(await snapshot.snapshot()).rules[0] as any;expect(first).toMatchObject({state:'enabled',points,counter_id:'count-1'});
 await f.age(21);await f.runtime.tick();expect(((await snapshot.snapshot()).rules[0] as any).view_epoch).toBe(first.view_epoch);
 f.presetFail('ptz_preset_not_arrived');const paused=(await snapshot.snapshot()).rules[0] as any;
 expect(paused).toMatchObject({state:'paused',counter_id:'count-1'});expect(paused).not.toHaveProperty('count');expect(paused.view_epoch).not.toBe(first.view_epoch);
}));
it.skipIf(!enabled)('formal frame allows first-save new zone binding with CAS and rejects changed definition',async()=>isolated(async db=>{
 const f=await fixture(db,true);await db.query('DELETE FROM arming_scene_zones');
 const arming=new AlarmArmingStore(db,()=>f.runtime),selection={binding_mode:'preset' as const,preset_id:'1',preset_fingerprint:f.home.preset_fingerprint};
 const frame=await f.runtime.freeze('cam','ai','operator',selection);
 const zone={zone_id:'new-zone',processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'New zone',points,edge_ids:['a','b','c','d']};
 const document={source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[zone],assignments:[],counter_bindings:[],scene_edits:[{zone_id:zone.zone_id,mode:'bind',expected_revision:0,frame_id:frame.frame_id,binding_mode:'preset'}]};
 const catalog={input_stream_id:'cam',channel_id:'ai',geometry_revision:'g',label_map_version:'lm',width:512,height:384,labels:[],tracking_available:true,observed_at:new Date().toISOString(),stream_fingerprint:'a'.repeat(64)};
 await arming.saveArming(document,0,'operator','new-formal',async()=>catalog,async()=>'g');
 const saved=(await f.store.rows('cam','ai'))[0]!;expect(saved).toMatchObject({zone_id:'new-zone',zone_version:1,binding_mode:'preset',reference_points:points});
 expect(saved.preset_home).toMatchObject({preset_id:'1',preset_fingerprint:f.home.preset_fingerprint});
 // A different processor on the same motor cannot bind an incompatible home.
 const conflicting={...f.home,preset_id:'other',preset_fingerprint:'b'.repeat(64)};
 await db.query("INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason,binding_mode,preset_home) VALUES('other-source','other-ai','other-zone',1,$1,$2,'dev','motor','g',$3,'pending','test','preset',$4)",[f.frame,JSON.stringify(points),(await f.store.stamp('cam')).epoch,conflicting]);
 const conflictFrame=await f.runtime.freeze('cam','ai','operator',selection);
 await expect(arming.saveArming({...document,scene_edits:[{...document.scene_edits[0],mode:'edit',frame_id:conflictFrame.frame_id,expected_revision:saved.revision}]},1,'operator','motor-conflict',async()=>catalog,async()=>'g')).rejects.toMatchObject({code:'scene_home_conflict',statusCode:409});
 await db.query("DELETE FROM arming_scene_zones WHERE source_id='other-source'");
 const current=await f.runtime.freeze('cam','ai','operator',selection);
 await db.query('UPDATE arming_preset_definitions SET version=$1',[randomUUID()]);
 const changed={...document,zones:[{...zone,version:2,name:'edited'}],scene_edits:[{...document.scene_edits[0],mode:'edit',frame_id:current.frame_id,expected_revision:saved.revision}]};
 await expect(arming.saveArming(changed,1,'operator','stale-definition',async()=>catalog,async()=>'g')).rejects.toMatchObject({statusCode:409});
 expect((await f.store.rows('cam','ai'))[0]).toEqual(saved);
 // A deliberate whole-zone removal remains possible even if its preset is
 // permanently unavailable; assignments/counters must be removed with it.
 await arming.saveArming({source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[],assignments:[],counter_bindings:[]},1,'operator','delete-zone',async()=>catalog,async()=>'g');
 expect(await f.store.rows('cam','ai')).toEqual([]);
}));
it.skipIf(!enabled)('preset unbind survives only runtime revision transitions after a matched freeze',async()=>isolated(async db=>{
 const f=await fixture(db,true);await db.query('DELETE FROM arming_scene_zones');
 const arming=new AlarmArmingStore(db,()=>f.runtime),selection={binding_mode:'preset' as const,preset_id:'1',preset_fingerprint:f.home.preset_fingerprint};
 const catalog={input_stream_id:'cam',channel_id:'ai',geometry_revision:'g',label_map_version:'lm',width:512,height:384,labels:[],tracking_available:true,observed_at:new Date().toISOString(),stream_fingerprint:'a'.repeat(64)};
 const zone={zone_id:'zone',processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'Draft name',points,edge_ids:['a','b','c','d']};
 const doc={source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[zone],assignments:[],counter_bindings:[]};
 const initial=await f.runtime.freeze('cam','ai','operator',selection);
 await arming.saveArming({...doc,scene_edits:[{zone_id:'zone',mode:'bind',expected_revision:0,frame_id:initial.frame_id,binding_mode:'preset'}]},0,'operator','bind-runtime-cas',async()=>catalog,async()=>'g');
 const pending=await f.row();expect(pending.state).toBe('pending');
 const frame=await f.runtime.freeze('cam','ai','operator',selection);
 expect(frame.items[0]).toMatchObject({state:'matched',revision:pending.revision});
 await f.age(4);await f.runtime.tick();const matched=await f.row();expect(matched.state).toBe('matched');expect(matched.revision).not.toBe(pending.revision);
 const stamp=await f.store.stamp('cam');
 // A later transient pause/recovery is also operational evidence, not an edit.
 await f.store.result(matched,stamp.manual,stamp.epoch,null,'temporary resource failure',null,null);
 await f.age(4);await f.runtime.tick();expect((await f.row()).state).toBe('matched');
 const edit={zone_id:'zone',mode:'unbind',expected_revision:pending.revision,frame_id:frame.frame_id,binding_mode:'preset'};
 await arming.saveArming({...doc,scene_edits:[edit]},1,'operator','unbind-runtime-cas',async()=>catalog,async()=>'g');
 expect(await f.store.rows('cam','ai')).toEqual([]);expect((await arming.readArming('cam','ai')).zones[0]).toMatchObject({zone_id:'zone',name:'Draft name',points});
}));
it.skipIf(!enabled).each(['unmatched','pending','stable-pending','negative-recovered','old-pending','late-matched'] as const)(
 'save proof fence handles late evidence: %s',async scenario=>isolated(async db=>{
 const f=await fixture(db,true);await db.query('DELETE FROM arming_scene_zones');
 const arming=new AlarmArmingStore(db,()=>f.runtime),selection={binding_mode:'preset' as const,preset_id:'1',preset_fingerprint:f.home.preset_fingerprint};
 const catalog={input_stream_id:'cam',channel_id:'ai',geometry_revision:'g',label_map_version:'lm',width:512,height:384,labels:[],tracking_available:true,observed_at:new Date().toISOString(),stream_fingerprint:'a'.repeat(64)};
 const zone={zone_id:'zone',processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'Retain draft',points,edge_ids:['a','b','c','d']};
 const doc={source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[zone],assignments:[],counter_bindings:[]};
 const initial=await f.runtime.freeze('cam','ai','operator',selection);
 await arming.saveArming({...doc,scene_edits:[{zone_id:'zone',mode:'bind',expected_revision:0,frame_id:initial.frame_id,binding_mode:'preset'}]},0,'operator','bind-proof-fence',async()=>catalog,async()=>'g');
 if(scenario!=='stable-pending'&&scenario!=='old-pending'&&scenario!=='late-matched'){await f.age(4);await f.runtime.tick();}
 const before=await f.row(),frame=await f.runtime.freeze('cam','ai','operator',selection);
 expect(frame.items[0]?.state).toBe('matched');
 const realProve=f.runtime.prove.bind(f.runtime);
 const spy=vi.spyOn(f.runtime,'prove').mockImplementation(async(...args)=>{
  const proof=await realProve(...args); // two real controlled captures/matches
  if(scenario==='old-pending')return proof;
  const row=await f.row(),stamp=await f.store.stamp('cam');
  if(scenario==='late-matched'){
   await f.store.result(row,stamp.manual,stamp.epoch,points,'',pose,{captured_at:new Date().toISOString()});return proof;
  }
  await f.store.result(row,stamp.manual,stamp.epoch,null,scenario==='stable-pending'?row.reason:'newer negative evidence',null,null,scenario==='unmatched'?'unmatched':'pending');
  if(scenario==='stable-pending')expect((await f.row()).revision).toBe(row.revision);
  if(scenario==='negative-recovered')await f.store.result(await f.row(),stamp.manual,stamp.epoch,points,'',pose,{captured_at:new Date().toISOString()});
  return proof;
 });
 try{
  const save=arming.saveArming({...doc,scene_edits:[{zone_id:'zone',mode:'unbind',expected_revision:before.revision,frame_id:frame.frame_id,binding_mode:'preset'}]},1,'operator','unbind-proof-fence',async()=>catalog,async()=>'g');
  if(scenario==='old-pending'||scenario==='late-matched'){await save;expect(await f.store.rows('cam','ai')).toEqual([]);}
  else{
   await expect(save).rejects.toMatchObject({code:'scene_changed',statusCode:409});
   expect(await f.row()).toMatchObject({reference_frame_id:before.reference_frame_id,binding_mode:'preset',zone_version:1});
   expect((await arming.readArming('cam','ai')).revision).toBe(1);
   expect((await db.query("SELECT count(*)::int AS n FROM alarm_config_operations WHERE operation_key='unbind-proof-fence'")).rows[0].n).toBe(0);
  }
 }finally{spy.mockRestore();}
}));
it.skipIf(!enabled).each(['reference','points','zone-version','home','identity','resource','geometry','delete-recreate','change-then-restore','missing-history'] as const)(
 'runtime CAS exception rejects changed binding definition: %s',async change=>isolated(async db=>{
 const f=await fixture(db,true),old=await f.row();
 const frame=await f.runtime.freeze('cam','ai','operator',{binding_mode:'preset',preset_id:'1',preset_fingerprint:f.home.preset_fingerprint});
 const original=(await db.query('SELECT * FROM arming_scene_zones WHERE revision=$1',[old.revision])).rows[0];
 const checked=(await db.query('SELECT checked_at::text AS value FROM arming_scene_zones WHERE revision=$1',[old.revision])).rows[0].value;
 if(change==='delete-recreate'){
  await db.query('DELETE FROM arming_scene_zones WHERE revision=$1',[old.revision]);
  const revision=(await db.query("SELECT nextval('arming_scene_revision')::int AS n")).rows[0].n;
  await db.query('INSERT INTO arming_scene_zones SELECT (jsonb_populate_record(NULL::arming_scene_zones,$1)).*',[{...original,revision}]);
 }else{
  const updates:{[key:string]:[string,unknown]}={reference:['reference_frame_id',frame.frame_id],points:['reference_points',JSON.stringify([[.2,.3],[.6,.3],[.6,.6],[.2,.6]])],
   'zone-version':['zone_version',2],home:['preset_home',{...f.home,preset_fingerprint:'b'.repeat(64)}],identity:['identity','other-device'],resource:['resource','other-motor'],geometry:['geometry_revision','other-geometry'],
   'change-then-restore':['zone_version',2],'missing-history':['state','pending']};
  const [column,value]=updates[change]!;
  await db.query(`UPDATE arming_scene_zones SET ${column}=$1,revision=nextval('arming_scene_revision') WHERE source_id='cam'`,[value]);
  if(change==='change-then-restore')await db.query("UPDATE arming_scene_zones SET zone_version=1,revision=nextval('arming_scene_revision') WHERE source_id='cam'");
  if(change==='missing-history')await db.query('DELETE FROM arming_scene_history WHERE revision=$1',[old.revision]);
 }
 const zone={zone_id:'zone',processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,points,edge_ids:['a','b','c','d']};
 const document={source_id:'cam',geometry_revision:'g',zones:[zone],counter_bindings:[]};
 const before=await f.row();
 await expect(f.store.transaction(c=>f.store.save(c,document,document,'ai',[{zone_id:'zone',mode:'unbind',expected_revision:old.revision,frame_id:frame.frame_id,binding_mode:'preset'}],
  'operator',0,{frame_id:frame.frame_id,at:Date.now(),binding_evidence:{zone:{revision:old.revision,checked_at:checked}}}))).rejects.toMatchObject({statusCode:409});
 expect(await f.row()).toEqual(before);
}));
it.skipIf(!enabled)('two runtime workers cannot run hardware concurrently for the same source',async()=>isolated(async db=>{
 const f=await fixture(db);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>{enter=r;}),blocked=new Promise<void>(r=>{release=r;});
 f.gate(async()=>{enter();await blocked;});
 const first=f.runtime.tick();await entered;
 try{
  await f.another().tick().catch(error=>{expect(error.code).toBe('scene_busy');});
  expect(f.counts()).toEqual({captures:1,matches:0});
 }finally{release();await first;}
 expect(f.counts()).toEqual({captures:2,matches:2});
 await f.another().tick();expect(f.counts()).toEqual({captures:2,matches:2});
}));
it.skipIf(!enabled)('stable verification refreshes capture evidence without revision, journal or counting epoch changes; stale CAS cannot overwrite',async()=>isolated(async db=>{
 const f=await fixture(db);await f.runtime.tick();const before=await f.row();
 const evidence=async()=>(await db.query("SELECT evidence FROM arming_scene_zones WHERE source_id='cam'")).rows[0].evidence;
 const counters=async()=>(await db.query("SELECT (SELECT revision FROM alarm_configuration_revision WHERE singleton) AS configuration,(SELECT count(*)::int FROM arming_scene_history) AS history")).rows[0];
 const first=await evidence(),counts=await counters();
 await f.age(21);const started=Date.now();await f.runtime.tick();const after=await f.row(),latest=await evidence();
 expect(after).toMatchObject({state:'matched',revision:before.revision,epoch:before.epoch,changed_at:before.changed_at,current_points:before.current_points});
 expect(await counters()).toEqual(counts);
 expect(Date.parse(latest.captured_at)).toBeGreaterThan(Date.parse(first.captured_at));
 expect(Date.parse(latest.captured_at)).toBeGreaterThanOrEqual(started);
 expect(after.visual_checked_at!.getTime()).toBeGreaterThanOrEqual(Date.parse(latest.captured_at));
 expect(after.visual_checked_at!.getTime()-Date.parse(latest.captured_at)).toBeLessThan(5000);
 // A real state change advances CAS; a delayed result using the old revision
 // must not overwrite either the new evidence or its authorization timestamp.
 const stamp=await f.store.stamp('cam'),newEvidence={captured_at:new Date().toISOString(),marker:'newer-state'};
 await f.store.result(after,stamp.manual,stamp.epoch,null,'test pending',null,newEvidence);
 const pending=await f.row(),pendingCounts=await counters();
 expect(pending.revision).not.toBe(after.revision);
 await f.store.result(after,stamp.manual,stamp.epoch,points,'',pose,{captured_at:'2000-01-01T00:00:00.000Z',marker:'stale'});
 expect(await f.row()).toEqual(pending);expect(await evidence()).toEqual(newEvidence);expect(await counters()).toEqual(pendingCounts);
}));
it.skipIf(!enabled)('does not renew visual authorization on old repeated IDLE when capture is unavailable',async()=>isolated(async db=>{
 const f=await fixture(db);await f.matched();await f.age(21);f.fail();
 const before=await f.row();await f.runtime.tick();const after=await f.row();
 expect(f.counts().captures).toBe(1);
 expect(after).toMatchObject({state:'pending',current_points:null,visual_checked_at:null});
 expect(after.revision).not.toBe(before.revision);
 await f.age(4);await f.runtime.tick();expect((await f.row()).revision).toBe(after.revision);
}));
it.skipIf(!enabled)('repeated IDLE never substitutes for the second visual projection',async()=>isolated(async db=>{
 const f=await fixture(db);f.move();await f.runtime.tick();
 expect(f.counts()).toEqual({captures:2,matches:2});
 expect(await f.row()).toMatchObject({state:'pending',current_points:null});
}));
it.skipIf(!enabled)('five-minute visual expiry hides and invalidates even recently heartbeated rows',async()=>isolated(async db=>{
 const f=await fixture(db);await f.matched();
 await db.query("UPDATE arming_scene_zones SET visual_checked_at=now()-interval '301 seconds',checked_at=now()");
 expect((await f.runtime.read('cam','ai')).items[0]).toMatchObject({state:'pending',current_points:null});
 await f.runtime.checkBindings();expect(await f.row()).toMatchObject({state:'pending',current_points:null});
}));
it.skipIf(!enabled)('pose missing and restored both require visuals; stable results preserve counting epoch',async()=>isolated(async db=>{
 const f=await fixture(db);f.camera.pose=null;await f.runtime.tick();
 expect(f.counts()).toEqual({captures:2,matches:2});const first=await f.row();expect(first.state).toBe('matched');
 f.camera.pose=pose;await f.age(21);await f.runtime.tick();
 expect(f.counts()).toEqual({captures:4,matches:4});expect((await f.row()).revision).toBe(first.revision);
 f.camera.pose=null;await f.runtime.checkBindings();expect((await f.row()).state).toBe('pending');
 await f.age(4);await f.runtime.tick();expect((await f.row()).state).toBe('matched');
 expect(f.counts()).toEqual({captures:6,matches:6});
}));
it.skipIf(!enabled)('does not authorize a capture timestamp from before this request',async()=>isolated(async db=>{
 const f=await fixture(db);f.old();await f.runtime.tick();
 expect(f.counts().matches).toBe(0);expect(await f.row()).toMatchObject({state:'pending',current_points:null});
}));
it.skipIf(!enabled)('pose loss during acquisition fails closed, then visual-only recovery works',async()=>isolated(async db=>{
 const f=await fixture(db);f.losePose();await f.runtime.tick();
 expect(await f.row()).toMatchObject({state:'pending',current_points:null});expect(f.counts().captures).toBe(1);
 await f.age(4);await f.runtime.tick();expect((await f.row()).state).toBe('matched');
 expect(f.counts()).toEqual({captures:3,matches:3});
}));
it.skipIf(!enabled)('expired visual proof schedules verification even if checked_at is recent',async()=>isolated(async db=>{
 const f=await fixture(db);await f.matched();f.fail();
 await db.query("UPDATE arming_scene_zones SET visual_checked_at=now()-interval '301 seconds',checked_at=now()");
 await f.runtime.tick();expect(f.counts().captures).toBe(1);
 expect(await f.row()).toMatchObject({state:'pending',current_points:null});
}));
it.skipIf(!enabled)('missing or future visual timestamps never authorize published geometry',async()=>isolated(async db=>{
 const f=await fixture(db);await f.matched();
 for(const at of [null,new Date(Date.now()+60000)]){
  await db.query('UPDATE arming_scene_zones SET visual_checked_at=$1',[at]);
  expect((await f.runtime.read('cam','ai')).items[0]).toMatchObject({state:'pending',current_points:null});
 }
}));
it.skipIf(!enabled)('unmatched retries remain bounded and recovery requires two new visual checks',async()=>isolated(async db=>{
 const f=await fixture(db);f.result({...native,matched:false});await f.runtime.tick();
 expect(await f.row()).toMatchObject({state:'unmatched',current_points:null});
 for(const seconds of [5,10,20,45,45]){
  const before=f.counts();await f.age(seconds-1);await f.another().tick();expect(f.counts()).toEqual(before);
  await f.age(seconds+1);await f.another().tick();expect(f.counts().captures).toBe(before.captures+1);
  expect(await f.row()).toMatchObject({state:'unmatched',current_points:null,visual_checked_at:null});
 }
 const failed=f.counts();await f.runtime.tick();expect(f.counts()).toEqual(failed);
 await f.age(46);f.result(native);await f.runtime.tick();
 expect(f.counts()).toEqual({captures:failed.captures+2,matches:failed.matches+2});
 expect((await f.row()).state).toBe('matched');
 const recovered=f.counts();await f.runtime.tick();expect(f.counts()).toEqual(recovered);
 await f.age(21);f.result({...native,matched:false});await f.runtime.tick();
 const again=f.counts();await f.age(4);await f.runtime.tick();expect(f.counts()).toEqual(again);
 await f.age(6);await f.runtime.tick();expect(f.counts().captures).toBe(again.captures+1);
}));
it.skipIf(!enabled)('pending failure does not busy loop or renew geometry with repeated IDLE',async()=>isolated(async db=>{
 const f=await fixture(db);f.fail();await f.runtime.tick();const first=f.counts();
 expect(await f.row()).toMatchObject({state:'pending',current_points:null});
 await f.runtime.tick();expect(f.counts()).toEqual(first);
 await f.age(4);await f.runtime.tick();expect(f.counts().captures).toBe(first.captures+1);
 expect(await f.row()).toMatchObject({state:'pending',current_points:null,visual_checked_at:null});
}));
it.skipIf(!enabled).each([
 {name:'no visual match',match:{...native,matched:false},status:422,code:'scene_region_unreliable'},
 {name:'local support rejected',match:{...native,supportGrid:{columns:8,rows:6,cells:Array(48).fill(false)}},status:422,code:'scene_region_unreliable'},
 {name:'local evidence absent',match:{...native,localEvidence:'u'.repeat(128*96)},status:422,code:'scene_region_unreliable'},
 {name:'reliable but displaced',match:{...native,homography:[1,0,.04,0,1,0,0,0,1]},status:409,code:'scene_changed'},
])('proof errors distinguish $name and preserve submitted draft',async({match,status,code})=>isolated(async db=>{
 const f=await fixture(db);f.result(match);
 const arming=new AlarmArmingStore(db,()=>f.runtime),app=Fastify();
 await app.register(alarmArmingRoutes,{store:arming,scenes:f.runtime,principal:async()=> 'operator',
  catalog:async()=>{throw Error('proof failure must precede catalog');},sourceGeometry:async()=> 'g',synchronization:null});
 const draft={expected_revision:0,arming:{source_id:'cam',processor_id:'ai',geometry_revision:'g',
  zones:[{zone_id:'zone',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:'draft name',points,edge_ids:['a','b','c','d']}],
  assignments:[],counter_bindings:[],scene_edits:[{zone_id:'zone',expected_revision:0,mode:'bind',frame_id:f.frame}]}};
 const before=structuredClone(draft),row=await f.row();
 try{
  const response=await app.inject({method:'POST',url:'/alarms/arming/cam',headers:{'idempotency-key':'proof-error-test'},payload:draft});
  expect(response.statusCode,response.body).toBe(status);expect(response.json().error.code).toBe(code);
  if(status===422){
   expect(response.json().error.message).toContain('可能');expect(response.json().error.message).toContain('草稿已保留');
   expect(response.json().error.message).toContain('稳定的背景区域');
  }
  expect(draft).toEqual(before);expect(await f.row()).toEqual(row);
  expect((await db.query('SELECT count(*)::int AS n FROM alarm_config_operations')).rows[0].n).toBe(0);
 }finally{await app.close();}
}));
