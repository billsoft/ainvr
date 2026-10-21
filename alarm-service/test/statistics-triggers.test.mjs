import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {BehaviorEvents} from '../src/behavior-events.mjs';
// Counting by trigger: a trigger spans channels; facts recorded before triggers carry
// only the old rule id, which the migration kept as the trigger id.
test('statistics group and filter by trigger, attributing pre-trigger facts by their rule id',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const facts=new BehaviorEvents(db);await facts.initialize();
  const base={event_type:'region_traverse',stream_session_id:'s',label_id:'person',occurred_at:'2026-10-20T01:00:00.000Z'};
  await facts.collection.insertMany([
   {...base,event_id:'1',channel_id:'gate',track_id:'a',trigger_id:'pass',rule_id:'pass@gate'},
   {...base,event_id:'2',channel_id:'yard',track_id:'b',trigger_id:'pass',rule_id:'pass@yard'},
   {...base,event_id:'3',channel_id:'gate',track_id:'c',rule_id:'m:region_traverse'},
   {...base,event_id:'4',channel_id:'gate',track_id:'d',trigger_id:'other',rule_id:'other@gate'},
  ]);
  const range={from:'2026-10-20T00:00:00Z',to:'2026-10-20T02:00:00Z'};
  const grouped=await facts.statistics({...range,group_by:'trigger'});
  assert.deepEqual(grouped.items.map(i=>[i.group,i.occurrences]),[['m:region_traverse',1],['other',1],['pass',2]]);
  assert.equal((await facts.statistics({...range,trigger_id:'pass'})).items[0].occurrences,2);
  assert.equal((await facts.statistics({...range,trigger_id:'m:region_traverse'})).items[0].occurrences,1);
  assert.deepEqual((await facts.list({...range,trigger_id:'pass'})).items.map(i=>i.event_id).sort(),['1','2']);
 }finally{await db.dropDatabase();await client.close();}
});
