// A service upgrade must not break synchronization of rules saved by older code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {digest} from '../src/domain.mjs';
import {AlarmRepository} from '../src/repository.mjs';
const square=[[.1,.1],[.9,.1],[.9,.9]];
test('rules applied by older code still synchronize after the upgrade',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
  const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
  const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
  try{
    const repo=new AlarmRepository(db);await repo.initialize();
    // Monitor-era rules: behaviors and parameters the trigger engine no longer accepts.
    const legacy=[{id:'m:region_contact',monitor_id:'m',version:3,name:'old',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_contact',points:square,approach_distance:.05,max_gap_ms:3000},
      {id:'m:region_approach',monitor_id:'m',version:3,name:'old',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_approach',points:square,approach_distance:.05}];
    await db.collection('alarm_rule_snapshot').insertOne({_id:'active',schema_version:'1.0',revision:'5',digest:digest(legacy),rules:legacy,applied_at:'2026-10-19T14:38:16.183Z',actor:'console'});
    const triggers=[{id:'front@gate',trigger_id:'front',version:1,name:'前区有人',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',duration_ms:3000},
      {id:'m:region_approach@gate',trigger_id:'m:region_approach',version:1,name:'old',channel_id:'gate',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_approach',points:square,approach_px:96}];
    assert.equal((await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'6',rules:triggers},'console')).applied,true);
    assert.equal((await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'6',rules:triggers},'console')).applied,true);
    await assert.rejects(repo.ruleSnapshots.apply({schema_version:'1.0',revision:'7',rules:[{...triggers[0],duration_ms:9000},triggers[1]]},'console'),e=>e.code==='rule_version_conflict');
  }finally{await db.dropDatabase();await client.close();}
});
