// Standalone alarm-service regression: native JS, Node >=20.12, no backend tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RuleSnapshots} from '../src/rule-snapshots.mjs';

const at=n=>new Date(Date.UTC(2026,10,21)+n*1000).toISOString();
const base=()=>({id:'counter',assignment_id:'counter',trigger_version:1,counter_id:'counter-definition',
  name:'People',version:1,channel_id:'camera',input_stream_id:'source',state:'enabled',
  label_ids:['person'],label_map_version:'labels',geometry_revision:'geometry',anchor:'center',
  behavior:'region_traverse',alarm_enabled:false,zone_id:'zone',zone_version:1,
  points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],edge_ids:['top','right','bottom','left'],
  source_binding:{stream_fingerprint:'f'.repeat(64),input_stream_id:'source',geometry_revision:'geometry',
    label_map_version:'labels',width:1000,height:1000,not_before:at(0)}});
const snapshot=(rule,revision)=>({schema_version:'1.0',revision:String(revision),rules:[rule]});
function store(){
  let row=null;
  return new RuleSnapshots({collection:()=>({
    async findOne(){return structuredClone(row);},
    async insertOne(value){assert.equal(row,null);row=structuredClone(value);},
    async replaceOne(filter,value){
      assert.equal(row.revision,filter.revision);assert.equal(row.digest,filter.digest);
      row=structuredClone(value);return {modifiedCount:1};
    },
  })},{clock:()=>at(0)});
}
const view=(rule,epoch,state,n)=>({...structuredClone(rule),state,view_epoch:epoch.repeat(64),view_not_before:at(n),
  source_binding:{...rule.source_binding,not_before:at(n)}});

test('counter-only enabled -> paused -> resumed accepts runtime epochs at the same authored version',async()=>{
  const execution=store(),authored=base();await execution.apply(snapshot(authored,1),'test');
  const paused=view(authored,'a','paused',2);await execution.apply(snapshot(paused,2),'test');
  assert.equal((await execution.current()).rules[0].state,'paused');
  assert.equal((await execution.status()).rule_count,1);
  const resumed=view(authored,'b','enabled',3);
  const accepted=await execution.apply(snapshot(resumed,3),'test');
  const persisted=(await execution.current()).rules[0];
  assert.equal(persisted.version,1);assert.equal(persisted.alarm_enabled,false);
  assert.deepEqual(persisted.points,authored.points);
  assert.equal(persisted.source_binding.not_before,at(3));
  assert.deepEqual(await execution.apply(snapshot(resumed,3),'test'),accepted);
});

for(const [name,edit] of Object.entries({
  geometry:r=>{r.points[0][0]+=.001;},labels:r=>{r.label_ids=['car'];},
  duration:r=>{r.duration_ms=500;},name:r=>{r.name='Changed';},zoneVersion:r=>{r.zone_version++;},
  sourceIdentity:r=>{r.source_binding.stream_fingerprint='e'.repeat(64);},
  sourceDimensions:r=>{r.source_binding.width=1920;},
}))test(`new runtime epoch cannot hide an unversioned authored ${name} edit`,async()=>{
  const execution=store(),old=view(base(),'a','enabled',1);
  await execution.apply(snapshot(old,1),'test');
  const changed=view(old,'b','paused',2);edit(changed);
  await assert.rejects(execution.apply(snapshot(changed,2),'test'),e=>e.code==='rule_version_conflict');
  assert.equal((await execution.current()).revision,'1');
});

test('changed epoch does not bypass same snapshot revision or stale snapshot rejection',async()=>{
  const execution=store(),old=view(base(),'a','enabled',1);await execution.apply(snapshot(old,2),'test');
  const changed=view(old,'b','paused',2);
  await assert.rejects(execution.apply(snapshot(changed,2),'test'),e=>e.code==='revision_conflict');
  await assert.rejects(execution.apply(snapshot(changed,1),'test'),e=>e.code==='stale_revision');
});

test('same author version requires a new valid epoch and nondecreasing retained time boundaries',async()=>{
  const execution=store(),old=view(base(),'a','enabled',1);await execution.apply(snapshot(old,1),'test');
  for(const mutation of [
    r=>{r.view_epoch=old.view_epoch;},r=>{delete r.view_epoch;},
    r=>{delete r.view_not_before;},r=>{r.view_not_before=at(0);},
    r=>{r.source_binding.not_before=at(0);},
  ]){
    const changed=view(old,'b','paused',2);mutation(changed);
    await assert.rejects(execution.apply(snapshot(changed,2),'test'),e=>e.code==='rule_version_conflict');
  }
  const invalid=view(old,'x','paused',2);
  await assert.rejects(execution.apply(snapshot(invalid,2),'test'),e=>e.code==='invalid_view_epoch');
});

test('real author version increment remains supported; drafts and archived rules cannot execute',async()=>{
  const execution=store(),old=base();await execution.apply(snapshot(old,1),'test');
  const changed={...old,version:2,name:'Updated author definition',points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
  assert.equal((await execution.apply(snapshot(changed,2),'test')).applied,true);
  for(const state of ['draft','archived'])await assert.rejects(
    execution.apply(snapshot({...changed,state},3),'test'),e=>e.code==='unsupported_rule');
});
