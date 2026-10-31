import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAnalytics,calendarBuckets,analyticsFilter,queryAlarmAnalytics,ANALYTICS_LIMITS} from '../src/alarm-analytics.mjs';
import {createApp} from '../src/http.mjs';
const scope={from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',timezone:'Asia/Shanghai',bucket:'hour'};
test('analytics normalizes identities, rejects unsupported/oversized/injected scopes',()=>{
 const p={channel_id:'a',zone_id:'x'};
 assert.deepEqual(normalizeAnalytics({...scope,locations:[p,p]}).locations,[p]);
 assert.equal(normalizeAnalytics({...scope,to:'2026-11-01T00:00:00Z'}).to,'2026-11-01T00:00:00.000Z');
 for(const bad of [null,[],{...scope,from:'2026-10-01'}, {...scope,to:'2026-11-01T00:00:00.001Z'},{...scope,locations:[]},{...scope,locations:Array(101).fill(p)},{...scope,timezone:'invalid'},{...scope,timezone:'+08:00'},{...scope,hour:24},{...scope,weekday:7},{...scope,trigger_id:{$ne:null}},{...scope,association:'associated'},{...scope,other:true},{...scope,locations:[{...p,other:1}]},{...scope,audit:'human'}])assert.throws(()=>normalizeAnalytics(bad));
 assert.throws(()=>normalizeAnalytics(' '.repeat(8193)));
 assert.throws(()=>normalizeAnalytics({...scope,from:'2026-02-30T00:00:00Z',to:'2026-03-03T00:00:00Z'}));
 const many={...scope,locations:Array.from({length:100},(_,i)=>({channel_id:'c'+i,zone_id:'z'+i})),trigger_id:'t'.repeat(256),primary_type:'p'.repeat(256)};
 assert.ok(JSON.stringify(many).length>4096);assert.equal(normalizeAnalytics(JSON.stringify(many)).locations.length,100);
 assert.equal(analyticsFilter(normalizeAnalytics({...scope,primary_type:'$literal'})).behavior,'$literal');
});
test('calendar boundaries preserve DST, half hour offsets and clipped intervals',()=>{
 const q={...scope,timezone:'America/New_York',from:'2026-11-01T04:00:00.000Z',to:'2026-11-01T09:00:00.000Z'};
 assert.equal(calendarBuckets(q).length,5);
 assert.equal(calendarBuckets({...q,from:'2026-03-08T05:00:00.000Z',to:'2026-03-08T09:00:00.000Z'}).length,4);
 const day=calendarBuckets({...q,bucket:'day',to:'2026-11-02T05:00:00.000Z'});assert.equal(day.length,1);assert.equal(Date.parse(day[0].to)-Date.parse(day[0].from),25*3600000);
 const nepal=calendarBuckets({...scope,timezone:'Asia/Kathmandu',from:'2026-10-01T00:10:00.000Z',to:'2026-10-01T02:20:00.000Z'});
 assert.equal(nepal[0].to,'2026-10-01T00:15:00.000Z');assert.equal(nepal.at(-1).to,'2026-10-01T02:20:00.000Z');
});
test('31-day calendar generation stays bounded and preserves every boundary',t=>{
 const q={...scope,to:'2026-11-01T00:00:00.000Z'};
 const before=performance.now(),hour=calendarBuckets(q),day=calendarBuckets({...q,bucket:'day'});
 t.diagnostic('31-day hour+day boundary generation: '+(performance.now()-before).toFixed(2)+' ms');
 assert.equal(hour.length,744);assert.equal(day.length,32);
 for(const rows of [hour,day]){assert.equal(Date.parse(rows[0].from),Date.parse(q.from));assert.equal(rows.at(-1).to,q.to);for(let i=1;i<rows.length;i++)assert.equal(rows[i-1].to,rows[i].from)}
});
test('capacities reject instead of returning partial data, errors propagate',async()=>{
 const repo=row=>({clock:()=>scope.to,events:{aggregate:()=>({toArray:async()=>[row]})},listRules:async()=>[]});
 for(const row of [{capacity:[{total:50001}]},{catalogZones:Array(5001).fill({})},{zones:Array(1001).fill({})}])await assert.rejects(()=>queryAlarmAnalytics(repo(row),scope),e=>e.code==='analytics_capacity');
 const r=await queryAlarmAnalytics(repo({}),scope);assert.equal(r.total,0);assert.equal(r.quality.wait.median_ms,null);assert.equal(r.coverage,'unknown');
 await assert.rejects(()=>queryAlarmAnalytics(repo({}),scope,{limits:{...ANALYTICS_LIMITS,bytes:1}}),e=>e.code==='analytics_capacity');
 await assert.rejects(()=>queryAlarmAnalytics({...repo({}),events:{aggregate:()=>({toArray:async()=>{throw Error('db timeout')}})}},scope),/db timeout/);
 for(const [code,expected] of [[50,'analytics_timeout'],[292,'analytics_capacity'],[10334,'analytics_capacity']])await assert.rejects(()=>queryAlarmAnalytics({...repo({}),events:{aggregate:()=>({toArray:async()=>{throw Object.assign(Error('query failed'),{code})}})}},scope),e=>e.code===expected);
});
test('HTTP protects the analytics endpoint and preserves domain errors',async()=>{
 const token='test-token-'.repeat(5);let seen;
 const app=createApp({apiToken:token,repository:{analytics:async q=>{seen=q;return {total:2}}}});
 try{
  assert.equal((await app.inject({method:'POST',url:'/v1/events/analytics',payload:scope})).statusCode,401);
  const r=await app.inject({method:'POST',url:'/v1/events/analytics',headers:{authorization:'Bearer '+token},payload:scope});assert.equal(r.statusCode,200);assert.equal(r.json().total,2);assert.deepEqual(seen,scope);
  assert.equal((await app.inject({method:'POST',url:'/v1/events/analytics',headers:{authorization:'Bearer '+token},payload:{large:'x'.repeat(17000)}})).statusCode,413);
  assert.equal((await app.inject({url:'/v1/events?analytcis=bad',headers:{authorization:'Bearer '+token}})).statusCode,422);
 }finally{await app.close()}
});
