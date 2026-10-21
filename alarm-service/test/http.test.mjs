import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/http.mjs';
import {DomainError} from '../src/domain.mjs';
const apiToken='test-only-'.repeat(6);
const headers={authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'test-operator','idempotency-key':'test-op'};
test('producer credentials cannot access operator APIs and input only acknowledges durable results',async()=>{
  const producerToken='producer-test-only-'.repeat(4);let durable=false,calls=0;
  const app=createApp({apiToken,producerToken,repository:{},consumer:{consume:async()=>{calls++;return {durable};}}});
  try{
    const request={method:'POST',url:'/v1/observations',payload:{},headers:{authorization:`Bearer ${producerToken}`}};
    assert.equal((await app.inject({...request,headers})).statusCode,401);assert.equal(calls,0);
    assert.equal((await app.inject({url:'/v1/events',headers:request.headers})).statusCode,401);
    assert.equal((await app.inject(request)).statusCode,503);
    durable=true;assert.equal((await app.inject(request)).json().durable,true);
  }finally{await app.close();}
  assert.throws(()=>createApp({apiToken,producerToken:apiToken,consumer:{},repository:{}}));
});
test('auth is mandatory except bounded supervisor probes; service failures do not leak connection secrets',async()=>{
  const app=createApp({repository:{list:async()=>{throw Error('mongodb://private:secret');}},apiToken});
  try{
    assert.equal((await app.inject('/livez')).statusCode,200);
    assert.equal((await app.inject('/v1/events')).statusCode,401);
    const res=await app.inject({url:'/v1/events',headers});assert.equal(res.statusCode,503);assert.equal(res.body.includes('secret'),false);
  }finally{await app.close();}
});
test('batch reports each failure and never claims total success',async()=>{
  const seen=[];const app=createApp({apiToken,repository:{confirm:async id=>{seen.push(id);if(id==='bad')throw new DomainError('version_conflict','changed',409);return {outcome:'succeeded'};}}});
  try{
    const res=await app.inject({method:'POST',url:'/v1/bulk-acknowledgements',headers,payload:{items:[{alarm_id:'ok',expected_handling_revision:0},{alarm_id:'bad',expected_handling_revision:0}]}});
    assert.deepEqual(res.json().items.map(x=>x.outcome),['succeeded','version_conflict']);assert.equal(seen.length,2);
    const duplicate=await app.inject({method:'POST',url:'/v1/bulk-acknowledgements',headers,payload:{items:[{alarm_id:'ok'},{alarm_id:'ok'}]}});
    assert.equal(duplicate.statusCode,422);assert.equal(seen.length,2);
  }finally{await app.close();}
});
test('readiness can fail independently of liveness and review is unavailable explicitly',async()=>{
  const app=createApp({apiToken,repository:{},readiness:async()=>false});
  try{assert.equal((await app.inject({url:'/readyz',headers})).statusCode,503);const c=await app.inject({url:'/v1/capabilities',headers});assert.deepEqual(c.json().behaviors,['appearance','region_approach','region_enter','region_traverse']);assert.equal(c.json().review.available,false);assert.equal(c.json().notification.available,false);}finally{await app.close();}
});
test('mutation requires authenticated actor and dry run rejects unbounded input',async()=>{
  let called=false;const app=createApp({apiToken,repository:{confirm:async()=>{called=true;}}});
  try{
    const res=await app.inject({method:'POST',url:'/v1/events/id/acknowledgements',headers:{authorization:headers.authorization},payload:{}});assert.equal(res.statusCode,422);assert.equal(called,false);
    const dry=await app.inject({method:'POST',url:'/v1/dry-runs',headers,payload:{frames:Array(201).fill({}),rules:[]}});assert.equal(dry.statusCode,422);
  }finally{await app.close();}
});

test('legacy direct rule writes cannot bypass authoritative monitor configuration',async()=>{
 let called=false;const app=createApp({apiToken,repository:{saveRule:async()=>{called=true;}}});
 try{
  const response=await app.inject({method:'POST',url:'/v1/rules',headers,payload:{rule:{},expected_version:0}});
  assert.equal(response.statusCode,405);assert.equal(response.json().error.code,'configuration_authority');assert.equal(called,false);
 }finally{await app.close();}
});

test('loopback supervisor can read readiness without a credential while management remains protected',async()=>{
 const app=await createApp({repository:{},apiToken:'a'.repeat(32),readiness:async()=>false});
 try{const ready=await app.inject({url:'/readyz'});assert.equal(ready.statusCode,503);assert.deepEqual(ready.json(),{ready:false});assert.equal((await app.inject({url:'/v1/status'})).statusCode,401);}
 finally{await app.close();}
});

test('pending summary uses management auth and is not interpreted as an event id',async()=>{
 const app=createApp({apiToken,repository:{pendingSummary:async()=>({pending:202,as_of:'2026-10-20T00:00:00Z'}),get:async()=>{throw Error('wrong route');}}});
 try{
  assert.equal((await app.inject('/v1/events/summary')).statusCode,401);
  const result=await app.inject({url:'/v1/events/summary',headers});assert.equal(result.statusCode,200);assert.equal(result.json().pending,202);
 }finally{await app.close();}
});
