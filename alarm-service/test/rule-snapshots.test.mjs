import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {createApp} from '../src/http.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
test('atomic PG rule snapshots replace legacy rules, reject stale writes and survive restart',{skip:!enabled},async()=>{
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});
  await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();
    const rule={id:'r',version:1,name:'Gate',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g1',label_map_version:'l1',behavior:'appearance'};
    await repo.saveRule({...rule,id:'legacy'},0,'operator');
    const snapshot={schema_version:'1.0',revision:'1',rules:[rule]};
    const applied=await repo.ruleSnapshots.apply(snapshot,'console');
    assert.equal(applied.applied,true);assert.deepEqual(await repo.ruleSnapshots.apply(snapshot,'console'),applied);
    assert.deepEqual((await repo.listRules()).map(r=>r.id),['r']);
    await assert.rejects(repo.saveRule({...rule,id:'bypass'},0,'operator'),e=>e.code==='configuration_managed');
    await assert.rejects(repo.ruleSnapshots.apply({...snapshot,rules:[]},'console'),e=>e.code==='revision_conflict');
    await assert.rejects(repo.ruleSnapshots.apply({...snapshot,revision:'0'},'console'),e=>e.code==='stale_revision');
    await assert.rejects(repo.ruleSnapshots.apply({...snapshot,revision:'2',rules:[{...rule,name:'changed'}]},'console'),e=>e.code==='rule_version_conflict');
    await assert.rejects(repo.ruleSnapshots.apply({...snapshot,revision:'2',rules:[rule,rule]},'console'),e=>e.code==='duplicate_rule');
    const concurrent=await Promise.allSettled([
      repo.ruleSnapshots.apply({...snapshot,revision:'2',rules:[{...rule,version:2,name:'two'}]},'console'),
      repo.ruleSnapshots.apply({...snapshot,revision:'3',rules:[]},'console'),
    ]);
    assert.equal(concurrent[1].status,'fulfilled');
    const restarted=new AlarmRepository(db);
    assert.deepEqual(await restarted.listRules(),[]);
    assert.equal((await restarted.ruleSnapshots.status()).revision,'3');
    assert.equal((await restarted.ruleSnapshots.status()).rule_count,0);
  }finally{await db.dropDatabase();await client.close();}
});
test('snapshot HTTP writes require operator credential and authenticated actor',async()=>{
  const apiToken='operator-test-'.repeat(4),producerToken='producer-test-'.repeat(4);
  let calls=0;
  const app=createApp({apiToken,producerToken,consumer:{},repository:{ruleSnapshots:{apply:async(body,actor)=>{calls++;return {applied:true,revision:body.revision,actor}}}}});
  try{
    const request={method:'POST',url:'/v1/configuration/rules',payload:{schema_version:'1.0',revision:'1',rules:[]}};
    assert.equal((await app.inject({...request,headers:{authorization:`Bearer ${producerToken}`}})).statusCode,401);
    assert.equal((await app.inject({...request,headers:{authorization:`Bearer ${apiToken}`}})).statusCode,422);
    assert.equal(calls,0);
    assert.equal((await app.inject({...request,headers:{authorization:`Bearer ${apiToken}`,'x-ainvr-actor':'console'}})).json().applied,true);
    assert.equal(calls,1);
  }finally{await app.close();}
});
