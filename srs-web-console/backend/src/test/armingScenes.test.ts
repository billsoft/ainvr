import {expect,it} from 'vitest';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,writeFile,rm,utimes,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {runMigrations} from '../store/migrator.js';
import {FloorPlanImages} from '../services/floorPlanImages.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import {ArmingScenes} from '../store/armingScenes.js';
import {PtzStore} from '../store/ptzStore.js';
import {AlarmArmingStore} from '../store/alarmArmingStore.js';
import {ArmingSceneRuntime} from '../services/armingSceneRuntime.js';
import {PtzGuardedSnapshot} from '../services/ptzGuardedSnapshot.js';
import {alarmArmingRoutes} from '../routes/alarmArmingRoutes.js';
import {projectScene,type ScenePoint} from '../services/sceneProjection.js';
import {jpegDimensions} from '../services/searchContract.js';
import {captureScene} from '../services/sceneCapture.js';
import {PtzManager} from '../services/ptzManager.js';

const points:ScenePoint[]=[[.34,.34],[.56,.34],[.56,.56],[.34,.56]];
const native={schema:'ainvr.scene-match.v2',localEvidence:'s'.repeat(128*96),matched:true,backend:'neuflow-bpu',candidateCount:800,inliers:800,
 supportGrid:{columns:8,rows:6,cells:Array<boolean>(48).fill(true)},
 coverage:1,reprojectionErrorPx:.24,supportBounds:[.02,.03,.96,.94],homography:[1,0,.05,0,1,.01,0,0,1]};
