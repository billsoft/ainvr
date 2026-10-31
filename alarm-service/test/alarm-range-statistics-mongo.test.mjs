import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';

test('isolated Mongo: range, paired locations, multi-stage dedup, state slices and purge',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});
 await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  let now='2026-10-04T00:00:00.000Z';const repo=new AlarmRepository(db,{clock:()=>now});await repo.initialize();
  const event=(id,channel,at,zone,stages=[],handling='unacknowledged',review='queued')=>({alarm_id:id,dedup_key:id,channel_id:channel,occurred_at:at,rule:{snapshot:{zone_id:zone}},stages,handling:{state:handling,revision:0},review:{state:review},version:1});
  const start='2026-10-01T00:00:00.000Z',end='2026-10-02T00:00:00.000Z';
  // Insert directly to preserve explicit test review states.
  for(const row of [
   event('both','a',start,'x',[{zone_id:'x'},{zone_id:'y'}],'acknowledged','supported'),
   event('stage','b','2026-10-01T12:00:00.000Z','other',[{zone_id:'y'}]),
   event('cross-a','a',start,'y'),event('cross-b','b',start,'x'),
   event('end','a',end,'x'),event('before','a','2026-09-30T23:59:59.999Z','x'),
   event('unknown','a',start,null),event('unknown-empty','b',start,'',[{zone_id:null}]),
   event('known-stage','a',start,null,[{zone_id:''},{zone_id:'other'}]),
  ])await repo.events.insertOne({...row,ingested_at:now});
  const scope={from:start,to:end,locations:[{channel_id:'a',zone_id:'x'},{channel_id:'b',zone_id:'y'}]};
  const result=await repo.statistics(scope);
  assert.equal(result.total,2);assert.equal(result.association.unassociated,2);assert.deepEqual(result.handling,{acknowledged:1,unacknowledged:1});assert.deepEqual(result.review,{supported:1,queued:1});
  const first=await repo.list({...scope,status:'all',limit:1});
  assert.equal(first.items.length,1);assert.ok(first.next_cursor);
  const second=await repo.list({...scope,locations:JSON.stringify([...scope.locations].reverse()),status:'all',limit:1,cursor:first.next_cursor});
  assert.deepEqual(new Set([...first.items,...second.items].map(x=>x.alarm_id)),new Set(['both','stage']));
  await assert.rejects(()=>repo.list({...scope,locations:[scope.locations[0]],status:'all',limit:1,cursor:first.next_cursor}),e=>e.code==='invalid_cursor');
  await assert.rejects(()=>repo.list({...scope,channel_id:'a'}),e=>e.code==='invalid_filter');
  const a=await repo.list({status:'all',from:start,to:end,channel_id:'a',zone_id:'x'});
  const b=await repo.list({status:'all',from:start,to:end,channel_id:'b',zone_id:'y'});
  assert.deepEqual(new Set([...a.items,...b.items].map(x=>x.alarm_id)),new Set(['both','stage']));
  await repo.clearAll('operator','test-purge');
  const cleared=await repo.statistics(scope);assert.equal(cleared.total,0);assert.equal(cleared.association.unassociated,0);
 }finally{try{await db.dropDatabase()}finally{await client.close()}}
});
