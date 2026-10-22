import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/http.mjs';
test('purge waits for stopped rules and all in-flight observations; safe retry then succeeds',async()=>{
 let rules=[{counter_id:'c'}],pending=null,calls=0;
 const repository={ruleSnapshots:{current:async()=>({rules})},checkpoints:{findOne:async()=>pending},flow:{purge:async()=>{calls++;return {facts:1,coverage:1}}}};
 const app=createApp({repository,apiToken:'a'.repeat(32)});
 const req={method:'POST',url:'/v1/flow/purge',headers:{authorization:'Bearer '+'a'.repeat(32),'x-ainvr-actor':'test'},payload:{counter_id:'c',rule_ids:['b']}};
 try{
  assert.equal((await app.inject(req)).statusCode,409);assert.equal(calls,0);
  rules=[];pending={pending:{}};
  assert.equal((await app.inject(req)).statusCode,503);assert.equal(calls,0);
  pending=null;assert.equal((await app.inject(req)).statusCode,200);assert.equal(calls,1);
 }finally{await app.close()}
});
