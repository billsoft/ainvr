import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
// Deliberately fixed isolated test port; never take a production URI from env.
test('real Mongo: restart persistence, replay dedup, concurrent ack, audit and pagination',{skip:!enabled},async()=>{
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});
  const name='ainvr_alarm_test_'+randomUUID().replaceAll('-','');
  await client.connect();const db=client.db(name);
  try{
    let now='2026-10-19T00:00:00.000Z';
    const repo=new AlarmRepository(db,{clock:()=>now});await repo.initialize();
    const event=id=>({alarm_id:id,dedup_key:id,channel_id:'gate',occurred_at:'2026-10-19T00:00:00.000Z',review:{state:'skipped'},handling:{state:'unacknowledged',revision:0,disposition:'unset'},version:1});
    assert.equal(await repo.insert(event('a')),true);assert.equal(await repo.insert(event('a')),false);
    await repo.insert(event('b'));
    const restarted=new AlarmRepository(db,{clock:()=>now});
    assert.equal((await restarted.get('a')).handling.state,'unacknowledged');
    const [one,two]=await Promise.all([repo.confirm('a',{expected_handling_revision:0,note:'yes'},'operator','same-key'),restarted.confirm('a',{expected_handling_revision:0,note:'yes'},'operator','same-key')]);
    assert.deepEqual(one,two);const got=await repo.get('a');assert.equal(got.logs.filter(l=>l.action==='acknowledged').length,1);
    assert.equal(got.review.state,'skipped');assert.equal(got.handling.revision,1);
    await assert.rejects(()=>repo.confirm('a',{expected_handling_revision:0,note:'different'},'operator','same-key'),e=>e.code==='idempotency_conflict');
    const page=await repo.list({status:'all',limit:1});assert.equal(page.items[0].alarm_id,'b');assert.ok(page.next_cursor);
    now='2026-10-19T00:00:01.000Z';await repo.insert(event('c'));
    const next=await repo.list({status:'all',limit:1,cursor:page.next_cursor});assert.deepEqual(next.items.map(x=>x.alarm_id),['a']);
    await assert.rejects(()=>repo.list({status:'pending',cursor:page.next_cursor}),e=>e.code==='invalid_cursor');
    assert.deepEqual((await repo.list()).items.map(x=>x.alarm_id),['c','b']);
    const rule={id:'r',version:1,name:'Gate',channel_id:'gate',state:'draft',label_ids:['person'],geometry_revision:'g1',label_map_version:'l1',behavior:'appearance'};
    await repo.saveRule(rule,0,'operator');
    await repo.saveRule({...rule,version:2,name:'Updated'},1,'operator');
    await assert.rejects(()=>repo.saveRule({...rule,version:2},1,'operator'),e=>e.code==='version_conflict');
    assert.equal((await repo.listRules())[0].history.length,2);
  }finally{await db.dropDatabase();await client.close();}
});

test('alarm filters include earlier activity stages, isolate zones and bind pagination to the same time scope',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db,{clock:()=> '2026-10-20T00:00:00Z'});await repo.initialize();
  const event=(id,at,zone)=>({alarm_id:id,dedup_key:id,channel_id:'gate',occurred_at:at,rule:{snapshot:{zone_id:zone}},behavior:'region_traverse',stages:[{behavior:'region_enter'}],review:{state:'skipped'},handling:{state:'unacknowledged',revision:0},version:1});
  await repo.insert(event('a','2026-10-19T00:00:00.000Z','z'));await repo.insert(event('b','2026-10-19T01:00:00.000Z','z'));await repo.insert(event('c','2026-10-19T02:00:00.000Z','other'));
  const q={status:'all',from:'2026-10-19T00:00:00Z',to:'2026-10-19T02:00:00Z',zone_id:'z',behavior:'region_enter',limit:1};
  const first=await repo.list(q);assert.equal(first.items[0].alarm_id,'b');assert.ok(first.next_cursor);
  const next=await repo.list({...q,cursor:first.next_cursor});assert.equal(next.items[0].alarm_id,'a');
  await assert.rejects(repo.list({...q,zone_id:'other',cursor:first.next_cursor}),e=>e.code==='invalid_cursor');
  await assert.rejects(repo.list({...q,from:'invalid'}),e=>e.code==='invalid_time_range');
  assert.deepEqual((await repo.list({...q,behavior:'appearance'})).items,[]);
 }finally{await db.dropDatabase();await client.close();}
});

test('disabling the last rule closes activities without a new frame and stale replay cannot reopen them',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const rule={id:'m:appearance',monitor_id:'m',version:1,name:'r',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance'};
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[rule]},'test');
  const event={episode_id:'episode',episode_started_at:'2026-10-19T00:00:00Z',dedup_key:'fact',occurred_at:'2026-10-19T00:00:00Z',last_seen_at:'2026-10-19T00:00:00Z',rule:{id:rule.id,version:1,snapshot:rule},behavior:'appearance',lifecycle:{state:'active'},version:1};
  await repo.insert(event);assert.equal((await repo.get('episode')).lifecycle.state,'active');
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'2',rules:[]},'test');
  await repo.reconcileActivities(await repo.ruleSnapshots.current());assert.equal((await repo.get('episode')).lifecycle.end_reason,'configuration_changed');
  await repo.insert({...event,episode_id:'late',dedup_key:'late-fact'});assert.equal((await repo.get('late')).lifecycle.state,'ended');
  await repo.insert(event);assert.equal((await repo.get('episode')).lifecycle.state,'ended');
 }finally{await db.dropDatabase();await client.close();}
});

