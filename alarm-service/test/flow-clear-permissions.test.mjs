import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {FlowStatistics} from '../src/flow-statistics.mjs';
import {alarmRepositoryFor} from '../src/alarm-access.mjs';
import {digest} from '../src/domain.mjs';

const options={skip:process.env.AINVR_BACKEND_FIX_TEST_MONGO!=='1',timeout:30000};
const from='2026-11-12T00:00:00.000Z',to='2026-11-12T00:01:00.000Z';
const request={counter_id:'counter',rule_ids:['flow-binding'],from,to};
const series=[{key:'in',rule_id:'flow-binding',label_ids:['person'],filter:{kind:'line',side:'inward'},from,to}];
const fact=(id,protectedFace=false,extra={})=>({event_id:id,counter_id:'counter',rule_id:'flow-binding',event_type:'region_traverse',label_id:'person',occurred_at:from,stream_session_id:'session',track_id:id,quality:{trajectory_complete:true},direction:{line_direction:'inward'},...(protectedFace?{analysis_evidence:{face:{record_id:'protected'}}}:{}),...extra});
async function setup(t){
  const client=new MongoClient('mongodb://127.0.0.1:27932/?directConnection=true',{serverSelectionTimeoutMS:3000});
  const name='ainvr_flow_scope_test_'+randomUUID().replaceAll('-','');assert.match(name,/^ainvr_flow_scope_test_[a-f0-9]{32}$/);
  let db;t.after(async()=>{try{if(db)await db.dropDatabase();}finally{await client.close();}});
  await client.connect();db=client.db(name);const admin=new FlowStatistics(db);await admin.initialize();
  const ordinary=alarmRepositoryFor({flow:admin},'console-local').flow;
  await admin.facts.insertMany([fact('ordinary'),fact('protected',true)]);
  return {admin,ordinary};
}
async function assertViews(flow,expectedIds){
  const totals=await flow.query({series,totals_only:true});assert.equal(totals.items[0].occurrences,expectedIds.length);
  const trend=await flow.query({series,bucket:'minute'});assert.equal(trend.items[0].occurrences,expectedIds.length);
  assert.equal(trend.items[0].buckets.reduce((n,b)=>n+b.occurrences,0),expectedIds.length);
  const detail=await flow.query({series,detail:true});assert.deepEqual(detail.items.map(x=>x.event_id).sort(),[...expectedIds].sort());
}
test('ordinary clear preserves protected facts for admins in totals, trends, records and late replay',options,async t=>{
  const {admin,ordinary}=await setup(t);
  await assertViews(admin,['ordinary','protected']);await assertViews(ordinary,['ordinary']);
  await ordinary.clear(request,'console-local','ordinary-clear');
  assert.equal((await admin.clears.findOne({_id:'ordinary-clear'})).access_scope,'ordinary');
  assert.equal(await admin.facts.countDocuments({}),1);
  await assertViews(admin,['protected']);await assertViews(ordinary,[]);
  await admin.facts.insertMany([fact('late-ordinary'),fact('late-protected',true),fact('end',false,{occurred_at:to}),fact('other-binding',false,{rule_id:'other'})]);
  await ordinary.clear(request,'console-local','ordinary-clear');
  await assertViews(admin,['protected','late-protected']);await assertViews(ordinary,[]);
  assert.equal(await admin.clears.countDocuments({}),1);
  assert.ok(await admin.facts.findOne({event_id:'end'}));assert.ok(await admin.facts.findOne({event_id:'other-binding'}));
  await assert.rejects(admin.clear(request,'console-administrator','ordinary-clear'),e=>e.code==='operation_conflict');
  await assert.rejects(admin.clear(request,'console-local','ordinary-clear'),e=>e.code==='operation_conflict');
  await assert.rejects(ordinary.clear({...request,rule_ids:['other']},'console-local','ordinary-clear'),e=>e.code==='operation_conflict');
  await assertViews(admin,['protected','late-protected']);
});
test('administrator clear covers both scopes, stays idempotent and cannot replay as ordinary',options,async t=>{
  const {admin,ordinary}=await setup(t);
  await admin.clear(request,'console-administrator','admin-clear');
  assert.equal((await admin.clears.findOne({_id:'admin-clear'})).access_scope,'all');
  assert.equal(await admin.facts.countDocuments({}),0);
  await admin.facts.insertMany([fact('late-ordinary'),fact('late-protected',true)]);
  await admin.clear(request,'console-administrator','admin-clear');
  await assertViews(admin,[]);await assertViews(ordinary,[]);
  await assert.rejects(ordinary.clear(request,'console-local','admin-clear'),e=>e.code==='operation_conflict');
  await assert.rejects(ordinary.clear(request,'console-administrator','admin-clear'),e=>e.code==='operation_conflict');
  assert.equal(await admin.clears.countDocuments({}),1);
});
test('ordinary clear crash after ledger commit preserves permission scope on recovery',options,async t=>{
  const {admin,ordinary}=await setup(t),remove=ordinary.facts.deleteMany;
  ordinary.facts.deleteMany=async()=>{throw Error('injected-delete-failure');};
  await assert.rejects(ordinary.clear(request,'console-local','crash'),/injected-delete-failure/);
  assert.equal(await admin.facts.countDocuments({}),2);
  await assertViews(admin,['protected']);await assertViews(ordinary,[]);
  ordinary.facts.deleteMany=remove;await ordinary.clear(request,'console-local','crash');
  assert.equal(await admin.facts.countDocuments({}),1);
  assert.equal((await admin.clears.findOne({_id:'crash'})).completed,true);
  await assertViews(admin,['protected']);
});
test('legacy ledger infers ordinary/admin scope and validates old idempotency fingerprints',options,async t=>{
  const {admin,ordinary}=await setup(t);
  await admin.clears.insertOne({_id:'legacy',...request,actor:'console-local',fingerprint:digest(['console-local',request])});
  await assertViews(admin,['protected']);
  await ordinary.clear(request,'console-local','legacy');
  assert.equal(await admin.facts.countDocuments({}),1);
  await assert.rejects(admin.clear(request,'console-local','legacy'),e=>e.code==='operation_conflict');
  await admin.clears.insertOne({_id:'legacy-admin',...request,actor:'console-administrator',fingerprint:digest(['console-administrator',request])});
  await admin.clear(request,'console-administrator','legacy-admin');
  await assertViews(admin,[]);assert.equal(await admin.facts.countDocuments({}),0);
});
test('unknown legacy actor cannot hide protected facts; malformed explicit scope fails closed',options,async t=>{
  const {admin}=await setup(t);
  await admin.clears.insertOne({_id:'unknown',...request,completed:true});
  await assertViews(admin,['protected']);
  await admin.clears.updateOne({_id:'unknown'},{$set:{access_scope:'unexpected'}});
  await assert.rejects(admin.query({series,totals_only:true}),e=>e.code==='invalid_clear_history');
});
