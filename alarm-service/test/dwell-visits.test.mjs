import test from 'node:test';
import assert from 'node:assert/strict';
import {dwellStep,materializeDwell} from '../src/dwell-visits.mjs';
import {DwellQuery} from '../src/dwell-query.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';

const base={id:'counter1',name:'counter',version:1,channel_id:'camera',state:'enabled',label_ids:['person'],
  geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',alarm_enabled:false,
  zone_id:'zone',zone_version:1,points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
const frame=(seq,{x=.4,session='s',observation='detected',eligible=true,mode='tracks',time=seq*1000}={})=>({
  channel_id:'camera',input_stream_id:'in',stream_session_id:session,seq:String(seq),source_pts_ns:String(BigInt(time)*1000000n),
  frame_id:`${session}:${seq}`,captured_at:new Date(Date.UTC(2026,0,1)+time).toISOString(),observation_mode:mode,
  source:{width:100,height:100,geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation,event_eligible:eligible,bbox:{x:x*100,y:30,w:10,h:10}}]});
function step(state,f,rules=[base],extra={}){return dwellStep(state,f,rules,extra);}
function queryRows(rows){return new DwellQuery({collection:name=>name==='region_dwell_visits'?{find:()=>({sort(){return this},limit(){return this},async toArray(){return rows}}),findOne:async()=>null}:{findOne:async()=>null}});}
test('one lower-bound fact per zone despite multiple counters, including without traversal',()=>{
  let a=step(null,frame(1),[base,{...base,id:'counter2'}]);
  a=step(a.state,frame(2),[base,{...base,id:'counter2'}]);
  a=step(a.state,frame(3,{x:.9}),[base,{...base,id:'counter2'}]);
  assert.equal(a.facts.length,1);assert.equal(a.facts[0].observed_ms,1000);assert.equal(a.facts[0].end_reason,'observed_exit');assert.equal(a.facts[0].partial,true);
});
test('gaps, restarts, session changes and zone version changes close partial visits',()=>{
  for(const kind of ['gap','restart','session','version']){
    let a=step(null,frame(1));a=step(a.state,frame(2));
    const next=kind==='session'?frame(3,{session:'new'}):frame(3);
    const options=kind==='gap'?{gap:true,previous:{session:'s',seq:'2',pts:'2000000000'}}:kind==='restart'?{restart:true}:kind==='session'?{previous:{session:'s',seq:'2',pts:'2000000000'}}:{};
    a=step(a.state,next,kind==='version'?[{...base,zone_version:2}]:[base],options);
    assert.equal(a.facts.length,1,kind);assert.equal(a.facts[0].observed_ms,1000,kind);assert.equal(a.facts[0].partial,true);
  }
});
test('duration budget truncates once and suppresses further visits until exit',()=>{
  let a=step(null,frame(1));a=step(a.state,frame(2));
  Object.values(a.state.visits)[0].start_ms-=3600001;
  a=step(a.state,frame(3));assert.equal(a.facts[0].end_reason,'duration_limit');
  a=step(a.state,frame(4));assert.equal(a.facts.length,0);
  a=step(a.state,frame(5,{x:.9}));assert.equal(a.facts.length,0);
  a=step(a.state,frame(6));assert.equal(Object.keys(a.state.visits).length,1);
});
test('short predicted, noneligible and missing observations retain identity without elapsed time',()=>{
  for(const kind of ['predicted','lost','noneligible','missing']){
    let a=step(null,frame(1,{time:0}));a=step(a.state,frame(2,{time:100}));
    const interrupted=frame(3,{time:200,observation:['predicted','lost'].includes(kind)?kind:'detected',eligible:kind!=='noneligible'});
    if(kind==='missing')interrupted.tracks=[];
    a=step(a.state,interrupted);
    assert.equal(a.facts.length,0);const held=Object.values(a.state.visits)[0];
    assert.equal(held._pts,'100000000');assert.equal(held._wall,Date.UTC(2026,0,1)+100);assert.equal(held.observed_ms,100);
    a=step(a.state,frame(4,{time:300}));a=step(a.state,frame(5,{time:400}));a=step(a.state,frame(6,{time:500,x:.9}));
    assert.equal(a.facts.length,1,kind);const fact=a.facts[0];
    assert.equal(fact.observed_ms,200);assert.equal(fact.observation_gaps,true);assert.equal(fact.end_reason,'observed_exit');
    const start=Date.UTC(2026,0,1);assert.deepEqual(fact.observed_intervals,[[start,start+100],[start+300,start+400]]);
  }
});
test('real-predicted-real is one zero-measured visit, detections-only cannot retain identity',()=>{
  let a=step(null,frame(1,{time:0}));a=step(a.state,frame(2,{time:100,observation:'predicted'}));a=step(a.state,frame(3,{time:200}));a=step(a.state,frame(4,{time:300,x:.9}));
  assert.equal(a.facts.length,1);assert.equal(a.facts[0].observed_ms,0);assert.deepEqual(a.facts[0].observed_intervals,[]);
  a=step(null,frame(1));a=step(a.state,frame(2,{mode:'detections'}));assert.equal(a.facts[0].end_reason,'tracking_unavailable');assert.equal(Object.keys(a.state.visits).length,0);
});
test('long gaps end visits; confirmed outside and configuration changes end a short coast',()=>{
  let a=step(null,frame(1,{time:0}));a=step(a.state,frame(2,{time:100}));a=step(a.state,frame(3,{time:200,observation:'predicted'}));
  a=step(a.state,frame(4,{time:1601,observation:'predicted'}));assert.equal(a.facts[0].end_reason,'observation_gap');assert.equal(a.facts[0].observed_ms,100);
  a=step(a.state,frame(5,{time:1700}));assert.equal(Object.keys(a.state.visits).length,1);
  for(const kind of ['outside','version','removed']){
    let b=step(null,frame(1,{time:0}));b=step(b.state,frame(2,{time:100}));b=step(b.state,frame(3,{time:200,observation:'predicted'}));
    b=step(b.state,frame(4,{time:300,x:kind==='outside'?.9:.4,observation:kind==='outside'?'detected':'predicted'}),kind==='version'?[{...base,zone_version:2}]:kind==='removed'?[]:[base]);
    assert.equal(b.facts.length,1,kind);assert.equal(b.facts[0].end_reason,kind==='outside'?'observed_exit':'configuration_changed');assert.equal(b.facts[0].observed_ms,100);
  }
});
test('temporal interval budget truncates once and suppresses until observed exit',()=>{
  let a=step(null,frame(1,{time:0})),seq=1,limitFact;
  for(let i=0;i<129;i++){
    a=step(a.state,frame(++seq,{time:i*300+100}));if(a.facts.length)limitFact=a.facts[0];
    a=step(a.state,frame(++seq,{time:i*300+200,observation:'predicted'}));
    a=step(a.state,frame(++seq,{time:(i+1)*300}));
  }
  assert.equal(limitFact.end_reason,'interval_limit');assert.equal(limitFact.observed_intervals.length,128);assert.equal(limitFact.observed_ms,12800);
  a=step(a.state,frame(++seq,{time:38800}));assert.equal(a.facts.length,0);assert.equal(Object.values(a.state.visits)[0]._blocked,true);
  a=step(a.state,frame(++seq,{time:38900,x:.9}));assert.equal(a.facts.length,0);assert.equal(Object.keys(a.state.visits).length,0);
});
test('replayed materialization after injected failure writes one stable fact',async()=>{
  let a=step(null,frame(1));a=step(a.state,frame(2));a=step(a.state,frame(3,{x:.9}));
  const docs=new Map(),db={collection:()=>({bulkWrite:async ops=>{for(const {updateOne:o} of ops)if(!docs.has(o.filter._id))docs.set(o.filter._id,o.update.$setOnInsert);}})};
  await assert.rejects(materializeDwell(db,a.facts,async()=>{throw Error('crash');}),/crash/);
  await materializeDwell(db,a.facts);await materializeDwell(db,a.facts);
  assert.equal(docs.size,1);
});
test('query uses visit starts for counts, minute slices for buckets and no images',async()=>{
  let a=step(null,frame(59));a=step(a.state,frame(60));a=step(a.state,frame(61,{x:.9}));
  const collection={find:()=>({sort(){return this},limit(){return this},async toArray(){return a.facts}}),findOne:async()=>null};
  const q=new DwellQuery({collection:()=>collection});
  const out=await q.query({channel_id:'camera',zone_id:'zone',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:02:00Z',bucket:'minute',thresholds:[1000]});
  assert.equal(out.visits_started,1);assert.equal(out.observed_ms,1000);assert.equal(out.thresholds_ms[1000],1);
  assert.equal(out.buckets[0].start,'2026-01-01T00:00:00.000Z');assert.equal(out.samples[0].first_frame_id,'s:59');assert.equal(out.coverage,'unknown');
  const partial=await q.query({channel_id:'camera',zone_id:'zone',from:'2026-01-01T00:00:59.500Z',to:'2026-01-01T00:02:00Z'});
  assert.equal(partial.observed_ms,500);assert.deepEqual(partial.unknown_boundary_ranges,[]);
});
test('segmented visit query clips exact subranges and minute boundaries without filling coasts',async()=>{
  let a=step(null,frame(1,{time:59800}));a=step(a.state,frame(2,{time:59900}));a=step(a.state,frame(3,{time:60000,observation:'predicted'}));a=step(a.state,frame(4,{time:60100}));a=step(a.state,frame(5,{time:60400}));a=step(a.state,frame(6,{time:60500,x:.9}));
  const query=queryRows(a.facts),request={channel_id:'camera',zone_id:'zone',bucket:'minute'};
  const sub=await query.query({...request,from:'2026-01-01T00:00:59.850Z',to:'2026-01-01T00:01:00.250Z'});
  assert.equal(sub.observed_ms,200);assert.deepEqual(sub.buckets.map(b=>b.observed_ms),[50,150]);assert.deepEqual(sub.unknown_boundary_ranges,[]);
  const gap=await query.query({...request,from:'2026-01-01T00:00:59.950Z',to:'2026-01-01T00:01:00.050Z'});assert.equal(gap.observed_ms,0);assert.equal(gap.coverage,'unknown');
  const full=await query.query({...request,from:'2026-01-01T00:00:59Z',to:'2026-01-01T00:01:01Z',thresholds:[400,401]});
  assert.equal(full.visits_started,1);assert.equal(full.observed_ms,400);assert.equal(full.thresholds_ms[400],1);assert.equal(full.thresholds_ms[401],0);assert.equal(full.samples[0].observation_gaps,true);assert.equal(full.samples[0].observed_interval_count,2);
});
test('continuous historical checkpoints upgrade and malformed temporal intervals stay unknown',async()=>{
  let a=step(null,frame(1,{time:0}));a=step(a.state,frame(2,{time:100}));
  const old=Object.values(a.state.visits)[0];delete old.observed_intervals;old.minutes={};
  a=step(a.state,frame(3,{time:200,eligible:false}));a=step(a.state,frame(4,{time:300}));a=step(a.state,frame(5,{time:400}));a=step(a.state,frame(6,{time:500,x:.9}));
  assert.equal(a.facts[0].observed_ms,200);assert.equal(a.facts[0].observed_intervals.length,2);
  const malformed={...a.facts[0],observed_intervals:[[Date.UTC(2026,0,1),Date.UTC(2026,0,1)+400]]};
  const unknown=await queryRows([malformed]).query({channel_id:'camera',zone_id:'zone',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
  assert.equal(unknown.observed_ms,0);assert.equal(unknown.unknown_boundary_ranges[0].reason,'invalid_visit_interval');
});
test('active checkpoint is visible and is deduplicated if already materialized',async()=>{
  let a=step(null,frame(1));a=step(a.state,frame(2));
  let facts=[];const collections={region_dwell_visits:{find:()=>({sort(){return this},limit(){return this},async toArray(){return facts}}),findOne:async()=>null},
    alarm_consumer_checkpoints:{findOne:async()=>({checkpoint:{dwell:a.state},last_consumed_at:'2026-01-01T00:00:02Z'})}};
  const query=new DwellQuery({collection:name=>collections[name]});
  const req={channel_id:'camera',zone_id:'zone',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z',timezone:'Asia/Shanghai'};
  const active=await query.query(req);assert.equal(active.active_visits,1);assert.equal(active.visits_started,1);assert.equal(active.observed_ms,1000);assert.equal(active.samples[0].active,true);
  assert.equal(active.sample_scope,'bounded_visits_started_in_range');assert.equal(active.threshold_scope,'clipped_observed_duration_for_visits_started_in_range');
  const ended=step(a.state,frame(3,{x:.9}));facts=ended.facts;
  const race=await query.query(req);assert.equal(race.active_visits,0);assert.equal(race.visits_started,1);assert.equal(race.observed_ms,1000);
});
test('time buckets preserve both repeated DST hours and arbitrary boundaries',async()=>{
  const rows=[{_id:'a',started_at:'2026-11-01T05:30:00.000Z',ended_at:'2026-11-01T05:30:01.000Z',observed_ms:1000},{_id:'b',started_at:'2026-11-01T06:30:00.000Z',ended_at:'2026-11-01T06:30:02.000Z',observed_ms:2000}];
  const collections={region_dwell_visits:{find:()=>({sort(){return this},limit(){return this},async toArray(){return rows}}),findOne:async()=>null},alarm_consumer_checkpoints:{findOne:async()=>null}};
  const out=await new DwellQuery({collection:name=>collections[name]}).query({channel_id:'camera',zone_id:'zone',from:'2026-11-01T05:00:05Z',to:'2026-11-01T07:00:09Z',timezone:'America/New_York'});
  assert.deepEqual(out.buckets.map(b=>b.start),['2026-11-01T05:00:00.000Z','2026-11-01T06:00:00.000Z']);
  assert.equal(out.observed_ms,3000);assert.equal(out.unknown_boundary_ranges.length,0);
});
test('conflicting simultaneous polygon versions are skipped instead of duplicating a visit',()=>{
  const a=step(null,frame(1),[base,{...base,id:'counter2',zone_version:2}]);
  assert.equal(Object.keys(a.state.visits).length,0);assert.ok(a.issues.includes('dwell_region_conflict'));
});
test('consumer recovers a prepared visit after materialization failure before checkpoint',async()=>{
  let doc=null;const facts=new Map();
  const checkpoints={
    async updateOne(filter,update){
      if(update.$setOnInsert&&!doc)doc=structuredClone(update.$setOnInsert);
      else if(doc&&filter.lease_token===doc.lease_token&&filter.generation===doc.generation){Object.assign(doc,update.$set);if(update.$unset)delete doc.lease_token;}
    },
    async findOneAndUpdate(filter,update){
      if(filter.lease_until&&doc.lease_until>filter.lease_until.$lte&&filter.lease_until.$lte!==undefined)return null;
      if(filter.lease_token&&filter.lease_token!==doc.lease_token)return null;
      if(filter['pending.fingerprint']&&filter['pending.fingerprint']!==doc.pending?.fingerprint)return null;
      if(filter.pending===null&&doc.pending!==null)return null;
      Object.assign(doc,structuredClone(update.$set));if(update.$inc)doc.generation+=update.$inc.generation;
      return structuredClone(doc);
    }
  };
  const db={collection:()=>({async bulkWrite(ops){for(const {updateOne:o} of ops)if(!facts.has(o.filter._id))facts.set(o.filter._id,structuredClone(o.update.$setOnInsert));}})};
  const repo={db,checkpoints,listRules:async()=>[base],behaviors:{insert:async()=>''},endEpisode:async()=>{}};
  const envelope=(seq,x)=>{const f=frame(seq,{x});return {schema_version:'1.0',producer_id:'p',offset:String(seq),frame:{...f,schema_version:'1.0',source:{...f.source,coordinate_space:'source_pixels'},tracks:f.tracks.map(t=>({...t,last_observed_pts_ns:f.source_pts_ns}))}};};
  const consumer=new ObservationConsumer(repo);
  await consumer.consume(envelope(1,.4));await consumer.consume(envelope(2,.4));
  let failed=false;const crashing=new ObservationConsumer(repo,{hook:async p=>{if(p==='before_checkpoint'&&!failed){failed=true;throw Error('injected');}}});
  await assert.rejects(crashing.consume(envelope(3,.9)),/injected/);
  assert.equal(doc.offset,'2');assert.equal(facts.size,1);assert.ok(doc.pending);
  await consumer.consume(envelope(3,.9));assert.equal(doc.offset,'3');assert.equal(facts.size,1);
  assert.equal((await consumer.consume(envelope(3,.9))).outcome,'already_consumed');assert.equal(facts.size,1);
});
