import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
const frame=(seq,x)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_pts_ns:String(BigInt(seq)*1000000000n),captured_at:'2026-10-19T00:00:00Z',source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(BigInt(seq)*1000000000n),bbox:{x:x*1000-10,y:100,w:20,h:100}}]});
const envelope=(seq,x)=>({schema_version:'1.0',producer_id:'producer-durable-id',offset:String(seq),frame:frame(seq,x)});
// The target enters a zone right of x=0.7 (same path the former line-crossing case used).
const rule={id:'r',version:1,name:'Cross',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',points:[[.7,0],[1,0],[1,1],[.7,1]]};
async function isolated(fn){const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));try{const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule,0,'test');await fn(repo,db);}finally{await db.dropDatabase();await client.close();}}
for(const crashPoint of ['prepared','event_inserted','before_checkpoint']) {
  test(`recover prepared result after failure at ${crashPoint}; rules edits cannot alter replay`,{skip:!enabled},async()=>isolated(async(repo,db)=>{
    const normal=new ObservationConsumer(repo);await normal.consume(envelope(1,.5));
    let crashed=false;
    const broken=new ObservationConsumer(repo,{hook:async point=>{if(point===crashPoint&&!crashed){crashed=true;throw Error('injected process failure');}}});
    await assert.rejects(()=>broken.consume(envelope(2,.8)),/injected/);
    assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'1');
    await repo.saveRule({...rule,version:2,state:'paused'},1,'test');
    const recovered=new ObservationConsumer(new AlarmRepository(db));
    const response=await recovered.consume(envelope(2,.8));assert.equal(response.durable,true);
    assert.equal(await repo.events.countDocuments(),1);
    const event=await repo.events.findOne();assert.equal(event.rule.version,1);
    assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2');
    assert.equal((await recovered.consume(envelope(2,.8))).outcome,'already_consumed');
    assert.equal(await repo.events.countDocuments(),1);
  }));
}
test('expired lease fences checkpoint; new worker recovers same event',{skip:!enabled},async()=>isolated(async(repo)=>{
  let now=1000;await new ObservationConsumer(repo,{now:()=>now}).consume(envelope(1,.5));
  const expired=new ObservationConsumer(repo,{now:()=>now,leaseMs:10,hook:async point=>{if(point==='prepared')now+=11;}});
  await assert.rejects(()=>expired.consume(envelope(2,.8)),e=>e.code==='lease_expired');
  assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'1');
  await new ObservationConsumer(repo,{now:()=>now}).consume(envelope(2,.8));
  assert.equal(await repo.events.countDocuments(),1);
}));
test('offset content conflicts, producer changes, and transport gaps are explicit',{skip:!enabled},async()=>isolated(async(repo)=>{
  const consumer=new ObservationConsumer(repo);await consumer.consume(envelope(1,.5));
  await assert.rejects(()=>consumer.consume(envelope(1,.6)),e=>e.code==='offset_conflict');
  await assert.rejects(()=>consumer.consume({...envelope(2,.8),producer_id:'other'}),e=>e.code==='producer_changed');
  const response=await consumer.consume(envelope(3,.8));assert.deepEqual(response.issues,['input_gap']);assert.equal(await repo.events.countDocuments(),0);
}));
// Checkpoint writes are the alarm service's whole Mongo journal load (one per frame per channel).
async function monitored(fn){
  const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000,monitorCommands:true});await client.connect();
  const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule,0,'test');
    const writes=[];let recording=false;
    client.on('commandStarted',e=>{
      if(!recording||e.databaseName!==db.databaseName)return;
      const plain=e.commandName==='update',target=plain?e.command.update:e.commandName==='findAndModify'?e.command.findAndModify:null;
      if(target!==repo.checkpoints.collectionName)return;
      const changes=plain?e.command.updates.map(u=>u.u):[e.command.update];
      // The create-if-missing upsert changes nothing once the document exists.
      if(changes.every(u=>Object.keys(u).every(op=>op==='$setOnInsert')))return;
      writes.push({journaled:e.command.writeConcern?.j===true,pending:changes.some(u=>u.$set?.pending!=null)});
    });
    await fn(repo,db,{start(){writes.length=0;recording=true;},writes});
  }finally{await db.dropDatabase();await client.close();}
}
test('a frame with nothing to materialize commits its checkpoint in one journaled write and releases its lease',{skip:!enabled},async()=>monitored(async(repo,db,probe)=>{
  const consumer=new ObservationConsumer(repo);await consumer.consume(envelope(1,.5));
  probe.start();
  const response=await consumer.consume(envelope(2,.55));
  assert.equal(response.outcome,'consumed');assert.deepEqual(response.events,[]);
  // Lease acquisition and the commit; no prepared copy of the checkpoint, no separate release.
  assert.equal(probe.writes.length,2,JSON.stringify(probe.writes));
  assert.equal(probe.writes.filter(w=>w.pending).length,0);
  assert.equal(probe.writes.filter(w=>w.journaled).length,1);
  const saved=await repo.checkpoints.findOne({channel_id:'c'});
  assert.equal(saved.offset,'2');assert.equal(saved.pending,null);assert.equal(saved.lease_until,0);assert.equal('lease_token' in saved,false);
}));
test('a frame with nothing to materialize lost before its commit is simply evaluated again',{skip:!enabled},async()=>isolated(async(repo,db)=>{
  await new ObservationConsumer(repo).consume(envelope(1,.5));
  let crashed=false;
  const broken=new ObservationConsumer(repo,{hook:async point=>{if(point==='before_checkpoint'&&!crashed){crashed=true;throw Error('injected process failure');}}});
  await assert.rejects(()=>broken.consume(envelope(2,.55)),/injected/);
  const left=await repo.checkpoints.findOne({channel_id:'c'});
  assert.equal(left.offset,'1');assert.equal(left.pending,null);assert.equal(left.lease_until,0);
  // Nothing was prepared or materialized: no stored outcome, nothing to finish.
  const recovered=new ObservationConsumer(new AlarmRepository(db));
  assert.equal((await recovered.consume(envelope(2,.55))).outcome,'consumed');
  assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2');
  assert.equal((await recovered.consume(envelope(2,.55))).outcome,'already_consumed');
}));
test('durable-later commits skip the journal until one barrier; pins and acknowledgements wait for it',{skip:!enabled},async()=>{
  const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000,monitorCommands:true});await client.connect();
  const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule,0,'test');
    const journaled=[];client.on('commandStarted',e=>{if(e.databaseName===db.databaseName&&e.command.writeConcern?.j===true)journaled.push(e.commandName);});
    const consumer=new ObservationConsumer(repo),spool=[];
    consumer.spool={protect:async()=>{},settle:async(checkpoint,channel)=>{spool.push('settle:'+channel+':'+checkpoint.seq);},acknowledge:async()=>{spool.push('ack');},flushAcknowledgements:async()=>{spool.push('flush');}};
    const later={deferAcknowledgement:true,deferDurability:true};
    const first=await consumer.consume(envelope(1,.5),later);
    assert.equal(first.durable,false);assert.equal(first.deferred,true);
    await consumer.consume(envelope(2,.55),later);
    assert.equal((await consumer.consume(envelope(2,.55),later)).outcome,'already_consumed');
    assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2','commits are visible at once');
    assert.deepEqual(journaled,[]);assert.deepEqual(spool,[],'no pin release or acknowledgement before the barrier');
    assert.equal(await consumer.makeDurable(),true);
    assert.equal(journaled.length,1,'one journaled barrier covers every earlier commit');
    // Only the newest state releases pins; the replayed frame is acknowledged after the barrier.
    assert.deepEqual(spool,['settle:c:2','ack','flush']);
    assert.equal(await consumer.makeDurable(),false);assert.equal(journaled.length,1);
    // Callers that do not ask for it keep a journaled commit per input.
    await consumer.consume(envelope(3,.6));assert.equal(journaled.length,2);
  }finally{await db.dropDatabase();await client.close();}
});
test('recovering an earlier prepared outcome keeps the lease for the input that found it',{skip:!enabled},async()=>isolated(async(repo,db)=>{
  await new ObservationConsumer(repo).consume(envelope(1,.5));
  let crashed=false;
  const broken=new ObservationConsumer(repo,{hook:async point=>{if(point==='before_checkpoint'&&!crashed){crashed=true;throw Error('injected process failure');}}});
  await assert.rejects(()=>broken.consume(envelope(2,.8)),/injected/);
  assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).pending);
  const recovered=new ObservationConsumer(new AlarmRepository(db));
  const response=await recovered.consume(envelope(3,.85));
  assert.equal(response.outcome,'consumed');
  const saved=await repo.checkpoints.findOne({channel_id:'c'});
  assert.equal(saved.offset,'3');assert.equal(saved.pending,null);assert.equal('lease_token' in saved,false);
  assert.equal(await repo.events.countDocuments(),1);
}));
