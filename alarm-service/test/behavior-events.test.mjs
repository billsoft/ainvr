import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
test('behavior counts survive partial materialization, replay and alarm acknowledgement; statistics-only rules work',{skip:!enabled},async()=>{
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();
    const rule={id:'r',version:1,name:'Appearance',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance'};
    await repo.saveRule(rule,0,'test');
    const input={schema_version:'1.0',producer_id:'p',offset:'1',frame:{schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:'1',frame_id:'s:1',source_pts_ns:'1000000000',captured_at:'2026-10-19T08:00:00+08:00',source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:'1000000000',bbox:{x:10,y:10,w:30,h:50}}]}};
    const broken=new ObservationConsumer(repo,{hook:async point=>{if(point==='behavior_inserted')throw Error('injected');}});
    await assert.rejects(()=>broken.consume(input),/injected/);
    assert.equal(await repo.behaviors.collection.countDocuments(),1);assert.equal(await repo.events.countDocuments(),0);
    const consumer=new ObservationConsumer(repo);await consumer.consume(input);await consumer.consume(input);
    assert.equal(await repo.behaviors.collection.countDocuments(),1);assert.equal(await repo.events.countDocuments(),1);
    const alarm=await repo.events.findOne();assert.equal(alarm.behavior_event_ids.length,1);
    const query={from:'2026-10-19T00:00:00Z',to:'2026-10-19T00:00:01Z',channel_id:'c'};
    const before=await repo.behaviors.statistics(query);assert.deepEqual(before.items,[{event_type:'appearance',occurrences:1,tracked_targets:1}]);
    await repo.confirm(alarm.alarm_id,{expected_handling_revision:0},'operator','ack');
    assert.deepEqual(await repo.behaviors.statistics(query),before);
    assert.equal((await repo.behaviors.statistics({...query,to:'2026-10-19T00:00:00.001Z'})).items[0].occurrences,1);
    assert.deepEqual((await repo.behaviors.statistics({...query,from:'2026-10-19T00:00:00.001Z'})).items,[]);
    assert.equal(before.coverage.state,'unknown');
    await repo.saveRule({...rule,version:2,alarm_enabled:false},1,'test');
    const next=structuredClone(input);next.offset='2';next.frame.seq='2';next.frame.frame_id='s:2';next.frame.source_pts_ns='2000000000';next.frame.tracks[0].last_observed_pts_ns='2000000000';
    const result=await consumer.consume(next);assert.deepEqual(result.events,[]);assert.equal(result.behavior_events.length,1);
    assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),2);
    assert.deepEqual((await repo.behaviors.statistics(query)).items,[{event_type:'appearance',occurrences:2,tracked_targets:1}]);
    await assert.rejects(()=>repo.behaviors.statistics({...query,to:'2027-01-01T00:00:00Z'}),e=>e.code==='invalid_time_range');
  }finally{await db.dropDatabase();await client.close();}
});
