import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {BehaviorEvents} from '../src/behavior-events.mjs';
import {createApp} from '../src/http.mjs';

test('behavior history is operator-only and rejects unsupported filters',async()=>{
 const apiToken='history-api-test-'.repeat(3),producerToken='history-producer-test-'.repeat(3);
 const app=createApp({apiToken,producerToken,repository:{behaviors:{list:async q=>({items:[],limit:q.limit}),get:async id=>({event_id:id})}}});
 try{
  const headers={authorization:`Bearer ${apiToken}`};
  assert.equal((await app.inject({url:'/v1/behavior-events',headers:{authorization:`Bearer ${producerToken}`}})).statusCode,401);
  assert.equal((await app.inject({url:'/v1/behavior-events?status=acknowledged',headers})).statusCode,422);
  const res=await app.inject({url:'/v1/behavior-events?limit=20',headers});assert.equal(res.statusCode,200);assert.equal(res.json().limit,20);
  assert.equal((await app.inject({url:'/v1/behavior-events/fact',headers})).json().event_id,'fact');
 }finally{await app.close();}
});
test('stable keyset pagination preserves tied timestamps and scope; detail includes evidence',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const facts=new BehaviorEvents(db);await facts.initialize();
  const base={event_type:'region_enter',channel_id:'gate',stream_session_id:'s',track_id:'t',label_id:'person',occurred_at:'2026-10-19T01:00:00.000Z',analysis_evidence:{privateLargeTrajectory:[1,2,3]}};
  await facts.collection.insertMany(['a','b','c','d'].map(event_id=>({...base,event_id})));
  const query={from:'2026-10-19',to:'2026-10-20',channel_id:'gate',limit:2};
  const first=await facts.list(query);assert.deepEqual(first.items.map(r=>r.event_id),['d','c']);assert.equal('analysis_evidence' in first.items[0],false);
  await facts.collection.insertOne({...base,event_id:'e'});
  const second=await facts.list({...query,cursor:first.next_cursor});assert.deepEqual(second.items.map(r=>r.event_id),['b','a']);assert.equal(second.next_cursor,null);
  assert.equal((await facts.list(query)).items[0].event_id,'e');
  await assert.rejects(facts.list({...query,label_id:'vehicle',cursor:first.next_cursor}),e=>e.code==='invalid_cursor');
  await assert.rejects(facts.list({...query,cursor:'garbage'}),e=>e.code==='invalid_cursor');
  await assert.rejects(facts.list({...query,limit:101}),e=>e.code==='invalid_limit');
  assert.deepEqual((await facts.get('a')).analysis_evidence,base.analysis_evidence);
  await assert.rejects(facts.get('missing'),e=>e.code==='not_found');
 }finally{await db.dropDatabase();await client.close();}
});