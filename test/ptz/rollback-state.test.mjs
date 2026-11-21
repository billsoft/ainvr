import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readRollbackState} from '../../deploy-package/ptz-rollback-state.mjs';

function fixture(guards,scenes,count=0,fail=false,mode=false,presets=0){
 const queries=[];
 return {queries,async query(sql){
  queries.push(sql);
  if(sql.startsWith('BEGIN')||sql==='ROLLBACK')return {};
  if(sql.includes('pg_attribute'))return {rows:[{mode}]};
  if(sql.includes('to_regclass'))return {rows:[{guards,scenes}]};
  if(sql.includes('FROM ptz_view_guards')){
   assert.ok(guards,'must not query absent guards table');
   return {rows:[{blocked:2,stopPending:1}]};
  }
  if(sql.includes('FROM arming_scene_zones')){
   assert.ok(scenes,'must not query absent scene table');
   if(sql.includes("WHERE binding_mode='preset'")){assert.ok(mode);return {rows:[{presetBindings:presets}]};}
   assert.doesNotMatch(sql,/WHERE/i,'every binding, including pending/unmatched, blocks old targets');
   if(fail)throw Error('query unavailable');
   return {rows:[{sceneBindings:count}]};
  }
  throw Error('unexpected query');
 }};
}
for(const guards of [false,true])for(const scenes of [false,true])for(const count of [0,3]){
 test(`read-only snapshot guards=${guards} scenes=${scenes} count=${count}`,async()=>{
  const db=fixture(guards,scenes,count);
  assert.deepEqual(await readRollbackState(db),{blocked:guards?2:0,stopPending:guards?1:0,sceneBindings:scenes?count:0,presetBindings:0});
  assert.equal(db.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.queries.at(-1),'ROLLBACK');
 });
}
for(const presets of [0,2])test(`new schema separately counts formal bindings ${presets}`,async()=>{
 const db=fixture(true,true,3,false,true,presets);
 assert.deepEqual(await readRollbackState(db),{blocked:2,stopPending:1,sceneBindings:3,presetBindings:presets});
 assert.equal(db.queries.at(-1),'ROLLBACK');
});
test('failed scene query rolls back and never reports zero',async()=>{
 const db=fixture(true,true,1,true);
 await assert.rejects(readRollbackState(db),/query unavailable/);
 assert.equal(db.queries.at(-1),'ROLLBACK');
});
