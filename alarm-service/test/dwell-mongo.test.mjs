import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {DwellQuery} from '../src/dwell-query.mjs';
import {materializeDwell} from '../src/dwell-visits.mjs';

const uri=process.env.AINVR_DWELL_TEST_MONGO_URI;
const rule={id:'counter',name:'counter',version:1,channel_id:'c',state:'enabled',label_ids:['person'],
  geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',alarm_enabled:false,
  zone_id:'z',zone_version:1,points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
const envelope=(seq,{x=.4,channel='c',session='s',time=seq*1000,observation='detected',eligible=true,last=time}={})=>{
  const pts=String(BigInt(time)*1000000n),at=new Date(Date.UTC(2026,0,1)+time).toISOString();
  return {schema_version:'1.0',producer_id:'producer',offset:String(seq),frame:{schema_version:'1.0',channel_id:channel,input_stream_id:'in',stream_session_id:session,
    seq:String(seq),frame_id:`${session}:${seq}`,source_pts_ns:pts,captured_at:at,source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},
    model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation,event_eligible:eligible,last_observed_pts_ns:String(BigInt(last)*1000000n),bbox:{x:x*100,y:30,w:10,h:10}}]}};
};
test('Mongo checkpoint replay, active race, restart recovery and dwell-only capacity', {skip:!uri,timeout:45000},async()=>{
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});await client.connect();
  const db=client.db('ainvr_dwell_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();repo.listRules=async channel=>channel==='c'?[rule]:channel==='capacity'?[{...rule,id:'alarm',channel_id:'capacity',behavior:'appearance',alarm_enabled:true}]:[];
    const consumer=new ObservationConsumer(repo);await consumer.consume(envelope(1));await consumer.consume(envelope(2));
    const before=await repo.checkpoints.findOne({channel_id:'c'});const activeId=Object.values(before.checkpoint.dwell.visits)[0]._id;
    const crashed=new ObservationConsumer(repo,{hook:async point=>{if(point==='dwell_inserted')throw Error('after_dwell');}});
    // Preserve the active consumer identity here to isolate the pending write race.
    crashed.dwellStarted.add('c');
    await assert.rejects(crashed.consume(envelope(3,{x:.9})),/after_dwell/);
    assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    const race=await repo.dwell.query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
    assert.equal(race.visits_started,1);assert.equal(race.active_visits,0);assert.equal(race.observed_ms,1000);
    assert.equal(race.visits[0].visit_id,activeId);assert.equal(race.checkpoint_at,before.last_consumed_at);assert.equal(race.consistency,'non_transactional');
    const restarted=new ObservationConsumer(repo);assert.equal((await restarted.consume(envelope(3,{x:.9}))).outcome,'already_consumed');
    assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    await restarted.consume(envelope(4,{x:.9}));assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    // Crash after preparing the first fresh frame, then recover it repeatedly.
    const prepareCrash=new ObservationConsumer(repo,{hook:async point=>{if(point==='prepared')throw Error('prepared_crash');}});
    await assert.rejects(prepareCrash.consume(envelope(5)),/prepared_crash/);
    const again=new ObservationConsumer(repo);assert.equal((await again.consume(envelope(5))).outcome,'already_consumed');
    await new ObservationConsumer(repo).consume(envelope(6));
    assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).last_issues.includes('dwell_restart_unmeasured'));
    // Exit the actual worker process after prepare, without releasing its lease.
    const childCode=`import {MongoClient} from 'mongodb';import {AlarmRepository} from './src/repository.mjs';import {ObservationConsumer} from './src/ingestion.mjs';
      const client=new MongoClient(process.env.AINVR_DWELL_TEST_MONGO_URI);await client.connect();
      const repo=new AlarmRepository(client.db(process.env.DWELL_TEST_DB));repo.listRules=async()=>[JSON.parse(process.env.DWELL_TEST_RULE)];
      const consumer=new ObservationConsumer(repo,{now:()=>10000,leaseMs:10,hook:async point=>{if(point==='prepared')process.exit(73)}});
      await consumer.consume(JSON.parse(process.env.DWELL_TEST_ENVELOPE));process.exit(74);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',childCode],{env:{...process.env,DWELL_TEST_DB:db.databaseName,DWELL_TEST_RULE:JSON.stringify(rule),DWELL_TEST_ENVELOPE:JSON.stringify(envelope(7))},timeout:10000});
    assert.equal(child.status,73,'worker must exit after durable prepare');
    assert.equal((await new ObservationConsumer(repo).consume(envelope(7))).outcome,'already_consumed');
    await new ObservationConsumer(repo).consume(envelope(8));
    assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).last_issues.includes('dwell_restart_unmeasured'));

    // Simulate an oversized derived checkpoint without filling alarm state.
    await repo.checkpoints.insertOne({channel_id:'capacity',producer_id:'producer',offset:'1',fingerprint:'old',pending:null,lease_until:0,generation:0,
      checkpoint:{session:'s',seq:'1',pts:'1000000000',states:{},episodes:{},first_seen:{},dwell:{visits:{},padding:'x'.repeat(7*1024*1024)}}});
    const cap=new ObservationConsumer(repo);const result=await cap.consume(envelope(2,{channel:'capacity'}));
    assert.equal(result.durable,true);assert.ok(result.issues.includes('dwell_capacity'));
    assert.equal(await repo.events.countDocuments({channel_id:'capacity'}),1);
    let cp=await repo.checkpoints.findOne({channel_id:'capacity'});assert.equal(cp.offset,'2');assert.equal(cp.checkpoint.dwell.disabled_session,'s');assert.equal(cp.checkpoint.dwell_gaps[0].reason,'dwell_capacity');
    await cap.consume(envelope(3,{channel:'capacity'}));cp=await repo.checkpoints.findOne({channel_id:'capacity'});assert.equal(cp.checkpoint.dwell.disabled_session,'s');
    const status=await repo.dwell.query({channel_id:'capacity',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
    assert.equal(status.dwell_status,'capacity_suspended');assert.ok(status.last_issues.includes('dwell_capacity'));assert.equal(status.gaps.length,1);
    await cap.consume(envelope(4,{channel:'capacity',session:'new'}));cp=await repo.checkpoints.findOne({channel_id:'capacity'});assert.equal(cp.checkpoint.dwell.disabled_session,undefined);assert.ok(cp.checkpoint.dwell_gaps[0].to);
  }finally{try{await db.dropDatabase();}finally{await client.close();}}
});
test('Mongo sparse detections persist one segmented visit and replay deduplicates its active snapshot', {skip:!uri,timeout:45000},async()=>{
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});await client.connect();const db=client.db('ainvr_ds_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();repo.listRules=async()=>[rule];
    const consumer=new ObservationConsumer(repo);
    await consumer.consume(envelope(1,{time:59800}));await consumer.consume(envelope(2,{time:59900}));
    await consumer.consume(envelope(3,{time:60000,observation:'lost',last:59900}));
    await consumer.consume(envelope(4,{time:60100}));await consumer.consume(envelope(5,{time:60400}));
    const request={channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:59Z',to:'2026-01-01T00:01:01Z',bucket:'minute'};
    const active=await repo.dwell.query(request);assert.equal(active.active_visits,1);assert.equal(active.visits_started,1);assert.equal(active.observed_ms,400);
    consumer.hook=async point=>{if(point==='dwell_inserted')throw Error('sparse_failure');};
    const exit=envelope(6,{time:60500,x:.9});await assert.rejects(consumer.consume(exit),/sparse_failure/);
    const race=await repo.dwell.query(request);assert.equal(race.visits_started,1);assert.equal(race.active_visits,0);assert.equal(race.observed_ms,400);
    const recovered=new ObservationConsumer(repo);await recovered.consume(exit);await recovered.consume(exit);
    assert.equal(await db.collection('region_dwell_visits').countDocuments(),1);
    const fact=await db.collection('region_dwell_visits').findOne();assert.equal(fact.observed_intervals.length,2);assert.equal(fact.observation_gaps,true);assert.equal(fact.end_reason,'observed_exit');
    const sub=await repo.dwell.query({...request,from:'2026-01-01T00:00:59.850Z',to:'2026-01-01T00:01:00.250Z'});
    assert.equal(sub.observed_ms,200);assert.deepEqual(sub.buckets.map(x=>x.observed_ms),[50,150]);assert.deepEqual(sub.unknown_boundary_ranges,[]);
  }finally{try{await db.dropDatabase();}finally{await client.close();}}
});
test('Mongo rolling retention evicts old facts, preserves idempotency and refuses uncapped collections', {skip:!uri,timeout:45000},async()=>{
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});await client.connect();
  const name='ainvr_dr_'+randomUUID().replaceAll('-',''),db=client.db(name),legacy=client.db(name+'_legacy'),bytesDb=client.db(name+'_bytes');
  try{
    const query=new DwellQuery(db,{maxBytes:16384,maxVisits:3});await query.initialize();await query.initialize();
    const info=await db.listCollections({name:'region_dwell_visits'}).next();assert.equal(info.options.capped,true);assert.equal(Number(info.options.max),3);
    const rows=Array.from({length:5},(_,i)=>{const start=new Date(Date.UTC(2026,0,1)+i*2000).toISOString(),end=new Date(Date.UTC(2026,0,1)+i*2000+1000).toISOString();return {_id:`v${i}`,channel_id:'c',zone_id:'z',started_at:start,ended_at:end,observed_ms:1000};});
    for(const row of rows)await materializeDwell(db,[row]);
    await materializeDwell(db,[rows[4]]);
    assert.equal(await query.facts.countDocuments(),3);
    assert.deepEqual((await query.facts.find().sort({_id:1}).toArray()).map(x=>x._id),['v2','v3','v4']);
    const result=await query.query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
    assert.equal(result.visits_started,3);assert.equal(result.coverage,'unknown');assert.equal(result.retention.mode,'rolling');
    assert.equal(result.retention.max_visits,3);assert.equal(result.retention.max_bytes,16384);assert.equal(result.retention.oldest_available_at,rows[2].started_at);assert.equal(result.retention.history_complete,false);
    const empty=await query.query({channel_id:'c',zone_id:'z',from:'2025-01-01T00:00:00Z',to:'2025-01-02T00:00:00Z'});
    assert.equal(empty.visits_started,0);assert.equal(empty.coverage,'unknown');assert.equal(empty.retention.history_complete,false);
    const bytesQuery=new DwellQuery(bytesDb,{maxBytes:4096,maxVisits:100});await bytesQuery.initialize();
    for(let i=0;i<20;i++)await materializeDwell(bytesDb,[{...rows[i%5],_id:`byte${i}`,padding:'x'.repeat(1024)}]);
    assert.ok(await bytesQuery.facts.countDocuments()<20,'byte limit must evict facts before count limit');
    await legacy.createCollection('region_dwell_visits');await legacy.collection('region_dwell_visits').insertOne({_id:'preserve'});
    await assert.rejects(new DwellQuery(legacy).initialize(),/Unsupported region_dwell_visits collection/);
    assert.equal(await legacy.collection('region_dwell_visits').countDocuments(),1);
  }finally{try{await db.dropDatabase();}finally{try{await legacy.dropDatabase();}finally{try{await bytesDb.dropDatabase();}finally{await client.close();}}}}
});
