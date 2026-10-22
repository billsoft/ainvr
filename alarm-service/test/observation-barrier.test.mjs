import test from 'node:test';
import assert from 'node:assert/strict';
import {observationBarrier} from '../src/observation-barrier.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {createApp} from '../src/http.mjs';
test('drain fences continuous arrivals, finishes old writes, then purges exactly once',async()=>{
 const repository={ruleSnapshots:{current:async()=>({rules:[]})},checkpoints:{findOne:async()=>null},flow:{purge:async()=>{order.push('purge');return {facts:1}}}};
 const gate=observationBarrier(repository),release=gate.enter(),order=[];
 const drain=gate.drain(async()=>{order.push('purge');return 1});
 for(let i=0;i<100;i++)assert.throws(()=>gate.enter(),e=>e.code==='consumer_busy');
 assert.deepEqual(order,[]);order.push('old-write-finished');release();
 assert.equal(await drain,1);assert.deepEqual(order,['old-write-finished','purge']);
 gate.enter()();
});
test('timeout and thrown purge release admission but never purge under an old writer',async()=>{
 const gate=observationBarrier({}),release=gate.enter();let purged=false;
 await assert.rejects(gate.drain(()=>{purged=true},5),e=>e.code==='consumer_busy');
 assert.equal(purged,false);gate.enter()();release();
 await assert.rejects(gate.drain(()=>{throw Error('db unavailable')}));gate.enter()();
});
test('consumer validation failures always unregister and maintenance rejects input before any persistence',async()=>{
 const repo={},consumer=new ObservationConsumer(repo),gate=observationBarrier(repo);
 await assert.rejects(consumer.consume(null));
 await gate.drain(async()=>{await assert.rejects(consumer.consume(null),e=>e.code==='consumer_busy')});
 await gate.drain(async()=>{});
});
test('HTTP purge waits for old consumer and retains durable replay checks behind the barrier',async()=>{
 let pending={pending:{}},calls=0;
 const repository={ruleSnapshots:{current:async()=>({rules:[]})},checkpoints:{findOne:async()=>pending},flow:{purge:async()=>{calls++;return {facts:1}}}};
 const app=createApp({repository,apiToken:'a'.repeat(32)}),gate=observationBarrier(repository);
 const req={method:'POST',url:'/v1/flow/purge',headers:{authorization:'Bearer '+'a'.repeat(32)},payload:{counter_id:'c',rule_ids:['b']}};
 try{
  const release=gate.enter();const result=app.inject(req);
  await new Promise(resolve=>setImmediate(resolve));release();
  assert.equal((await result).statusCode,503);assert.equal(calls,0);
  pending=null;assert.equal((await app.inject(req)).statusCode,200);assert.equal(calls,1);
 }finally{await app.close()}
});

test('slow purge admits observations but fences snapshot publication until completion',async()=>{
 let done,started;const ready=new Promise(r=>started=r),slow=new Promise(r=>done=r);
 const repository={ruleSnapshots:{current:async()=>({rules:[]}),apply:async()=>{throw Error('must be fenced')}},checkpoints:{findOne:async()=>null},flow:{purge:async()=>{started();await slow;return {facts:1}}}};
 const app=createApp({repository,apiToken:'a'.repeat(32)}),gate=observationBarrier(repository);
 const headers={authorization:'Bearer '+'a'.repeat(32),'x-ainvr-actor':'tester'};
 try{
  const pending=app.inject({method:'POST',url:'/v1/flow/purge',headers,payload:{counter_id:'c',rule_ids:['b']}}).then(r=>r);
  await ready;gate.enter()();
  const blocked=await app.inject({method:'POST',url:'/v1/configuration/rules',headers,payload:{}});
  assert.equal(blocked.statusCode,503);
  done();assert.equal((await pending).statusCode,200);
  assert.equal(await gate.configure(async()=>42),42);
 }finally{done();await app.close()}
});