it('validates normalized direct projection, all vertices, finite native evidence and global projective bounds',()=>{
 expect(projectScene(native,points)?.[0]?.[0]).toBeCloseTo(.39);
 for(const invalid of [{matched:false},{backend:'cpu'},{inliers:900},{coverage:.25},{supportBounds:[.4,.2,.8,.8]},
  {homography:[1,0,NaN,0,1,0,0,0,1]},{homography:[1,0,1,0,1,0,0,0,1]},
  {homography:[1,0,0,0,1,0,-1.2,0,1]}])expect(projectScene({...native,...invalid},points)).toBeNull();
});
it('requires every closed grid cell touched by the reference polygon, including interior and edges',()=>{
 const mask=(...missing:number[])=>({...native,supportGrid:{...native.supportGrid,cells:Array.from({length:48},(_,i)=>!missing.includes(i))}});
 const rectangle=(l:number,t:number,r:number,b:number):ScenePoint[]=>[[l,t],[r,t],[r,b],[l,b]];
 // Four unsupported centre cells surrounded by otherwise excellent distributed inliers.
 expect(projectScene(mask(19,20,27,28),rectangle(.4,.36,.60,.64))).toBeNull();
 // An interior hole, and an edge midpoint missed by corners and centroid.
 const large=rectangle(.14,.18,.86,.82);
 expect(projectScene(mask(18),large)).toBeNull();
 expect(projectScene(mask(11),large)).toBeNull();
 // Touch a corner exactly; the bounding box of a disjoint concave notch is insufficient.
 expect(projectScene(mask(18),rectangle(.375,.5,.43,.58))).toBeNull();
 const concave:ScenePoint[]=[[.14,.18],[.74,.18],[.74,.31],[.30,.31],[.30,.80],[.14,.80]];
 expect(projectScene(mask(28),concave)).not.toBeNull();
 const one=rectangle(.26,.345,.36,.485);
 const translated={...mask(19),homography:[1,0,.125,0,1,0,0,0,1]};
 expect(projectScene(translated,one)?.[0]?.[0]).toBeCloseTo(.385);
 for(const grid of [undefined,null,{columns:6,rows:8,cells:native.supportGrid.cells},
   {...native.supportGrid,cells:Array(47).fill(true)},{...native.supportGrid,cells:Array(49).fill(true)},
   {...native.supportGrid,cells:Array(48).fill(1)}]){
  expect(projectScene({...native,supportGrid:grid},one)).toBeNull();
 }
});
it('requires distributed evidence wholly inside both polygons and rejects v1 or malformed samples',()=>{
 const rectangle=(l:number,t:number,r:number,b:number):ScenePoint[]=>[[l,t],[r,t],[r,b],[l,b]];
 const box=rectangle(.33,.32,.62,.61);
 const match={...native,homography:[1,0,0,0,1,0,0,0,1]};
 const mask=(site:(x:number,y:number)=>string)=>Array.from({length:128*96},(_,i)=>site((4*(i%128)+2)/512,(4*Math.floor(i/128)+2)/384)).join('');
 for(const bad of [undefined,'s'.repeat(12287),'s'.repeat(12289),'x'.repeat(12288)]){
  expect(projectScene({...match,localEvidence:bad},box)).toBeNull();
 }
 expect(projectScene({...match,schema:'ainvr.scene-match.v1'},box)).toBeNull();
 for(const status of ['u','a','d']){
  const outsideOnly=mask((x,y)=>x>.33&&x<.62&&y>.32&&y<.61?status:'s');
  expect(projectScene({...match,localEvidence:outsideOnly},box)).toBeNull();
 }
 const onOneSide=mask((x,y)=>x<.47&&y<.46?'s':'u');
 expect(projectScene({...match,localEvidence:onOneSide},box)).toBeNull();
 const collapsed={...match,homography:[.5,0,0,0,.5,0,0,0,1]};
 expect(projectScene(collapsed,rectangle(.35,.35,.385,.405))).toBeNull();
 expect(projectScene(match,rectangle(.38,.38,.396,.398))).toBeNull();
 expect(projectScene({...match,localEvidence:'2'.repeat(12288)},box)).not.toBeNull();
});
it('keeps a prepared fixed ONVIF adapter in the existing screen-space workflow',async()=>{
 const manager=new PtzManager({} as any,{} as any);
 (manager as any).target=async()=>({source:{root:{id:'cam'},displayedEnabled:true,processorIds:['ai']},
  adapter:{resource:'onvif-fixed:cam',caps:{}}});
 expect(await manager.sceneSource('cam','ai')).toBeNull();
});
const enabled=!!process.env.AINVR_SCENE_PG_PORT;
async function isolated(run:(db:Pool)=>Promise<void>){
 const config={host:'127.0.0.1',port:Number(process.env.AINVR_SCENE_PG_PORT),user:'postgres',database:'scene_test'};
 const admin=new Pool(config),name='scene_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+name);
 const db=new Pool({...config,options:'-c search_path='+name});
 try{await runMigrations(db);await run(db);}
 finally{await db.end();await admin.query('DROP SCHEMA '+name+' CASCADE');await admin.end();}
}
it.skipIf(!enabled)('publishes the latest durable unbind boundary only for the deleted scene key', async () => isolated(async db => {
 const scenes = new ArmingScenes(db), ptz = new PtzStore(db), frame = randomUUID();
 const counter = { id:'counter', input_stream_id:'cam', channel_id:'ai', zone_id:'zone', zone_version:1,
  version:4, state:'enabled', geometry_revision:'g', points, source_binding:{not_before:'2020-01-01T00:00:00.000Z'} };
 const authored = [counter, {...counter,id:'duplicate'}, {...counter,id:'other-source',input_stream_id:'other'},
  {...counter,id:'other-processor',channel_id:'other'}, {...counter,id:'other-zone',zone_id:'other'}];
 const source = {snapshot: async () => ({schema_version:'1.0',
  revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton')).rows[0].revision,
  rules:authored})};
 const snapshot = async () => (await new PtzGuardedSnapshot(source,db,undefined,scenes).snapshot()).rules as any[];
 const projected = points.map(([x,y]) => [x+.01,y]);
 await db.query(`INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,
  geometry_revision,captured_at,image,manual_revision,items) VALUES($1,'cam','ai','op','device','motor',
  arming_scene_epoch('cam'),'g',now(),'{}',0,'[]')`,[frame]);
 const bind = () => db.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,
  reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason,current_points,binding_mode)
  VALUES('cam','ai','zone',1,$1,$2,'device','motor','g',arming_scene_epoch('cam'),'matched','',$3,'preset')`,
  [frame,JSON.stringify(points),JSON.stringify(projected)]);
 const unbind = async () => {
  await db.query("DELETE FROM arming_scene_zones WHERE source_id='cam' AND processor_id='ai' AND zone_id='zone'");
  return (await db.query("SELECT id,recorded_at FROM arming_scene_history WHERE operation='DELETE' ORDER BY id DESC LIMIT 1")).rows[0];
 };
 expect(await snapshot()).toEqual(authored);
 await bind();
 const bound = (await snapshot())[0];
 expect(bound.points).toEqual(projected);
 const firstDelete = await unbind();
 const first = await snapshot();
 expect(first[0]).toMatchObject({...counter, view_not_before:firstDelete.recorded_at.toISOString(),
  source_binding:{not_before:firstDelete.recorded_at.toISOString()}});
 expect(first[0].view_epoch).not.toBe(bound.view_epoch);
 expect(first[1].view_epoch).toBe(first[0].view_epoch);
 expect(first.slice(2)).toEqual(authored.slice(2));
 expect(await snapshot()).toEqual(first);
 await bind();
 expect((await snapshot())[0].points).toEqual(projected);
 const secondDelete = await unbind();
 // Tie the journal timestamps: id must select the second deletion and change the evidence epoch.
 await db.query("UPDATE arming_scene_history SET recorded_at=$1 WHERE operation='DELETE'",[firstDelete.recorded_at]);
 const second = (await snapshot())[0];
 expect(secondDelete.id).not.toBe(firstDelete.id);
 expect(second.view_epoch).not.toBe(first[0].view_epoch);
 expect(second.view_not_before).toBe(first[0].view_not_before);
 const rev = await ptz.block('motor',['cam'],'op',null,false);
 const blocked = (await snapshot())[0];
 const guard = (await db.query("SELECT changed_at FROM ptz_view_guards WHERE resource_key='motor'")).rows[0];
 expect(blocked).toMatchObject({state:'paused',points,version:4,view_not_before:guard.changed_at.toISOString(),
  source_binding:{not_before:guard.changed_at.toISOString()}});
 await ptz.restore('motor',rev,'op');
 const restored = (await snapshot())[0];
 const restore = (await db.query("SELECT restored_at FROM ptz_view_guards WHERE resource_key='motor'")).rows[0];
 expect(restored).toMatchObject({state:'enabled',points,version:4,view_not_before:restore.restored_at.toISOString(),
  source_binding:{not_before:restore.restored_at.toISOString()}});
 expect(counter.source_binding.not_before).toBe('2020-01-01T00:00:00.000Z');
}));
it.skipIf(!enabled)('retries moving and busy scenes after three seconds without epoch churn, but backs off a visual mismatch',async()=>isolated(async db=>{
 const store=new ArmingScenes(db),ptz=new PtzStore(db),frame=randomUUID();
 const camera={identity:'dev',resource:'motor',app:'live',stream:'cam',idle:true,pose:null};
 let sourceReads=0,captures=0,mode:'busy'|'miss'|'match'='busy';
 const runtime=new ArmingSceneRuntime(store,{
  source:async()=>{sourceReads++;return camera;},
  geometry:async()=>({width:640,height:480,geometry_revision:'g'}),
  capture:async()=>{captures++;return {w:640,h:480,bytes:Buffer.alloc(1),at:new Date()};},
  match:async()=>{if(mode==='busy')throw Error('scene_match_unavailable');return mode==='miss'?{...native,matched:false}:native;},
  images:{read:async()=>Buffer.alloc(1),cleanup:async()=>{},publish:async()=>{throw Error('unexpected publish');}},
 });
 await db.query("INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,geometry_revision,captured_at,image,manual_revision,items) VALUES($1,'cam','ai','op','dev','motor','old','g',now(),'{}',0,'[]')",[frame]);
 await db.query("INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason) VALUES('cam','ai','zone',1,$1,$2,'dev','motor','g','old','pending','')",[frame,JSON.stringify(points)]);
 const row=async()=>(await store.rows('cam','ai'))[0]!;
 const age=async(seconds:number)=>{await db.query("UPDATE arming_scene_zones SET checked_at=now()-$1*interval '1 second'",[seconds]);};
 const guard=await ptz.block('motor',['cam'],'op');
 await runtime.tick();const pending=await row();
 expect(pending).toMatchObject({state:'pending',current_points:null,visual_checked_at:null});
 expect(sourceReads).toBe(0);expect(captures).toBe(0);
 await age(4);await runtime.tick();
 expect(await row()).toMatchObject({revision:pending.revision,epoch:pending.epoch,visual_checked_at:null});
 await ptz.stopped('motor',guard);camera.idle=false;
 await age(4);await runtime.tick();expect(sourceReads).toBe(1);expect(captures).toBe(0);
 camera.idle=true;await runtime.tick();expect(captures).toBe(0);
 await age(4);await runtime.tick();expect(captures).toBe(1);
 expect(await row()).toMatchObject({state:'pending',revision:pending.revision});
 mode='match';await age(4);await runtime.tick();expect((await row()).state).toBe('matched');
 mode='miss';await age(21);await runtime.tick();
 const miss=await row();expect(miss).toMatchObject({state:'unmatched',current_points:null,visual_checked_at:null});
 // The first visual miss uses the 5-second tier. A recovery still needs two samples.
 const before=captures;mode='match';await age(4);await runtime.tick();expect(captures).toBe(before);
 await age(6);await runtime.tick();expect((await row()).state).toBe('matched');
 expect(captures).toBe(before+2);
}));
it.skipIf(!enabled)('real PG manual save, scoped guard, immutable reference, stable dwell, stale CAS, rename, startup and history',async()=>isolated(async db=>{
 const scenes=new ArmingScenes(db),ptz=new PtzStore(db),root=await mkdtemp('/tmp/scene-pg-test-');
 const jpegPath=process.env.AINVR_SCENE_TEST_JPEG,probe=process.env.AINVR_SCENE_TEST_PROBE,model=process.env.AINVR_SCENE_TEST_MODEL_ROOT;
 const jpeg=jpegPath?await readFile(jpegPath):Buffer.from('fixture');
 const dimensions=jpegDimensions(jpeg)??{width:640,height:480};
 const camera={identity:'device',resource:'motor',app:'live',stream:'cam',idle:true,pose:null};
 const source={input_stream_id:'cam',channel_id:'ai',geometry_revision:'g',label_map_version:'lm',...dimensions,
  labels:[{label_id:'person',name:'person'}],tracking_available:true,observed_at:new Date().toISOString(),stream_fingerprint:'a'.repeat(64)};
 let failCapture=false,capacityFull=false,matches=0,firstBytes:Buffer|undefined;
 const stream=process.env.AINVR_SCENE_TEST_STREAM;
 const runtime=new ArmingSceneRuntime(scenes,{
  source:async()=>camera,geometry:async()=>source,
  capture:async()=>{
   if(failCapture)throw Error('capture subprocess unavailable');
   const image=stream?await captureScene({app:'live',stream,...dimensions}):{bytes:jpeg,w:dimensions.width,h:dimensions.height,at:new Date()};
   firstBytes??=image.bytes;return image;
  },
  match:async(a,b)=>{
   matches++;
   if(!probe)return {...native,homography:[1,0,0,0,1,0,0,0,1]};
   if(!jpegPath||!model)throw Error('hardware test requires JPEG and model root');
   const x=join(root,'a.jpg'),y=join(root,'b.jpg');await writeFile(x,a);await writeFile(y,b.bytes);
   const {stdout}=await promisify(execFile)(probe,[model,x,y,'--scene'],{timeout:20000});
   const line=stdout.split('\n').find(l=>l.startsWith('{"backend":'));
   if(!line)throw Error('native result absent');return JSON.parse(line);
  },
  images:{publish:async(bytes,w,h)=>{if(capacityFull)throw new AlarmConfigError('storage_capacity','场景参考图磁盘剩余空间不足',503);const ref=randomUUID();await writeFile(join(root,ref),bytes);return {ref,w,h,generation:'test',sha256:'test'};},
   read:r=>readFile(join(root,r.ref)),cleanup:async()=>{}},
 });
 const arming=new AlarmArmingStore(db,()=>runtime);
 const app=Fastify();await app.register(alarmArmingRoutes,{store:arming,scenes:runtime,
  principal:async req=>typeof req.headers.actor==='string'?req.headers.actor:null,catalog:async()=>source,
  sourceGeometry:async()=>'g',synchronization:null});
 const z=(id:string)=>({zone_id:id,processor_id:'ai',channel_id:'cam',geometry_revision:'g',version:1,state:'active',name:id,points,edge_ids:['a','b','c','d']});
 const doc={source_id:'cam',processor_id:'ai',geometry_revision:'g',zones:[z('bound'),z('fixed')],assignments:[]};
 const save=(d:unknown,v:number,key:string)=>arming.saveArming(d,v,'operator',key,async()=>source,async()=>'g');
 const row=async()=>(await scenes.rows('cam','ai'))[0]!;
 const sourceRow=async()=>(await db.query('SELECT revision,updated_at,document FROM alarm_arming_sources')).rows[0];
 const rules=new PtzGuardedSnapshot({snapshot:async()=>({schema_version:'1.0',revision:(await db.query('SELECT revision::text FROM alarm_configuration_revision')).rows[0].revision,rules:(await sourceRow()).document.zones.map((z:any)=>({state:'enabled',channel_id:'ai',input_stream_id:'cam',zone_id:z.zone_id,zone_version:z.version,geometry_revision:'g',points}))})},db,undefined,scenes,()=>runtime.checkBindings());
 try{
  await save(doc,0,'base');
  const url='/alarms/arming/cam/scenes/frame';
  expect((await app.inject({method:'POST',url,payload:{processor_id:'ai'}})).statusCode).toBe(401);
  failCapture=true;
  const unavailable=await app.inject({method:'POST',url,headers:{actor:'operator'},payload:{processor_id:'ai'}});
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error).toEqual({code:'scene_capture_unavailable',message:'暂时无法冻结当前画面，请稍后重试'});
  failCapture=false;capacityFull=true;
  const full=await app.inject({method:'POST',url,headers:{actor:'operator'},payload:{processor_id:'ai'}});
  expect(full.statusCode).toBe(503);expect(full.json().error.code).toBe('storage_capacity');
  capacityFull=false;firstBytes=undefined;
  const freeze=await app.inject({method:'POST',url,headers:{actor:'operator'},payload:{processor_id:'ai'}});
  expect(freeze.statusCode,freeze.body).toBe(200);const frame=freeze.json();
  const path=frame.image_url.replace('/api','');
  expect((await app.inject({url:path,headers:{actor:'other'}})).statusCode).toBe(409);
  expect((await app.inject({url:path})).statusCode).toBe(401);
  expect((await app.inject({url:path,headers:{actor:'operator'}})).rawPayload).toEqual(firstBytes);
  expect((await app.inject({url:url+'/'+ '-'.repeat(36),headers:{actor:'operator'}})).statusCode).toBe(422);
  const bind={...doc,scene_edits:[{mode:'bind',zone_id:'bound',frame_id:frame.frame_id,expected_revision:0}]};
  const saved=await save(bind,1,'bind');
  expect(await save(bind,1,'bind')).toEqual(saved);
  const manual=await sourceRow();
  const guard=await ptz.block('motor',['cam'],'operator',null,true);
  await ptz.stopped('motor',guard);
  await db.query("UPDATE arming_scene_zones SET checked_at=now()-interval '2 minutes'");
  await runtime.tick();
  const matched=await row();expect(matched.state).toBe('matched');expect(matches).toBe(3);
  expect(matched.reference_points).toEqual(points);expect(await sourceRow()).toEqual(manual);
  const runtimeRules=async()=>(await rules.snapshot()).rules as any[];
  const first=await runtimeRules();
  expect(first.map(r=>r.state)).toEqual(['enabled','paused']);
  expect((await ptz.guard('motor')).blocked).toBe(true);
  const stamp=await scenes.stamp('cam');
  await scenes.result(matched,stamp.manual,stamp.epoch,matched.current_points,'',null,null);
  expect((await runtimeRules())[0].view_epoch).toEqual(first[0].view_epoch);
  const renamed={...doc,zones:[{...doc.zones[0],name:'renamed',version:2},doc.zones[1]]};
  await save(renamed,2,'rename');expect((await row()).reference_frame_id).toBe(matched.reference_frame_id);
  expect((await row()).state).toBe('matched');expect((await row()).zone_version).toBe(2);
  await expect(save({...renamed,zones:[{...renamed.zones[0],points:[[.2,.2],[.7,.2],[.7,.7]],edge_ids:['a','b','c'],version:3},doc.zones[1]]},3,'bypass')).rejects.toMatchObject({statusCode:409});
  await expect(save(bind,3,'stale-frame')).rejects.toMatchObject({statusCode:409});
  const counter={binding_id:'flow-angle',counter_id:'angle',input_stream_id:'cam',processor_id:'ai',zone_id:'bound',
   zone_version:2,geometry_revision:'g',label_map_version:'lm',direction:{kind:'angle',entry:{from:0,to:30},exit:{from:160,to:190}}};
  await expect(save({...renamed,counter_bindings:[counter]},3,'angle')).rejects.toMatchObject({code:'scene_angle_unsupported'});
  expect((await runtimeRules())[0].state).toBe('enabled');
  const current=await row();await ptz.block('other',['cam'],'operator',null,false);
  expect((await runtime.read('cam','ai')).items[0]?.current_points).toBeNull();
  await scenes.result(current,3,stamp.epoch,current.current_points,'',null,null);
  expect((await row()).current_points).toBeNull();
  const newer=await row(),s2=await scenes.stamp('cam');
  await scenes.result(newer,3,s2.epoch,points,'',null,null);
  expect((await runtimeRules())[0].state).toBe('paused');
  camera.identity='replacement';
  expect((await runtimeRules())[0].state).toBe('paused');
  expect((await row()).state).toBe('pending');
  camera.identity='device';
  await scenes.result(await row(),3,s2.epoch,points,'',null,null);
  await db.query("UPDATE arming_scene_zones SET checked_at=now()-interval '91 seconds'");
  expect((await runtime.read('cam','ai')).items[0].current_points).toBeNull();
  await scenes.invalidate(false);expect((await row()).state).toBe('pending');
  await scenes.result(await row(),3,s2.epoch,points,'',null,null);
  await scenes.invalidate(true);expect((await row()).state).toBe('pending');
  // A stationary pose may extend only a still-valid visual result. It cannot
  // create a match after startup or resurrect an expired visual verification.
  const pending=await row();
  await scenes.poseHeartbeat([pending],3,s2.epoch);
  expect((await row()).state).toBe('pending');
  const pose={position:{Pan:0,Tilt:0,Zoom:.2,PanTiltSpace:'pt',ZoomSpace:'z'},panTilt:'IDLE',zoom:'IDLE'};
  await scenes.result(pending,3,s2.epoch,points,'',pose,null);
  await db.query("UPDATE arming_scene_zones SET checked_at=now()-interval '30 seconds'");
  const verified=await row();await scenes.poseHeartbeat([verified],3,s2.epoch);
  expect((await row()).checked_at.getTime()).toBeGreaterThan(verified.checked_at.getTime());
  expect((await row()).visual_checked_at).toEqual(verified.visual_checked_at);
  await db.query("UPDATE arming_scene_zones SET visual_checked_at=now()-interval '6 minutes'");
  const expired=await row();await scenes.poseHeartbeat([expired],3,s2.epoch);
  expect((await row()).checked_at).toEqual(expired.checked_at);
  await save({...renamed,zones:[doc.zones[1]]},3,'delete');
  expect(await scenes.rows('cam')).toHaveLength(0);
  expect((await db.query('SELECT DISTINCT reference_frame_id FROM arming_scene_history')).rows).toEqual([{reference_frame_id:frame.frame_id}]);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
}),120000);

it.skipIf(!enabled)('queues one interactive freeze or proof behind background hardware and drops expired requests',async()=>isolated(async db=>{
 const scenes=new ArmingScenes(db),blocker=await db.connect();
 let announce!:()=>void,releaseBackground!:()=>void,captures=0;
 const entered=new Promise<void>(r=>{announce=r;}),drain=new Promise<void>(r=>{releaseBackground=r;});
 const deps={
  source:async()=>({identity:'dev',resource:'motor',app:'live',stream:'cam',pose:null,idle:true}),
  geometry:async()=>({geometry_revision:'g',width:640,height:480}),
  capture:async()=>{captures++;return {bytes:Buffer.from('fixture'),w:640,h:480,at:new Date()};},
  match:async()=>({...native,homography:[1,0,0,0,1,0,0,0,1]}),
  images:{publish:async()=>({ref:randomUUID(),w:640,h:480,sha256:'test',generation:'test'}),
   read:async()=>Buffer.from('fixture'),cleanup:async()=>{announce();await drain;}},
 };
 const runtime=new ArmingSceneRuntime(scenes,deps),otherProcess=new ArmingSceneRuntime(scenes,deps);
 const hold=()=>blocker.query("SELECT pg_advisory_lock(hashtextextended('arming-scene-hardware',0))");
 const release=()=>blocker.query("SELECT pg_advisory_unlock(hashtextextended('arming-scene-hardware',0))");
 const queued=async()=>{
  const until=Date.now()+3000;
  while(Date.now()<until){
   if((await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rowCount)return;
   await new Promise(r=>setTimeout(r,10));
  }
  throw Error('interactive request did not enter the PG lock queue');
 };
 try{
  const background=runtime.tick();await entered;
  const request=runtime.freeze('cam','ai','operator');await queued();
  await expect(runtime.freeze('cam','ai','operator')).rejects.toMatchObject({statusCode:429});
  await expect(otherProcess.freeze('cam','ai','operator')).rejects.toMatchObject({statusCode:429});
  await runtime.tick();expect(captures).toBe(0);
  releaseBackground();const f=await request;await background;expect(captures).toBe(1);
  const prove=()=>runtime.prove('cam','ai','operator',0,[{zone_id:'z',expected_revision:0,mode:'bind',frame_id:f.frame_id}],[{zone_id:'z',points}]);
  await hold();const valid=prove();await queued();
  await expect(runtime.freeze('cam','ai','operator')).rejects.toMatchObject({statusCode:429});
  await release();expect((await valid).frame_id).toBe(f.frame_id);expect(captures).toBe(2);
  await hold();const staleProof=expect(prove()).rejects.toMatchObject({statusCode:409});await queued();
  await new PtzStore(db).block('motor',['cam'],'operator',null,false);
  await release();await staleProof;expect(captures).toBe(2);
  // Exercise the actual transport timeout, then unlock. The expired request
  // must never capture later, and a fresh request must be able to proceed.
  await hold();
  await expect(runtime.freeze('cam','ai','operator')).rejects.toMatchObject({code:'scene_wait_timeout',statusCode:503});
  await release();expect(captures).toBe(2);
  await runtime.freeze('cam','ai','operator');expect(captures).toBe(3);
 }finally{releaseBackground();blocker.release(true);}
}),30000);

it.skipIf(!enabled)('caps only inactive historical images and never deletes referenced frame manifests',async()=>isolated(async db=>{
 const store=new ArmingScenes(db);
 await db.query(`INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,geometry_revision,
  captured_at,image,manual_revision,items)
  SELECT md5(n::text)::uuid,'cam','ai','operator','dev','motor','epoch','g',now()-interval '20 days',
   jsonb_build_object('ref',md5(n::text)::uuid),1,'[]' FROM generate_series(1,520) n`);
 await db.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,
  reference_points,identity,resource,geometry_revision,epoch,state,reason)
  SELECT source_id,processor_id,frame_id::text,1,frame_id,'[[0,0],[1,0],[0,1]]',identity,resource,geometry_revision,
    epoch,'pending','test' FROM arming_scene_frames`);
 // More than 384 distinct current references must all survive. One
 // additional zone shares one image and must not consume a second slot.
 await db.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,reference_points,
  identity,resource,geometry_revision,epoch,state,reason) SELECT source_id,processor_id,'shared',zone_version,
  reference_frame_id,reference_points,identity,resource,geometry_revision,epoch,state,reason FROM arming_scene_zones
  WHERE reference_frame_id=md5('1')::uuid`);
 await db.query("DELETE FROM arming_scene_zones WHERE reference_frame_id IN (SELECT md5(n::text)::uuid FROM generate_series(401,520)n)");
 expect((await store.retainedImages()).size).toBe(400);
 await db.query("DELETE FROM arming_scene_zones WHERE reference_frame_id IN (SELECT md5(n::text)::uuid FROM generate_series(301,400)n)");
 const high=await store.retainedImages();
 expect(high.size).toBe(300+84);
 const pinned=await db.query("SELECT DISTINCT reference_frame_id FROM arming_scene_zones");
 expect(pinned.rows).toHaveLength(300);
 for(const r of pinned.rows)expect(high.has(r.reference_frame_id)).toBe(true);
 await db.query("DELETE FROM arming_scene_zones WHERE reference_frame_id<>md5('1')::uuid");
 const live=await store.retainedImages();
 expect(live.size).toBe(257);
 expect(live.has((await db.query("SELECT md5('1')::uuid AS id")).rows[0].id)).toBe(true);
 expect((await db.query('SELECT count(*)::int AS n FROM arming_scene_frames')).rows[0].n).toBe(520);
 expect((await db.query('SELECT count(DISTINCT reference_frame_id)::int AS n FROM arming_scene_history')).rows[0].n).toBe(520);
 expect(await store.retainedImages()).toEqual(live);
}));

it.skipIf(!enabled||!process.env.AINVR_SCENE_TEST_SSD||!process.env.AINVR_SCENE_TEST_JPEG)(
 'real SSD removes expired image bytes, pins shared current references, preserves geometry, digest and recent drafts',
 async()=>isolated(async db=>{
  const store=new ArmingScenes(db),ssd=process.env.AINVR_SCENE_TEST_SSD!;
  const root=await mkdtemp(join(ssd,'scene-retention-'));
  try{
   const device=(await promisify(execFile)('findmnt',['-n','-o','SOURCE','-T',root])).stdout.trim();
   const images=new FloorPlanImages(async()=>({root,device,generation:'isolated'}),'ainvr-arming-scenes');
   const bytes=await readFile(process.env.AINVR_SCENE_TEST_JPEG!),size=jpegDimensions(bytes)!;
   const ago=new Date(Date.now()-20*86400000);
   async function frame(recent=false){
    const image=await images.publish(bytes,size.width,size.height);
    const id=randomUUID(),path=join(root,'ainvr-arming-scenes',image.ref+'.jpg');
    await utimes(path,ago,ago);
    await db.query(`INSERT INTO arming_scene_frames(frame_id,source_id,processor_id,actor,identity,resource,epoch,
     geometry_revision,captured_at,image,manual_revision,items) VALUES($1,'cam','ai','operator','dev','motor','epoch','g',$2,$3,1,'[]')`,
      [id,recent?new Date():ago,image]);
    return {id,path,image};
   }
   async function bind(id:string,zone:string){
    await db.query(`INSERT INTO arming_scene_zones(source_id,processor_id,zone_id,zone_version,reference_frame_id,
     reference_points,identity,resource,geometry_revision,epoch,state,reason)
     VALUES('cam','ai',$1,1,$2,$3,'dev','motor','g','epoch','unmatched','无匹配')`,[zone,id,JSON.stringify(points)]);
   }
   const shared=await frame(),old=await frame(),recent=await frame(),draft=await frame(true),abandoned=await frame();
   await bind(shared.id,'A');await bind(shared.id,'B');await bind(old.id,'old');await bind(recent.id,'recent');
   await db.query("DELETE FROM arming_scene_zones WHERE zone_id<>'B'");
   await db.query("UPDATE arming_scene_history SET recorded_at=now()-interval '8 days' WHERE reference_frame_id=ANY($1::uuid[])",[[shared.id,old.id]]);
   const history=async()=>(await db.query('SELECT id,document,reference_frame_id FROM arming_scene_history ORDER BY id')).rows;
   const audit=await history();
   const live=await store.retainedImages();await images.cleanup(live);
   expect(live).toEqual(new Set([shared.image.ref,recent.image.ref,draft.image.ref]));
   expect(await history()).toEqual(audit);
   expect(await images.read(shared.image)).toEqual(bytes);
   expect(await images.read(recent.image)).toEqual(bytes);
   expect(await images.read(draft.image)).toEqual(bytes);
   for(const expired of [old,abandoned])await expect(stat(expired.path)).rejects.toMatchObject({code:'ENOENT'});
   const record=(await db.query('SELECT image,image_retired_at FROM arming_scene_frames WHERE frame_id=$1',[old.id])).rows[0];
   expect(record.image).toEqual(old.image);expect(record.image_retired_at).toBeInstanceOf(Date);
   // The history still identifies the original frame after bytes are gone.
   const runtime=new ArmingSceneRuntime(store,{images} as any);
   await expect(runtime.image('cam',old.id,'operator')).rejects.toMatchObject({code:'scene_image_expired',statusCode:410});
   await expect(runtime.image('cam',old.id,'another-actor')).rejects.toMatchObject({statusCode:409});
   await db.query("DELETE FROM arming_scene_zones WHERE zone_id='B'");
   expect((await store.retainedImages()).has(shared.image.ref)).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
 }),30000);
