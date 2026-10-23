import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {FlowStatistics} from '../src/flow-statistics.mjs';
import {createApp} from '../src/http.mjs';
test('bounded clear: boundaries, other bindings, retry, late replay, totals/trend/records, audit and live continuation',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=await new MongoClient('mongodb://127.0.0.1:27028').connect(),db=client.db('ainvr_flow_clear_test_'+randomUUID().replaceAll('-',''));
 const flow=new FlowStatistics(db),app=createApp({repository:{flow},apiToken:'a'.repeat(32)});
 const from='2026-10-01T00:00:00.000Z',to='2026-10-01T00:01:00.000Z';
 const fact=(id,rule,time)=>({event_id:id,counter_id:rule==='other'?'other':'ship',rule_id:rule,event_type:'region_traverse',occurred_at:time,label_id:'person',quality:{trajectory_complete:true},direction:{line_direction:'inward'},stream_session_id:'s',track_id:id});
 const series=rule=>({key:rule,rule_id:rule,label_ids:['person'],from:'2026-09-30T23:59:00.000Z',to:'2026-10-01T00:02:00.000Z',filter:{kind:'line',side:'inward'}});
 try{
  await flow.initialize();await app.ready();
  await flow.facts.insertMany([fact('before','a','2026-09-30T23:59:59.999Z'),fact('start','a',from),fact('inside','a','2026-10-01T00:00:30.000Z'),fact('end','a',to),fact('b','b',from),fact('other','other',from)]);
  const payload={counter_id:'ship',rule_ids:['a'],from,to},headers={authorization:'Bearer '+'a'.repeat(32),'x-ainvr-actor':'operator','idempotency-key':'clear-1'};
  assert.equal((await app.inject({method:'POST',url:'/v1/flow/clear',payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/flow/clear',headers,payload})).statusCode,200);
  assert.equal(await flow.facts.countDocuments({rule_id:'a'}),2);
  assert.equal((await app.inject({method:'POST',url:'/v1/flow/clear',headers,payload})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/v1/flow/clear',headers,payload:{...payload,rule_ids:['b']}})).statusCode,409);
  await flow.facts.insertOne(fact('delayed','a',from)); // late materialization must stay excluded
  for(const totals_only of [true,false]){
   const result=await flow.query({series:[series('a'),series('b'),series('other')],bucket:'minute',totals_only});
   assert.deepEqual(result.items.map(x=>x.occurrences),[2,1,1]);
   if(!totals_only)assert.equal(result.items[0].buckets.reduce((n,b)=>n+b.occurrences,0),2);
  }
  assert.deepEqual((await flow.query({series:[series('a')],detail:true})).items.map(x=>x.event_id),['end','before']);
  await flow.facts.insertOne(fact('new','a','2026-10-01T00:01:01.000Z'));
  assert.equal((await flow.query({series:[series('a')],totals_only:true})).items[0].occurrences,3);
  assert.equal((await flow.clears.findOne({_id:'clear-1'})).actor,'operator');
  // A crash after ledger commit is safe before physical delete completes.
  const del=flow.facts.deleteMany.bind(flow.facts);flow.facts.deleteMany=async()=>{throw Error('fault')};
  await assert.rejects(()=>flow.clear({...payload,rule_ids:['b']},'operator','clear-2'),/fault/);
  assert.equal((await flow.query({series:[series('b')],totals_only:true})).items[0].occurrences,0);
  flow.facts.deleteMany=del;await flow.clear({...payload,rule_ids:['b']},'operator','clear-2');
  assert.equal(await flow.facts.countDocuments({rule_id:'b'}),0);
  await assert.rejects(()=>flow.clear({...payload,to:'2099-01-01T00:00:00Z'},'operator','bad'),e=>e.code==='invalid_time_range');
 }finally{await app.close();await db.dropDatabase();await client.close();}
});
