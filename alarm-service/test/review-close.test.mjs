import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewWorker} from '../src/review-worker.mjs';
test('shutdown waits for an automatic requeue sweep before the database can close',async()=>{
 let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r});
 const worker=new ReviewWorker({events:{}},{context:{},invoke:async()=>{}});
 worker.step=async()=>false;worker.sweepIfDue=async()=>{enter();await gate;return 0};
 worker.run();await entered;
 let closed=false;const closing=worker.close().then(()=>{closed=true});
 await new Promise(r=>setImmediate(r));const premature=closed;release();await closing;
 assert.equal(premature,false,'database ownership cannot end while requeue mutations are running');
});
