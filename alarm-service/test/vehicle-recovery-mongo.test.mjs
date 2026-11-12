import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {VehicleRecognition,watchlistDigest} from '../src/vehicle-recognition.mjs';
const uri=process.env.AINVR_VEHICLE_TEST_MONGO_URI;
async function fixture(work){
 const client=new MongoClient(uri);await client.connect();const db=client.db('vehicle_recovery_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();let now=Date.now(),calls=0,invokeError=null;
  const list={version:1,entries:[{plate:'京A12345'}]},policy={version:1,digest:watchlistDigest(1,list.entries)};
  repo.reviewContext={image:async()=>({width:1920,height:1080,data:Buffer.from('original')})};
  const service=new VehicleRecognition(repo,{clock:()=>now,watchlist:async version=>{assert.equal(version,1);return list;},invoke:async()=>{calls++;if(invokeError)throw Object.assign(Error(invokeError),{code:invokeError});return {model_pin:'a'.repeat(64),candidates:[{status:'candidate',text:'京A12345'}]};}});await service.initialize();
  const grant=(patch={})=>service.configure({issued_ms:now,expires_ms:now+45000,channels:['channel'],counter_ids:['counter'],model_pin:'a'.repeat(64),watchlist:policy,...patch});grant();
  const event={dedup_key:'fixture',alarm_id:'fixture',occurred_at:new Date(now).toISOString(),channel_id:'channel',input_stream_id:'input',stream_session_id:'session',behavior:'region_traverse',version:1,rule:{id:'counter',version:1,name:'vehicle',snapshot:{counter_id:'counter',alarm_enabled:false,review:{enabled:false},vehicle_capture:{model_pin:'a'.repeat(64),watchlist:policy}}},handling:{state:'unacknowledged',revision:0},evidence:{refs:[]},analysis_evidence:{track:{track_id:'t',label_id:'car'},source:{width:1920,height:1080},delivery:{state:'complete',frames:['a','b'].map(key=>({key,bbox:{x:10,y:10,w:500,h:500}}))}}};
  const id=await repo.behaviors.insert(event);await service.enqueue(event);
  const step=async()=>{await service.jobs.updateOne({_id:id},{$set:{next_at:0}});await service.step();};
  await work({repo,service,id,step,grant,calls:()=>calls,error:value=>{invokeError=value},advance:ms=>{now+=ms;grant()},job:()=>service.jobs.findOne({_id:id}),fact:()=>repo.behaviors.get(id)});
 }finally{await db.dropDatabase();await client.close();}
}
test('five temporary warmup failures preserve inference budget and recover',{skip:!uri},()=>fixture(async f=>{
 f.error('vehicle_not_ready');for(let i=0;i<5;i++)await f.step();assert.equal((await f.job()).state,'pending');assert.equal((await f.job()).inference_failures,0);assert.equal((await f.fact()).vehicle.state,'waiting_runtime');f.error(null);await f.step();assert.equal((await f.fact()).vehicle.text,'京A12345');assert.equal((await f.job()).state,'complete');
}));
test('alarm database outage never erases recognition or repeats inference',{skip:!uri},()=>fixture(async f=>{
 const insert=f.repo.insert.bind(f.repo);f.repo.insert=async()=>{throw Error('storage_unavailable')};for(let i=0;i<5;i++)await f.step();const v=(await f.fact()).vehicle;assert.equal(v.text,'京A12345');assert.equal(v.version,2);assert.equal(v.state,'consistent');assert.equal(v.delivery,'pending');assert.equal(f.calls(),2);f.repo.insert=insert;await f.step();assert.equal((await f.job()).state,'complete');assert.equal(await f.repo.events.countDocuments(),1);assert.equal(f.calls(),2);
}));
test('delivery timeout and explicit retry keep result version and checkpoints',{skip:!uri},()=>fixture(async f=>{
 const insert=f.repo.insert.bind(f.repo);f.repo.insert=async()=>{throw Error('storage_unavailable')};await f.step();f.advance(3600001);await f.step();assert.equal((await f.job()).state,'recognition_failed');assert.equal((await f.fact()).vehicle.text,'京A12345');assert.equal((await f.fact()).vehicle.version,2);f.repo.insert=insert;await f.service.retry(f.id,'operator');await f.step();assert.equal(f.calls(),2);assert.equal((await f.job()).state,'complete');
}));
test('manual correction during delivery outage suppresses automatic match',{skip:!uri},()=>fixture(async f=>{
 const insert=f.repo.insert.bind(f.repo);f.repo.insert=async()=>{throw Error('storage_unavailable')};await f.step();await f.service.correct(f.id,{text:'沪B12345',version:2},'operator');f.repo.insert=insert;await f.step();assert.equal((await f.fact()).vehicle.text,'沪B12345');assert.equal((await f.fact()).vehicle.version,3);assert.equal(await f.repo.events.countDocuments(),0);
}));
test('historical watchlist version survives later list edits',{skip:!uri},()=>fixture(async f=>{
 f.grant({watchlist:{version:2,digest:watchlistDigest(2,[])}});await f.step();assert.equal(await f.repo.events.countDocuments(),1);assert.equal((await f.repo.events.findOne()).analysis_evidence.vehicle.watchlist_version,1);
}));
test('three real inference failures terminate; unsupported size consumes no inference',{skip:!uri},()=>fixture(async f=>{
 f.error('vehicle_inference_failed');for(let i=0;i<3;i++)await f.step();assert.equal((await f.job()).state,'recognition_failed');assert.equal((await f.job()).inference_failures,3);await f.service.retry(f.id,'operator');f.repo.reviewContext.image=async()=>({width:7680,height:4320,data:Buffer.from('8k')});await f.service.jobs.updateOne({_id:f.id},{$set:{'event.analysis_evidence.source':{width:7680,height:4320}}});await f.step();assert.equal((await f.job()).reason,'unsupported_image');assert.equal(f.calls(),3);
}));

test('temporary missing source pauses queued recognition and recovers without manual retry',{skip:!uri},()=>fixture(async f=>{
 f.grant({channels:[],authorized_channels:['channel']});await f.step();assert.equal((await f.job()).state,'pending');assert.equal((await f.job()).reason,'vehicle_not_ready');assert.equal((await f.job()).inference_failures,0);assert.equal(f.calls(),0);f.grant({authorized_channels:['channel']});await f.step();assert.equal((await f.job()).state,'complete');assert.equal(f.calls(),2);
}));
test('explicit disable cancels queued jobs rather than waiting indefinitely',{skip:!uri},()=>fixture(async f=>{
 f.grant({channels:[],authorized_channels:[]});await f.step();assert.equal((await f.job()).state,'recognition_failed');assert.equal((await f.job()).reason,'configuration_changed');assert.equal(f.calls(),0);
}));

test('expired grants wait without cancelling and still honor the absolute deadline',{skip:!uri},()=>fixture(async f=>{
 f.service.config.expires_ms=0;await f.step();assert.equal((await f.job()).state,'pending');assert.equal(f.calls(),0);f.advance(3600001);f.service.config.expires_ms=0;await f.step();assert.equal((await f.job()).reason,'wait_expired');assert.equal((await f.job()).state,'recognition_failed');
}));
