import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {requeueFailedReviews} from '../src/review-requeue.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
const NOW=1_800_000_000_000;
const row=(id,{reason='review_unavailable',next=0,auto,state='failed',handling='unacknowledged'}={})=>({alarm_id:id,occurred_at:'2026-10-29T12:00:00Z',version:1,logs:[],
 handling:{state:handling,revision:0},review:{state,reason,attempt:3,next_attempt_at:next,generation:id,context_state:'ready',policy:{enabled:true},...(auto===undefined?{}:{auto_requeues:auto})}});
async function fixture(fn){
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_autorequeue_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 try{await fn(events);}finally{await db.dropDatabase();await client.close();}
}
test('automatic re-queue honours the per-alarm cap and the cooldown after the last failure',{skip:!enabled},()=>fixture(async events=>{
 const auto={max:2,cooldownMs:300_000};
 await events.insertMany([row('fresh',{next:NOW-600_000}),row('cooling',{next:NOW-60_000}),row('once',{next:NOW-600_000,auto:1}),row('capped',{next:NOW-600_000,auto:2}),
  row('human',{next:NOW-600_000,handling:'acknowledged'}),row('verdict',{reason:'unvalidated_profile',next:NOW-600_000})]);
 const result=await requeueFailedReviews(events,{now:NOW,auto});
 assert.equal(result.requeued,2);
 const get=id=>events.findOne({alarm_id:id});
 assert.equal((await get('fresh')).review.state,'queued');assert.equal((await get('fresh')).review.auto_requeues,1);
 assert.equal((await get('once')).review.state,'queued');assert.equal((await get('once')).review.auto_requeues,2);
 for(const id of ['cooling','capped','human','verdict'])assert.equal((await get(id)).review.state,'failed',id);
 assert.equal((await get('fresh')).logs.at(-1).action,'review_requeued');
 // A manual re-queue (operator action) ignores the automatic cap.
 const manual=await requeueFailedReviews(events,{now:NOW});
 assert.equal(manual.requeued,2);                                   // cooling and capped
}));
test('the worker sweeps for retryable failures on a schedule, never before the interval',{skip:!enabled},()=>fixture(async events=>{
 await events.insertOne(row('late',{next:NOW-3_600_000}));
 let now=NOW;
 const worker=new ReviewWorker({events},{clock:()=>now,qualification:async()=>true,readiness:async()=>true,authorization:async()=>null,context:{},invoke:async()=>{throw Error('unused');}});
 assert.equal(await worker.sweepIfDue(),0);                          // just started: not due
 assert.equal((await events.findOne({alarm_id:'late'})).review.state,'failed');
 now+=11*60_000;
 assert.equal(await worker.sweepIfDue(),1);
 assert.equal((await events.findOne({alarm_id:'late'})).review.state,'queued');
 assert.equal(await worker.sweepIfDue(),0);                          // interval restarts after a sweep
 assert.equal((await worker.status()).auto_requeued,1);
}));
