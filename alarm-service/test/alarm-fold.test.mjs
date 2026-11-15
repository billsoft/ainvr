import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
// One open alarm per rule: until someone (operator or AI review) handles it, later
// occurrences of the same rule are folded into it instead of raising and reviewing
// new alarms. After handling, a rule alarms again at most once a minute (frame time).
// Behavior facts, counting and dwell still record every occurrence.
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
const T0=Date.parse('2026-11-15T00:00:00Z');
const frame=(seq,tracks,ms)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,
  source_pts_ns:String(BigInt(ms)*1000000n),captured_at:new Date(T0+ms).toISOString(),
  source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
  tracks:tracks.map(([id,x])=>({track_id:id,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(BigInt(ms)*1000000n),bbox:{x:x*1000-10,y:400,w:20,h:100}}))});
const zone=[[.5,0],[1,0],[1,1],[.5,1]];
const enter={id:'enter',version:1,name:'Enter',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',points:zone};
async function isolated(rules,fn){
  const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{const repo=new AlarmRepository(db);await repo.initialize();for(const r of rules)await repo.saveRule(r,0,'test');await fn(repo,db);}
  finally{await db.dropDatabase();await client.close();}
}
// Feeds one frame per 200 ms of the scripted timeline: [[durationMs,tracks],...].
function feeder(repo){
  const consumer=new ObservationConsumer(repo);let seq=0,ms=0;
  return {at:()=>ms,async play(script){for(const [duration,tracks] of script)for(let t=0;t<duration;t+=200){seq++;ms+=200;await consumer.consume({schema_version:'1.0',producer_id:'p',offset:String(seq),frame:frame(seq,tracks,ms)});}}};
}
const outside=[['a',.3]],inside=[['a',.7]];
// A new person: a new tracker identity entering from outside.
const person=(id,stayMs=5000)=>[[1000,[[id,.3]]],[stayMs,[[id,.7]]],[1000,[]]];

test('the same target returning stays one activity alarm (existing per-target merge)',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play([[1000,outside],[10000,inside],[4000,outside],[10000,inside]]);
  assert.equal(await repo.behaviors.collection.countDocuments({}),2,'both entries remain behavior facts');
  const alarms=await repo.events.find({}).toArray();
  assert.equal(alarms.length,1);assert.equal(alarms[0].fold_count??0,0);
}));

test('a second person entering before anyone handled the alarm folds into it: one alarm, one review, every fact kept',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play([...person('a'),...person('b')]);
  assert.equal(await repo.behaviors.collection.countDocuments({}),2,'both entries remain behavior facts');
  const alarms=await repo.events.find({}).toArray();
  assert.equal(alarms.length,1);
  assert.equal(alarms[0].fold_count,1);
  assert.ok(alarms[0].last_occurred_at>alarms[0].occurred_at);
}));

test('many different people entering while the alarm is open stay one alarm',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo),script=[];
  for(let k=0;k<12;k++)script.push([1000,[[`p${k}`,.3]]],[2000,[[`p${k}`,.7]]]);
  await feed.play(script);
  assert.equal(await repo.behaviors.collection.countDocuments({}),12);
  const alarms=await repo.events.find({}).toArray();
  assert.equal(alarms.length,1);assert.equal(alarms[0].fold_count,11);
}));

test('after handling, the rule alarms again only once a minute has passed',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play(person('a'));
  const [first]=await repo.events.find({}).toArray();
  await repo.confirm(first.alarm_id,{expected_handling_revision:0,note:'checked'},'operator','ack-1');
  // Another person a few seconds later: still within the minute, folded into the handled alarm.
  await feed.play(person('b'));
  let alarms=await repo.events.find({}).sort({occurred_at:1}).toArray();
  assert.equal(alarms.length,1);assert.equal(alarms[0].fold_count,1);assert.equal(alarms[0].handling.state,'acknowledged');
  // A person more than a minute later: a new alarm, reviewed on its own.
  await feed.play([[65000,[]],...person('c')]);
  alarms=await repo.events.find({}).sort({occurred_at:1}).toArray();
  assert.equal(alarms.length,2);assert.equal(alarms[1].handling.state,'unacknowledged');assert.equal(alarms[1].fold_count??0,0);
}));

test('different rules keep separate alarms',{skip:!enabled},()=>isolated([
  {...enter,points:[[.5,0],[.75,0],[.75,1],[.5,1]]},{...enter,id:'enter-2',name:'Enter 2',points:[[.8,0],[1,0],[1,1],[.8,1]]}],async(repo)=>{
  const feed=feeder(repo);
  // a enters the first zone, b the second, c the first again.
  await feed.play([[1000,[['a',.3]]],[5000,[['a',.6]]],[1000,[]],[1000,[['b',.3]]],[5000,[['b',.9]]],[1000,[]],[1000,[['c',.3]]],[5000,[['c',.6]]],[1000,[]]]);
  const alarms=await repo.events.find({}).sort({'rule.id':1}).toArray();
  assert.deepEqual(alarms.map(a=>[a.rule.id,a.fold_count??0]),[['enter',1],['enter-2',0]]);
}));

test('an edited rule alarms afresh instead of folding into the alarm of its previous version',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play(person('a'));
  await repo.saveRule({...enter,version:2,points:[[.45,0],[1,0],[1,1],[.45,1]]},1,'test');
  await feed.play(person('b'));
  const alarms=await repo.events.find({}).sort({occurred_at:1}).toArray();
  assert.deepEqual(alarms.map(a=>[a.rule.version,a.fold_count??0]),[[1,0],[2,0]]);
}));

test('replaying a folded occurrence does not count it twice',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play([...person('a'),...person('b')]);
  const [alarm]=await repo.events.find({}).toArray();
  const facts=await repo.behaviors.collection.find({}).sort({occurred_at:1}).toArray();
  assert.equal(facts.length,2);
  const second=(await repo.events.findOne({alarm_id:alarm.alarm_id})).fold_ids[0];
  // The materializer may run the same outcome again (crash recovery).
  const {_id,fold_count,fold_ids,last_occurred_at,...event}=alarm;
  await repo.insert({...event,alarm_id:second,dedup_key:second,episode_id:second,occurred_at:last_occurred_at});
  const after=await repo.events.find({}).toArray();
  assert.equal(after.length,1);assert.equal(after[0].fold_count,1);
}));

test('a false-positive disposition closes the alarm for folding, subject to the minute',{skip:!enabled},()=>isolated([enter],async(repo)=>{
  const feed=feeder(repo);
  await feed.play(person('a'));
  const [first]=await repo.events.find({}).toArray();
  await repo.confirm(first.alarm_id,{expected_handling_revision:0,note:'not a person',disposition:'false_positive'},'operator','fp-1');
  await feed.play([[65000,[]],...person('b')]);
  assert.equal(await repo.events.countDocuments({}),2);
}));