test('activity alarm time is the first rule trigger, not when the target was first seen',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const rule={id:'m:region_enter',monitor_id:'m',version:1,name:'r',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[rule,{...rule,id:'m:region_traverse',behavior:'region_traverse'}]},'test');
  const event={episode_id:'episode',episode_started_at:'2026-10-19T00:00:00.000Z',dedup_key:'enter',occurred_at:'2026-10-19T00:00:05.000Z',last_seen_at:'2026-10-19T00:00:05.000Z',rule:{id:rule.id,version:1,snapshot:rule},behavior:'region_enter',lifecycle:{state:'active'},version:1};
  await repo.insert(event);
  await repo.insert({...event,dedup_key:'traverse',occurred_at:'2026-10-19T00:00:09.000Z',last_seen_at:'2026-10-19T00:00:09.000Z',rule:{id:'m:region_traverse',version:1,snapshot:{...rule,id:'m:region_traverse',behavior:'region_traverse'}},behavior:'region_traverse'});
  const saved=await repo.get('episode');
  assert.equal(saved.occurred_at,'2026-10-19T00:00:05.000Z');
  assert.equal(saved.activity_started_at,'2026-10-19T00:00:00.000Z');
  assert.equal(saved.last_seen_at,'2026-10-19T00:00:09.000Z');
  const page=await repo.list({status:'all',from:'2026-10-19T00:00:04Z',to:'2026-10-19T00:00:06Z'});
  assert.deepEqual(page.items.map(i=>i.alarm_id),['episode']);
 }finally{await db.dropDatabase();await client.close();}
});

test('an activity shows the trigger that reached the top level and lives while any of its triggers remains',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const zone=[[.3,.3],[.7,.3],[.7,.7]];
  const front={id:'front@gate',trigger_id:'front',version:1,name:'前区有人',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance'};
  const pass={id:'pass@gate',trigger_id:'pass',version:1,name:'通道穿过',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',points:zone,zone_id:'lane',zone_version:1};
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[front,pass]},'test');
  const stage=(rule,key,at)=>({episode_id:'episode',episode_started_at:'2026-10-20T00:00:00.000Z',dedup_key:key,occurred_at:at,last_seen_at:at,trigger_id:rule.trigger_id,
    rule:{id:rule.id,version:1,name:rule.name,snapshot:{...rule,zone_id:rule.zone_id??null}},behavior:rule.behavior,severity:'warning',lifecycle:{state:'active'},version:1});
  await repo.insert(stage(front,'a','2026-10-20T00:00:01.000Z'));await repo.insert(stage(pass,'b','2026-10-20T00:00:05.000Z'));
  let saved=await repo.get('episode');
  assert.equal(saved.behavior,'region_traverse');assert.equal(saved.rule.id,'pass@gate');assert.equal(saved.trigger_id,'pass');
  assert.equal(saved.occurred_at,'2026-10-20T00:00:01.000Z');
  assert.deepEqual((await repo.list({status:'all',zone_id:'lane'})).items.map(i=>i.alarm_id),['episode']);
  // Archiving the lowest trigger keeps the activity: the passage trigger still runs.
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'2',rules:[pass]},'test');
  await repo.reconcileActivities(await repo.ruleSnapshots.current());
  assert.equal((await repo.get('episode')).lifecycle.state,'active');
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'3',rules:[]},'test');
  await repo.reconcileActivities(await repo.ruleSnapshots.current());
  assert.equal((await repo.get('episode')).lifecycle.end_reason,'configuration_changed');
 }finally{await db.dropDatabase();await client.close();}
});

test('real Mongo: pending summary counts all pages with the same exclusions as the list',{skip:!enabled},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  for(let i=0;i<205;i++)await repo.insert({alarm_id:`count-${i}`,dedup_key:`count-${i}`,occurred_at:'2020-01-01T00:00:00.000Z',handling:{state:'unacknowledged',revision:0,disposition:'unset'},review:{state:'skipped'},version:1});
  await repo.events.updateOne({alarm_id:'count-0'},{$set:{'handling.state':'acknowledged'}});
  await repo.events.updateOne({alarm_id:'count-1'},{$set:{'handling.disposition':'false_positive'}});
  await repo.events.updateOne({alarm_id:'count-2'},{$set:{'review.state':'not_supported'}});
  assert.equal((await repo.pendingSummary()).pending,202);
  assert.equal((await repo.list()).items.length,50);
  await repo.confirm('count-3',{expected_handling_revision:0,note:''},'operator','count-ack');
  assert.equal((await repo.pendingSummary()).pending,201);
 }finally{await db.dropDatabase();await client.close();}
});
