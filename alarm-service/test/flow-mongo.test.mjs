import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
const rule=id=>({id,assignment_id:id,counter_id:'c-'+id,trigger_version:1,version:1,name:id,channel_id:'p',input_stream_id:'in',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',
 behavior:'region_traverse',anchor:'bottom_center',zone_id:'z',zone_version:1,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],edge_ids:['top','right','bottom','left'],alarm_enabled:false,passage:{kind:'zone',max_gap_ms:1000}});
function input(i,x){const pts=String(i*1000000000);return {schema_version:'1.0',producer_id:'producer',offset:String(i),frame:{schema_version:'1.0',channel_id:'p',input_stream_id:'in',stream_session_id:'s',seq:String(i),frame_id:String(i),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,21,0,0,i)).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-10,y:520,w:20,h:20}}]}};}
test('Mongo counting: repeated trips, two bindings, durable replay, in/out series, totals/records agreement and coverage',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_flow_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  await repo.saveRule(rule('a'),0,'test');await repo.saveRule(rule('b'),0,'test');
  const consumer=new ObservationConsumer(repo),xs=[.2,.4,.6,.8,.6,.4,.2];
  for(let i=0;i<xs.length;i++){const f=input(i+1,xs[i]);await consumer.consume(f);await consumer.consume(f);}
  assert.equal(await repo.events.countDocuments(),0);assert.equal(await repo.behaviors.collection.countDocuments(),4);
  const window={rule_id:'a',label_ids:['person'],from:'2026-10-21T00:00:01Z',to:'2026-10-21T00:00:08Z'};
  const inward={...window,key:'in',filter:{kind:'edges',entry:['left'],exit:['right']}},outward={...window,key:'out',filter:{kind:'edges',entry:['right'],exit:['left']}};
  const result=await repo.flow.query({series:[inward,outward],bucket:'minute',timezone:'Asia/Shanghai'});
  assert.deepEqual(result.items.map(i=>[i.key,i.occurrences,i.tracked_targets]),[['in',1,1],['out',1,1]]);
  assert.equal(result.items[0].buckets.length,1);
  const early=await repo.flow.query({series:[{...inward,to:'2026-10-21T00:00:02Z'}]});assert.equal(early.items[0].coverage.state,'complete');
  const late=await repo.flow.query({series:[{...inward,to:'2026-10-21T00:01:00Z'}]});assert.equal(late.items[0].coverage.state,'partial');
  const other=await repo.flow.query({series:[{...inward,rule_id:'missing'}]});assert.equal(other.items[0].coverage.state,'no_data');assert.equal(other.items[0].occurrences,0);
  const records=await repo.flow.query({series:[inward],detail:true,limit:1});assert.equal(records.items.length,1);assert.equal(records.next_cursor,null);
  assert.equal(records.items[0].direction.entry_edge_id,'left');assert.equal(records.items[0].counter_id,'c-a');
  const both={...window,key:'all',filter:{kind:'angle',entry:{from:0,to:359},exit:{from:0,to:359}}};
  const page=await repo.flow.query({series:[both],detail:true,limit:1});assert.ok(page.next_cursor);
  const next=await repo.flow.query({series:[both],detail:true,limit:1,cursor:page.next_cursor});assert.notEqual(next.items[0].event_id,page.items[0].event_id);
  await assert.rejects(()=>repo.flow.query({series:[inward],detail:true,cursor:page.next_cursor}),e=>e.code==='invalid_cursor');
  // Deleting a counter purges only its own passages and coverage.
  await assert.rejects(()=>repo.flow.purge({counter_id:'c-a',rule_ids:[]}),e=>e.code==='invalid_purge');
  const purged=await repo.flow.purge({counter_id:'c-a',rule_ids:['a']});
  assert.ok(purged.facts>0&&purged.coverage>0);
  assert.equal(await repo.behaviors.collection.countDocuments({rule_id:'a'}),0);
  assert.ok(await repo.behaviors.collection.countDocuments({rule_id:'b'})>0);
  assert.ok(await repo.flow.coverage.countDocuments({assignment_id:'b'})>0);
  const f=input(8,.4);let broken=true;
  const fault=new ObservationConsumer(repo,{hook:async p=>{if(p==='before_checkpoint'&&broken){broken=false;throw Error('injected');}}});
  await assert.rejects(()=>fault.consume(f),/injected/);const n=await repo.flow.coverage.countDocuments();await fault.consume(f);assert.equal(await repo.flow.coverage.countDocuments(),n);
 }finally{await db.dropDatabase();await client.close();}
});

test('Mongo purge drains a prepared old frame under sustained arrivals and replay cannot resurrect deleted facts',{skip:!enabled},async()=>{
 const {createApp}=await import('../src/http.mjs');
 const {observationBarrier}=await import('../src/observation-barrier.mjs');
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_flow_drain_'+randomUUID().replaceAll('-','')),repo=new AlarmRepository(db);
 let release;const hold=new Promise(r=>{release=r});let prepared;const reached=new Promise(r=>{prepared=r});
 const app=createApp({repository:repo,apiToken:'a'.repeat(32)});
 try{
  await repo.initialize();await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[rule('a')]},'test');
  const normal=new ObservationConsumer(repo);await normal.consume(input(1,.2));await normal.consume(input(2,.4));await normal.consume(input(3,.6));
  const delayed=new ObservationConsumer(repo,{hook:async p=>{if(p==='prepared'){prepared();await hold}}});
  const old=delayed.consume(input(4,.8));await reached;
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'2',rules:[]},'test');
  await app.ready();const request=app.inject({method:'POST',url:'/v1/flow/purge',headers:{authorization:'Bearer '+'a'.repeat(32)},payload:{counter_id:'c-a',rule_ids:['a']}});
  // Wait until admission is fenced; no elapsed-time assumption about database IO.
  let fenced=false;
  for(let i=0;i<200&&!fenced;i++){
   try{observationBarrier(repo).enter()();}catch(e){assert.equal(e.code,'consumer_busy');fenced=true;}
   if(!fenced)await new Promise(r=>setTimeout(r,1));
  }
  assert.equal(fenced,true);
  for(let i=0;i<30;i++)await assert.rejects(normal.consume(input(5,.9)),e=>e.code==='consumer_busy');
  release();await old;assert.equal((await request).statusCode,200);
  assert.equal(await repo.behaviors.collection.countDocuments({counter_id:'c-a'}),0);
  await normal.consume(input(4,.8));await normal.consume(input(5,.9));
  assert.equal(await repo.behaviors.collection.countDocuments({counter_id:'c-a'}),0);
 }finally{release();await app.close();await db.dropDatabase();await client.close();}
});
