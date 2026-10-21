import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,writeFile,readFile,symlink,unlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {EvidenceVault,validateEvidencePolicy} from '../src/evidence-vault.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {createApp} from '../src/http.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1'&&process.platform==='linux';
const jpeg=Buffer.from([255,216,255,217]);
function sample(eventId,at){return {event_id:eventId,channel_id:'channel',stream_session_id:'session',track_id:'track',label_id:'person',source_pts_ns:'9007199254740993',source_frame_index:'9007199254740995',occurred_at:new Date(at).toISOString(),analysis_evidence:{source_frame_index:'9007199254740995',source:{width:3840,height:2160}}};}
function metadata(f){return {state:'available',evidence:{kind:'target_crop',image_id:'source-image',channel_id:f.channel_id,stream_session_id:f.stream_session_id,track_id:f.track_id,label_id:f.label_id,source_pts_ns:f.source_pts_ns,source_frame_index:f.source_frame_index,frame_width:3840,frame_height:2160,image_width:320,image_height:240,variants:['processed','original']}};}
async function fixture(fn,policy={enabled:true,retention_days:1,max_bytes:1024}){
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-','')),root=await mkdtemp('/mnt/ainvr-ssd/ainvr-evidence-test-');
 let now=Date.now();const source={metadata:async id=>metadata(await db.collection('behavior_events').findOne({event_id:id})),image:async()=>jpeg};
 const options={root,policy,source,clock:()=>now},vault=new EvidenceVault(db,options);
 try{await vault.initialize();await fn({vault,db,root,options,advance:n=>{now+=n;},add:async(id='a'.repeat(64))=>{const fact=sample(id,now);await db.collection('behavior_events').insertOne(fact);await vault.enqueue(id,fact);return fact;}});}
 finally{await vault.close();await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
}
test('evidence policy is optional for legacy config but rejects unsafe quotas and unknown options',()=>{
 assert.equal(validateEvidencePolicy(undefined),undefined);
 const good={enabled:true,retention_days:30,max_bytes:2*1024**3};assert.deepEqual(validateEvidencePolicy(good),good);
 for(const patch of [{enabled:'yes'},{retention_days:0},{retention_days:3651},{max_bytes:100},{max_bytes:Infinity},{root:'/tmp/elsewhere'}])assert.throws(()=>validateEvidencePolicy({...good,...patch}));
});
test('saved bytes survive AI-history loss and restart; one kernel owner protects each private root',{skip:!enabled},async()=>fixture(async({vault,db,root,options,add})=>{
 const fact=await add();await vault.tick();
 assert.deepEqual(await vault.image(fact.event_id,'original'),jpeg);
 assert.equal((await vault.metadata(fact.event_id)).evidence.pinned,true);
 await vault.enqueue(fact.event_id,fact);assert.equal(await vault.rows.countDocuments(),1);
 const other=new EvidenceVault(db,options);await assert.rejects(other.initialize(),/EADDRINUSE/);await other.close();
 options.source.image=async()=>{throw Error('AI history removed');};
 assert.deepEqual(await vault.image(fact.event_id,'processed'),jpeg);
 await vault.close();const restarted=new EvidenceVault(db,options);
 try{await restarted.initialize();assert.deepEqual(await restarted.image(fact.event_id,'original'),jpeg);assert.equal((await restarted.status()).used_bytes,8);}
 finally{await restarted.close();}
 assert.equal((await readdir(root)).filter(n=>n.endsWith('.jpg')).length,2);
}));
test('wrong-frame metadata and malformed JPEG never publish a retained crop; bounded retries become unavailable',{skip:!enabled},async()=>fixture(async({vault,options,add,advance})=>{
 const fact=await add();options.source.metadata=async()=>{const raw=metadata(fact);raw.evidence.source_pts_ns='1';return raw;};
 await vault.tick();assert.equal((await vault.metadata(fact.event_id)).state,'pending');assert.equal((await vault.status()).used_bytes,0);
 advance(6000);options.source.metadata=async()=>metadata(fact);options.source.image=async()=>Buffer.from('not jpeg');await vault.tick();
 assert.equal((await vault.metadata(fact.event_id)).state,'pending');
 advance(16*60000);await vault.tick();assert.deepEqual(await vault.metadata(fact.event_id),{state:'unavailable',reason:'capture_timeout'});
 await assert.rejects(vault.image(fact.event_id,'processed'),e=>e.status===404);
}));
test('capacity evicts oldest image sets, retention expires images, and behavior facts remain intact',{skip:!enabled},async()=>fixture(async({vault,add,advance,db})=>{
 const first=await add();await vault.tick();advance(1000);const next=await add('b'.repeat(64));await vault.tick();
 assert.deepEqual(await vault.metadata(first.event_id),{state:'unavailable',reason:'capacity'});
 assert.deepEqual(await vault.image(next.event_id,'processed'),jpeg);assert.equal((await vault.status()).used_bytes,8);
 advance(86400001);await vault.tick();assert.equal((await vault.metadata(next.event_id)).reason,'retention');assert.equal((await vault.status()).used_bytes,0);
 assert.equal(await db.collection('behavior_events').countDocuments(),2);
},{enabled:true,retention_days:1,max_bytes:12}));
test('a committed publication whose response was lost preserves saved files; orphan recovery fences abandoned captures',{skip:!enabled},async()=>fixture(async({vault,options,root,db,add})=>{
 const fact=await add(),update=vault.rows.updateOne.bind(vault.rows);let once=true;
 vault.rows.updateOne=async(...args)=>{const result=await update(...args);if(once&&args[1].$set?.state==='stored'){once=false;throw Error('response lost after commit');}return result;};
 await vault.tick();assert.deepEqual(await vault.image(fact.event_id,'processed'),jpeg);
 const orphanId='c'.repeat(64),orphanName=`${orphanId}-processed-${randomUUID()}.jpg`;
 await vault.rows.insertOne({_id:orphanId,event_id:orphanId,state:'capturing',capture_token:'old',occurred_at:new Date().toISOString(),queued_at:Date.now(),deadline:Date.now()+600000,attempts:1,files:[]});
 await writeFile(join(root,orphanName),jpeg,{mode:0o600});await vault.close();
 const recovered=new EvidenceVault(db,options);
 try{await recovered.initialize();assert.equal((await readdir(root)).includes(orphanName),false);assert.equal((await recovered.rows.findOne({_id:orphanId})).state,'pending');assert.deepEqual(await recovered.image(fact.event_id,'original'),jpeg);}
 finally{await recovered.close();}
}));
test('corruption, missing files and storage identity mismatch fail closed without deleting another database files',{skip:!enabled},async()=>fixture(async({vault,options,root,db,add})=>{
 const fact=await add();await vault.tick();const row=await vault.rows.findOne({_id:fact.event_id}),path=join(root,row.files[0].name);
 await vault.rows.updateOne({_id:fact.event_id},{$set:{'files.0.name':row.files[1].name}});await assert.rejects(vault.image(fact.event_id,row.files[0].variant),e=>e.status===404);
 await vault.rows.updateOne({_id:fact.event_id},{$set:{files:row.files}});
 await writeFile(path,Buffer.from([255,216,0,217]));await assert.rejects(vault.image(fact.event_id,row.files[0].variant),e=>e.status===404);
 await unlink(path);assert.equal((await vault.metadata(fact.event_id)).reason,'stored_file_missing');
 const link=join(root,'linked');await symlink(root,link);const bad=new EvidenceVault(db,{...options,root:link});await assert.rejects(bad.initialize());await unlink(link);
 await vault.close();await db.collection('alarm_storage_identity').updateOne({_id:'evidence'},{$set:{uuid:'other-database'}});
 const wrong=new EvidenceVault(db,options);await assert.rejects(wrong.initialize(),/different database/);await wrong.close();
 assert.equal((await readFile(join(root,'.ainvr-evidence-v1'),'utf8')).includes('other-database'),false);
}));
test('consumer durably queues only alarm-enabled facts; HTTP image reads require operator authentication',{skip:!enabled},async()=>fixture(async({vault,db})=>{
 const repo=new AlarmRepository(db);await repo.initialize();repo.evidenceVault=vault;
 const rule={id:'r',monitor_id:'m',version:1,name:'Gate',channel_id:'channel',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance'};
 await repo.saveRule(rule,0,'test');const at=Date.now();
 const f={schema_version:'1.0',channel_id:'channel',input_stream_id:'in',stream_session_id:'session',seq:'1',frame_id:'frame',source_pts_ns:'9007199254740993',source_frame_index:'9007199254740995',captured_at:new Date(at).toISOString(),source:{width:3840,height:2160,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'track',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:'9007199254740993',bbox:{x:10,y:10,w:20,h:20}}]};
 const envelope={schema_version:'1.0',producer_id:'p',offset:'1',frame:f},consumer=new ObservationConsumer(repo);
 const result=await consumer.consume(envelope);await consumer.consume(envelope);assert.equal(await vault.rows.countDocuments(),1);await vault.tick();
 const api='operator-test-'.repeat(4),producer='producer-test-'.repeat(4),app=createApp({repository:repo,apiToken:api,producerToken:producer,consumer});
 try{const url=`/v1/behavior-events/${result.behavior_events[0]}/evidence/image`;
  assert.equal((await app.inject({url,headers:{authorization:`Bearer ${producer}`}})).statusCode,401);
  const image=await app.inject({url,headers:{authorization:`Bearer ${api}`}});assert.equal(image.statusCode,200);assert.deepEqual(image.rawPayload,jpeg);assert.equal(image.headers['cache-control'],'private, no-store');
 }finally{await app.close();}
 await repo.saveRule({...rule,version:2,alarm_enabled:false},1,'test');
 await consumer.consume({...envelope,offset:'2',frame:{...f,seq:'2',stream_session_id:'other',source_pts_ns:'9007199254740994',tracks:f.tracks.map(t=>({...t,last_observed_pts_ns:'9007199254740994'}))}});
 assert.equal(await vault.rows.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),2);
}));
test('SIGKILL after file fsync releases kernel ownership and next process recovers the durable queue',{skip:!enabled,timeout:15000},async()=>fixture(async({vault,db,root,options,add})=>{
 const fact=await add();await vault.close();
 const code=`import {MongoClient} from 'mongodb';import {EvidenceVault} from ${JSON.stringify(new URL('../src/evidence-vault.mjs',import.meta.url).href)};
 const client=new MongoClient('mongodb://127.0.0.1:27028');await client.connect();const db=client.db(${JSON.stringify(db.databaseName)});
 const fact=await db.collection('behavior_events').findOne({event_id:${JSON.stringify(fact.event_id)}});
 const vault=new EvidenceVault(db,{root:${JSON.stringify(root)},policy:{enabled:true,retention_days:1,max_bytes:1024},source:{metadata:async()=>(${JSON.stringify(metadata(fact))}),image:async()=>Buffer.from([255,216,255,217])}});
 await vault.initialize();const original=vault.rows.updateOne.bind(vault.rows);vault.rows.updateOne=async(...args)=>{if(args[1].$set?.state==='stored'){process.stdout.write('before_publish\\n');await new Promise(()=>{});}return original(...args);};await vault.tick();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 let timer;
 try{
  const ready=await Promise.race([once(child.stdout,'data').then(([data])=>data.toString()),once(child,'exit').then(()=>{throw Error('Child exited early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Child readiness timeout')),5000);})]);
  assert.equal(ready,'before_publish\n');clearTimeout(timer);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  const restarted=new EvidenceVault(db,options);
  try{await restarted.initialize();assert.equal((await readdir(root)).filter(n=>n.endsWith('.jpg')).length,0);await restarted.tick();assert.deepEqual(await restarted.image(fact.event_id,'processed'),jpeg);}
  finally{await restarted.close();}
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}}
}));
