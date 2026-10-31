import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {createApp} from '../src/http.mjs';
import {RegionHeatQuery} from '../src/region-heat-query.mjs';
import {materializeRegionHeat} from '../src/region-heat.mjs';
import {heatEnvelope,heatRule,heatFrame,heatStep,origin} from './region-heat-fixtures.mjs';
const uri=process.env.AINVR_HEAT_TEST_MONGO_URI;
async function isolated(fn){
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});await client.connect();const db=client.db('ainvr_heat_'+randomUUID().replaceAll('-',''));
  try{await fn(db);}finally{try{await db.dropDatabase();}finally{await client.close();}}
}
const range={channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'};
for(const crash of ['prepared','heat_inserted','before_checkpoint'])test(`Mongo heat replay after ${crash} keeps immutable original minute`,{skip:!uri,timeout:45000},()=>isolated(async db=>{
  const repo=new AlarmRepository(db);await repo.initialize();let rules=[heatRule];repo.listRules=async()=>rules;
  const consumer=new ObservationConsumer(repo);await consumer.consume(heatEnvelope(1,{time:59800}));
  consumer.hook=async point=>{if(point===crash)throw Error('injected_heat_failure')};const input=heatEnvelope(2,{time:60200});
  await assert.rejects(consumer.consume(input),/injected_heat_failure/);
  const pending=await repo.checkpoints.findOne({channel_id:'c'});assert.equal(pending.offset,'1');assert.equal(pending.pending.heat_facts.length,1);
  rules=[{...heatRule,geometry_revision:'g2'}];const recovered=new ObservationConsumer(repo);await recovered.consume(input);await recovered.consume(input);
  const facts=db.collection('region_heat_minutes');assert.equal(await facts.countDocuments(),1);const fact=await facts.findOne();assert.equal(fact.geometry_revision,'g');assert.equal(fact.observed_ms,200);
  const query=await repo.heat.query(range);assert.equal(query.variants.length,1);assert.equal(query.variants[0].observed_ms,200);assert.equal(query.variants[0].input_stream_id,'in');assert.equal(query.coverage,'unknown');
  const edge=await repo.heat.query({...range,from:'2025-12-31T23:59:59.500Z',to:'2026-01-01T00:01:59.500Z'});
  assert.equal(edge.discarded_edges.length,2);assert.equal(edge.variants[0].observed_ms,200);assert.ok(edge.issues.includes('open_minute_lag'));
}));
test('Mongo heat combines compatible session totals while keeping geometry and inputs separate; coast time stays excluded', {skip:!uri,timeout:45000},()=>isolated(async db=>{
  const repo=new AlarmRepository(db);await repo.initialize();let rule=heatRule;repo.listRules=async()=>[rule];const consumer=new ObservationConsumer(repo);
  await consumer.consume(heatEnvelope(1,{time:100}));await consumer.consume(heatEnvelope(2,{time:200}));
  await consumer.consume(heatEnvelope(3,{time:300,observation:'lost'}));await consumer.consume(heatEnvelope(4,{time:400}));await consumer.consume(heatEnvelope(5,{time:500}));
  rule={...heatRule,geometry_revision:'g2'};await consumer.consume(heatEnvelope(6,{time:600,geometry:'g2'}));
  await consumer.consume(heatEnvelope(7,{time:700,geometry:'g2'}));
  await consumer.consume(heatEnvelope(8,{time:800,geometry:'g2',session:'s2'}));await consumer.consume(heatEnvelope(9,{time:900,geometry:'g2',session:'s2'}));
  const rebound=seq=>{const e=heatEnvelope(seq,{time:seq*100,geometry:'g2',session:'s2'});e.frame.input_stream_id='in2';return e};
  await consumer.consume(rebound(10));await consumer.consume(rebound(11));
  const end=heatEnvelope(12,{time:60000,geometry:'g2',session:'s2',empty:true});end.frame.input_stream_id='in2';await consumer.consume(end);
  const result=await repo.heat.query(range);assert.equal(result.variants.length,3);assert.equal(result.session_scope,'compatible_source_geometry');
  assert.equal(result.variants.find(v=>v.geometry_revision==='g').observed_ms,200);
  assert.equal(result.variants.filter(v=>v.geometry_revision==='g2').reduce((n,v)=>n+v.observed_ms,0),300);
  assert.equal(result.variants.find(v=>v.input_stream_id==='in'&&v.geometry_revision==='g2').observed_ms,200);
  assert.ok(result.variants.some(v=>v.input_stream_id==='in2'));assert.ok(result.variants.every(v=>v.label_map_version==='l'&&!Object.hasOwn(v,'stream_session_id')));
  assert.ok(await db.collection('region_heat_minutes').countDocuments({stream_session_id:'s2'})>0);
  const app=createApp({repository:repo,apiToken:'a'.repeat(32)});
  try{
    assert.equal((await app.inject({method:'POST',url:'/v1/flow/heat',payload:range})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/v1/flow/heat',headers:{authorization:'Bearer '+'a'.repeat(32)},payload:range})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/v1/flow/heat',headers:{authorization:'Bearer '+'a'.repeat(32)},payload:{...range,zone_id:undefined}})).statusCode,422);
  }finally{await app.close();}
}));
test('Mongo label-map stamps, model changes and unknown historical rows remain distinct across compatible sessions', {skip:!uri,timeout:45000},()=>isolated(async db=>{
  const repo=new AlarmRepository(db);await repo.initialize();let rule=heatRule;repo.listRules=async()=>[rule];const consumer=new ObservationConsumer(repo);
  await consumer.consume(heatEnvelope(1,{time:100}));await consumer.consume(heatEnvelope(2,{time:200}));await consumer.consume(heatEnvelope(3,{time:300,observation:'lost'}));
  rule={...heatRule,label_map_version:'l2'};
  const next=(seq,options)=>{const e=heatEnvelope(seq,options);e.frame.model.label_map_version='l2';return e;};
  await consumer.consume(next(4,{time:400}));await consumer.consume(next(5,{time:500}));await consumer.consume(next(6,{time:60000,empty:true}));
  const facts=db.collection('region_heat_minutes');assert.equal(await facts.countDocuments(),2);
  let result=await repo.heat.query(range);assert.equal(result.variants.length,2);assert.equal(result.variants.find(v=>v.label_map_version==='l').observed_ms,100);assert.equal(result.variants.find(v=>v.label_map_version==='l2').observed_ms,100);
  assert.ok(!result.issues.includes('heat_label_map_unknown'));
  const original=await facts.findOne({label_map_version:'l'}),{label_map_version,...legacy}=original;
  await facts.insertMany([{...legacy,_id:'legacy1',stream_session_id:'old1'},{...legacy,_id:'legacy2',stream_session_id:'old2'}]);
  result=await repo.heat.query(range);assert.equal(result.variants.length,3);assert.equal(result.variants.find(v=>v.label_map_version===null).observed_ms,200);assert.ok(result.issues.includes('heat_label_map_unknown'));
  assert.equal(result.session_scope,'compatible_source_geometry');assert.equal(await facts.countDocuments({label_map_version:{$exists:false}}),2);
}));
test('Mongo shared pending capacity drops only heat first, preserves dwell and materializes base alarms', {skip:!uri,timeout:45000},()=>isolated(async db=>{
  const repo=new AlarmRepository(db);await repo.initialize();repo.listRules=async()=>[heatRule,{...heatRule,id:'alarm',alarm_enabled:true,behavior:'appearance'}];
  const consumer=new ObservationConsumer(repo);await consumer.consume(heatEnvelope(1,{time:100}));
  await repo.checkpoints.updateOne({channel_id:'c'},{$set:{'checkpoint.region_heat.padding':'x'.repeat(7*1024*1024)}});
  const e=heatEnvelope(2,{time:200});e.frame.tracks.push({...e.frame.tracks[0],track_id:'t2'});
  const result=await consumer.consume(e);assert.equal(result.durable,true);assert.ok(result.issues.includes('heat_capacity'));assert.ok(!result.issues.includes('dwell_capacity'));
  assert.equal(await repo.events.countDocuments(),2);const cp=await repo.checkpoints.findOne({channel_id:'c'});
  assert.equal(cp.checkpoint.region_heat.disabled_session,'s');assert.equal(cp.checkpoint.dwell.disabled_session,undefined);assert.ok(Object.values(cp.checkpoint.dwell.visits).some(v=>v.observed_ms===100));
  const heat=await repo.heat.query(range);assert.equal(heat.status,'capacity_suspended');assert.equal(heat.gaps.length,1);
}));
test('Mongo heat rolling retention enforces both caps, idempotency and refusal without deleting existing uncapped data', {skip:!uri,timeout:45000},()=>isolated(async db=>{
  const query=new RegionHeatQuery(db,{maxBytes:16384,maxRows:2});await query.initialize();
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const base=a.facts[0];
  for(let i=0;i<5;i++)await materializeRegionHeat(db,[{...base,_id:`h${i}`,from:new Date(origin+i*60000).toISOString(),to:new Date(origin+(i+1)*60000).toISOString()}]);
  await materializeRegionHeat(db,[{...base,_id:'h4'}]);assert.equal(await query.facts.countDocuments(),2);
  const retained=await query.query({...range,to:'2026-01-01T00:05:00Z'});assert.equal(retained.retention.max_rows,2);assert.equal(retained.retention.max_bytes,16384);assert.equal(retained.retention.oldest_available_at,'2026-01-01T00:03:00.000Z');
  // Only this private randomized database's fixture is removed for the second cap.
  await query.facts.drop();const bytes=new RegionHeatQuery(db,{maxBytes:4096,maxRows:100});await bytes.initialize();
  for(let i=0;i<20;i++)await materializeRegionHeat(db,[{...base,_id:`b${i}`}]);assert.ok(await bytes.facts.countDocuments()<20);
  await bytes.facts.drop();await db.createCollection('region_heat_minutes');await db.collection('region_heat_minutes').insertOne({_id:'preserve'});
  await assert.rejects(new RegionHeatQuery(db).initialize(),/Unsupported region_heat_minutes collection/);assert.equal(await db.collection('region_heat_minutes').countDocuments(),1);
}));
test('Mongo streams over 5000 retained minute summaries for 7/30 day ranges without truncation', {skip:!uri,timeout:45000},async t=>isolated(async db=>{
  const query=new RegionHeatQuery(db);await query.initialize();
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const base=a.facts[0];
  // Batch only the fixture writes as well: the test never holds 6000 grids.
  for(let offset=0;offset<6000;offset+=256){
    const batch=[];
    for(let i=offset;i<Math.min(6000,offset+256);i++)batch.push({...base,_id:`minute${i}`,from:new Date(origin+i*60000).toISOString(),to:new Date(origin+(i+1)*60000).toISOString()});
    await query.facts.insertMany(batch);
  }
  const later={...base,_id:'day8',from:new Date(origin+8*86400000).toISOString(),to:new Date(origin+8*86400000+60000).toISOString()};
  await query.facts.insertMany([later,{...base,_id:'other_zone',zone_id:'elsewhere'},{...base,_id:'other_label',label_id:'vehicle'}]);
  assert.equal(await query.facts.countDocuments(),6003);
  const started=performance.now();
  const seven=await query.query({...range,to:'2026-01-08T00:00:00Z',label_ids:['person']});
  const thirty=await query.query({...range,to:'2026-01-31T00:00:00Z',label_ids:['person']});
  assert.equal(seven.variants.length,1);assert.equal(seven.variants[0].observed_ms,6000*200);assert.equal(seven.variants[0].values_ms.reduce((a,b)=>a+b,0),6000*200);
  assert.equal(thirty.variants[0].observed_ms,6001*200);assert.equal(thirty.variants[0].to,later.to);assert.equal(thirty.consistency,'non_transactional');assert.equal(thirty.coverage,'unknown');
  const narrow=await query.query({...range,from:new Date(origin+5000*60000).toISOString(),to:new Date(origin+6000*60000).toISOString(),label_ids:['person']});
  assert.equal(narrow.variants[0].observed_ms,1000*200);assert.equal(narrow.variants[0].from,new Date(origin+5000*60000).toISOString());
  t.diagnostic(`Three bounded streaming queries over 6003 retained rows: ${Math.round(performance.now()-started)} ms`);
}));
