// Cross-service test only: Node 26+, backend devDependencies, alarm dependencies.
// Requires isolated PG (AINVR_SCENE_PG_PORT), isolated Mongo (AINVR_ALARM_TEST_MONGO=1)
// and a read-only copied native Hik journal via AINVR_NATIVE_MOTION_FRAME.
// Own random PG schema and ainvr_alarm_test_* Mongo database; no camera/service control.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {registerHooks,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import ts from '../../srs-web-console/backend/node_modules/typescript/lib/typescript.js';
import {AlarmRepository} from '../../alarm-service/src/repository.mjs';
import {ObservationConsumer} from '../../alarm-service/src/ingestion.mjs';
import {observationEnvelope} from '../../alarm-service/src/observation-pump.mjs';
import {createApp} from '../../alarm-service/src/http.mjs';
import {createMotionAdmission,canonicalDigest} from '../../alarm-service/src/motion-admission.mjs';
import {digest} from '../../alarm-service/src/domain.mjs';
const backend=new URL('../../srs-web-console/backend/src/',import.meta.url).href;
const hooks=registerHooks({
 resolve(specifier,context,next){
  if(context.parentURL?.startsWith(backend)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
   const target=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(target))return next(target.href,context);
  }return next(specifier,context);
 },
 load(url,context,next){
  if(url.startsWith(backend)&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
  return next(url,context);
 },
});
const {PtzMotionAdmission}=await import('../../srs-web-console/backend/src/services/ptzMotionAdmission.ts');
const {ptzMotionRoutes}=await import('../../srs-web-console/backend/src/routes/ptzMotionRoutes.ts');
hooks.deregister();
const backendRequire=createRequire(new URL('../../srs-web-console/backend/package.json',import.meta.url));
const alarmRequire=createRequire(new URL('../../alarm-service/package.json',import.meta.url));
const {Pool}=backendRequire('pg'),Fastify=backendRequire('fastify'),{MongoClient}=alarmRequire('mongodb');
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1'&&!!process.env.AINVR_SCENE_PG_PORT;
test('actual Hik journal -> raw snapshot HTTP -> real PG admission route -> Mongo, preserving decimal frame indices',{skip:!enabled,timeout:20000},async()=>{
 assert.ok(process.env.AINVR_NATIVE_MOTION_FRAME,'Read-only native journal fixture required');
 const native=JSON.parse(readFileSync(process.env.AINVR_NATIVE_MOTION_FRAME,'utf8'));
 assert.equal(native.channel_id,'hik-gb-follow');assert.match(native.source_frame_index,/^\d+$/);assert.equal(typeof native.source_frame_index,'string');
 const config={host:'127.0.0.1',port:Number(process.env.AINVR_SCENE_PG_PORT),user:'postgres',database:'scene_test'};
 const admin=new Pool(config),schema='motion_contract_'+randomUUID().replaceAll('-','');
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028');
 let pg,db,alarm,bff;
 try{
  await admin.query('CREATE SCHEMA '+schema);pg=new Pool({...config,options:'-c search_path='+schema,max:3});
  // Only the gate's tables; avoid rerunning 36 migrations in the shared isolated PG.
  await pg.query(`CREATE TABLE alarm_configuration_revision(singleton boolean PRIMARY KEY,revision bigint);
   INSERT INTO alarm_configuration_revision VALUES(true,1);
   CREATE TABLE ptz_view_guards(resource_key text PRIMARY KEY,revision bigint,source_ids text[],stop_pending boolean,blocked boolean,restored_at timestamptz);
   INSERT INTO ptz_view_guards VALUES('contract-motor',1,ARRAY['contract-input'],false,true,NULL);
   CREATE TABLE ptz_motion_scopes(source_id text,processor_id text,guard_epoch text,execution_digest text,snapshot_revision bigint,allowed boolean,installed boolean DEFAULT false,updated_at timestamptz DEFAULT now(),PRIMARY KEY(source_id,processor_id));
   CREATE TABLE ptz_motion_guard_installations(resource_key text PRIMARY KEY,source_digest text NOT NULL,snapshot_revision bigint NOT NULL,installed boolean DEFAULT false NOT NULL);`);
  await client.connect();db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  const repo=new AlarmRepository(db);await repo.initialize();
  const gate=new PtzMotionAdmission(pg),requests=[];
  bff=Fastify();await bff.register(ptzMotionRoutes,{principal:req=>req.headers['x-service-token']==='contract-service-token',admission:{admit:input=>{requests.push(input);return gate.admit(input);}}});
  await bff.listen({host:'127.0.0.1',port:0});
  repo.motionAdmission=createMotionAdmission({control_url:bff.server.address()?`http://127.0.0.1:${bff.server.address().port}/`:'',service_token:'contract-service-token'});
  const consumer=new ObservationConsumer(repo),apiToken='contract-operator-token-'.repeat(3);
  alarm=createApp({repository:repo,consumer,apiToken,producerToken:'contract-producer-'.repeat(3)});await alarm.listen({host:'127.0.0.1',port:0});
  const catalog=native.model.label_catalog,labels=catalog.labels.map(l=>({class_id:l.class_id,label_id:l.label_id,name:l.name,description:l.description}));
  const labelVersion='labels-'+digest([catalog.adapter,labels]);
  const raw={id:'flow-contract',counter_id:'counter',version:1,name:'Contract',channel_id:native.channel_id,input_stream_id:'contract-input',state:'enabled',
   label_ids:labels.map(l=>l.label_id),geometry_revision:'contract-geometry',label_map_version:labelVersion,behavior:'region_traverse',alarm_enabled:false,
   zone_id:'zone',zone_version:1,points:[[.3,.1],[.7,.1],[.7,.9],[.3,.9]],edge_ids:['top','right','bottom','left'],
   source_binding:{input_stream_id:'contract-input',geometry_revision:'contract-geometry',label_map_version:labelVersion,width:native.width,height:native.height,
    stream_fingerprint:createHash('sha256').update(native.stream_url).digest('hex'),not_before:new Date(native.timestamp*1000-1000).toISOString()}};
  const snapshot=await gate.snapshot({snapshot:async()=>({schema_version:'1.0',revision:'1',rules:[raw]})});
  const url=`http://127.0.0.1:${alarm.server.address().port}/v1/configuration/rules`,headers={authorization:'Bearer '+apiToken,'x-ainvr-actor':'contract','content-type':'application/json'};
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(snapshot)});assert.equal(response.status,200);
  const status=await (await fetch(url,{headers})).json();
  assert.equal(status.motion_admission.scopes_digest,canonicalDigest(snapshot.motion_admission.scopes));
  await gate.acknowledge(snapshot,status.motion_admission);
  const installation=(await pg.query('SELECT * FROM ptz_motion_guard_installations')).rows;
  assert.equal(installation.length,1);assert.equal(installation[0].installed,true);
  assert.equal(installation[0].snapshot_revision,'1');
  const converted=observationEnvelope(native,[raw]);assert.ok(converted.envelope);
  assert.equal((await consumer.consume(converted.envelope)).durable,true);
  assert.equal(requests[0].source_frame_index,native.source_frame_index);assert.equal(typeof requests[0].source_frame_index,'string');
  const large={...native,offset:String(BigInt(native.offset)+1n),source_frame_index:'9007199254740995',timestamp:native.timestamp+.1};
  assert.equal((await consumer.consume(observationEnvelope(large,[raw]).envelope)).durable,true);
  assert.equal(requests[1].source_frame_index,'9007199254740995');
  await pg.query('UPDATE ptz_view_guards SET revision=revision+1,stop_pending=true;UPDATE alarm_configuration_revision SET revision=revision+1');
  const moving={...large,offset:String(BigInt(large.offset)+1n)};
  await assert.rejects(consumer.consume(observationEnvelope(moving,[raw]).envelope),e=>e.code==='motion_admission_required');
  assert.equal((await repo.checkpoints.findOne({channel_id:native.channel_id})).offset,large.offset);
 }finally{
  await alarm?.close();await bff?.close();if(db)await db.dropDatabase();await client.close();
  await pg?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 }
});
