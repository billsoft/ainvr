import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {FlowStatistics} from '../src/flow-statistics.mjs';
test('actual Mongo aggregation preserves measured coverage and late facts', {skip:!process.env.AINVR_STATS_TEST_MONGO_URI},async()=>{
 const client=new MongoClient(process.env.AINVR_STATS_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_stats_coverage_test_'+randomUUID().replaceAll('-',''));
 try{
  const service=new FlowStatistics(db);await service.initialize();
  const from='2026-10-01T00:00:00.000Z',to='2026-10-01T01:00:00.000Z';
  await service.record([{segment_id:'proof',assignment_id:'binding',from,to:'2026-10-01T00:30:00.000Z'}]);
  await service.facts.insertOne({event_id:'passage',event_type:'region_traverse',rule_id:'binding',label_id:'person',occurred_at:'2026-10-01T00:20:00.000Z',quality:{trajectory_complete:true},direction:{line_direction:'inward'},stream_session_id:'session',track_id:'target'});
  const result=await service.query({series:[{key:'in',rule_id:'binding',label_ids:['person'],filter:{kind:'line',side:'inward'},from,to}],bucket:'hour',timezone:'Asia/Shanghai'});
  const item=result.items[0];assert.equal(item.occurrences,1);assert.equal(item.buckets[0].occurrences,1);
  assert.equal(item.coverage.expected_ms,3600000);assert.equal(item.coverage.covered_ms,1800000);assert.equal(item.coverage.ratio,.5);assert.equal(item.coverage.state,'partial');
 }finally{await db.dropDatabase();await client.close()}
});
