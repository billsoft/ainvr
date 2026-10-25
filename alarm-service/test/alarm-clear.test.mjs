import test from 'node:test';import assert from 'node:assert/strict';import {MongoClient} from 'mongodb';import {randomUUID} from 'node:crypto';import {AlarmRepository} from '../src/repository.mjs';
const uri=process.env.AINVR_REVIEW_TEST_MONGO_URI;
test('clear all is idempotent, preserves new alarms and behavior facts, blocks crash replay',{skip:!uri},async()=>{
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_clear_test_'+randomUUID().replaceAll('-',''));let now='2026-10-25T10:00:00.000Z';const repo=new AlarmRepository(db,{clock:()=>now});
 const make=(id,time)=>({alarm_id:id,occurred_at:time,handling:{state:'unacknowledged',revision:0},version:1});
 try{
  await db.collection('behavior_events').insertOne({_id:'counting-fact'});
  await repo.insert(make('old','2026-10-24T00:00:00.000Z'));
  const first=await repo.clearAll('operator','clear-1');assert.equal(first.deleted_count,1);assert.equal(await repo.events.countDocuments({}),0);assert.equal(await db.collection('behavior_events').countDocuments({}),1);
  assert.equal(await repo.insert(make('old','2026-10-24T00:00:00.000Z')),false);
  now='2026-10-25T11:00:00.000Z';await repo.insert(make('new','2026-10-25T11:00:00.000Z'));
  assert.deepEqual(await repo.clearAll('operator','clear-1'),first);assert.ok(await repo.events.findOne({alarm_id:'new'}));
  now='2026-10-25T12:00:00.000Z';const original=repo.events.deleteMany.bind(repo.events);repo.events.deleteMany=async()=>{throw Error('simulated crash')};
  await assert.rejects(repo.clearAll('operator','clear-2'),/simulated crash/);repo.events.deleteMany=original;
  assert.equal(await repo.insert(make('late-replay','2026-10-25T11:30:00.000Z')),false);
  now='2026-10-25T13:00:00.000Z';await repo.insert(make('after','2026-10-25T13:00:00.000Z'));
  const recovered=await repo.clearAll('operator','clear-2');assert.equal(recovered.cutoff,'2026-10-25T12:00:00.000Z');assert.equal(await repo.events.countDocuments({}),1);assert.ok(await repo.events.findOne({alarm_id:'after'}));
  const audit=await db.collection('alarm_history_clear_operations').findOne({_id:{$exists:true}});assert.equal(audit.actor,'operator');assert.equal(audit.state,'completed');assert.equal('password' in audit,false);
 }finally{await db.dropDatabase();await client.close()}
});
