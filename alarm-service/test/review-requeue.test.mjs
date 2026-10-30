import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {requeueFailedReviews} from '../src/review-requeue.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
const row=(id,{state='failed',reason='review_unavailable',handling='unacknowledged',enabled=true,attempt=3}={})=>({alarm_id:id,occurred_at:'2026-10-29T12:00:00Z',version:1,logs:[],
 handling:{state:handling,revision:0},review:{state,reason,attempt,token:'t',lease_until:5,next_attempt_at:99,storage_retries:7,generation:id,context_state:'ready',policy:{enabled}}});
test('only retryable failed reviews of unreviewed alarms are re-queued, with an audit entry',{skip:!enabled},async()=>{
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_requeue_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 try{
  await events.insertMany([row('a'),row('b',{reason:'storage_unavailable'}),row('c',{reason:'unvalidated_profile'}),row('d',{reason:'incomplete_trajectory'}),
   row('e',{handling:'acknowledged'}),row('f',{enabled:false}),row('g',{state:'supported',reason:null}),row('h')]);
  const first=await requeueFailedReviews(events,{now:1_800_000_000_000,limit:2});
  assert.equal(first.requeued,2);
  const second=await requeueFailedReviews(events,{now:1_800_000_000_000});
  assert.equal(second.requeued,1);                                  // a, b, h are the only retryable ones
  const third=await requeueFailedReviews(events,{now:1_800_000_000_000});
  assert.equal(third.requeued,0);                                   // idempotent
  for(const id of ['a','b','h']){
   const r=await events.findOne({alarm_id:id});
   assert.equal(r.review.state,'queued');assert.equal(r.review.attempt,0);assert.equal(r.review.next_attempt_at,0);
   assert.equal(r.review.lease_until,0);assert.equal(r.review.reason,undefined);assert.equal(r.review.token,undefined);assert.equal(r.review.storage_retries,0);
   assert.equal(r.version,2);assert.equal(r.logs.at(-1).action,'review_requeued');
  }
  for(const id of ['c','d','e','f'])assert.equal((await events.findOne({alarm_id:id})).review.state,'failed');
  assert.equal((await events.findOne({alarm_id:'g'})).review.state,'supported');
 }finally{await db.dropDatabase();await client.close();}
});
