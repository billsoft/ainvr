import test from 'node:test';
import assert from 'node:assert/strict';
import {replay} from './passage-continuity.test.mjs';
import {restorePassage} from '../src/passage-continuity.mjs';

test('line crossing survives 1.2 second same-ID occlusion only within configured allowance',()=>{
 const path=[{x:.1,ms:0},{x:.2,ms:100},{x:.4,ms:200}];
 for(let ms=300;ms<1400;ms+=100)path.push({x:.4,ms,predicted:true});
 path.push({x:.4,ms:1400},{x:.45,ms:1600},{x:.5,ms:1800});
 const passage={kind:'line',edges:[3],max_gap_ms:1500};
 assert.equal(replay(path,{passage}).events.length,1);
 assert.equal(replay(path,{passage:{...passage,max_gap_ms:1000}}).events.length,0);
 assert.equal(replay(path.slice(0,14),{passage}).events.length,0);
 assert.equal(replay(path.map(v=>v.ms>=1400?{...v,id:'other'}:v),{passage}).events.length,0);
});

test('continuity rejection reasons distinguish timeout, movement, size, label and time',()=>{
 const rule={passage:{max_gap_ms:1500}};
 const check=(elapsed,point,bbox,label='person')=>{
  const state={passage_pending:true,passage_observation:{point:[.4,.5],pts:'1000000000',w:20,h:20,label_id:'person'}};
  const valid=restorePassage(rule,{source_pts_ns:String(1000000000+elapsed*1000000),source:{width:1000,height:1000}},{label_id:label,bbox},point,state);
  return {valid,reason:state.passage_rejection};
 };
 assert.equal(check(1600,[.4,.5],{w:20,h:20}).reason,'passage_gap_timeout');
 assert.equal(check(10,[.9,.5],{w:20,h:20}).reason,'passage_gap_displacement');
 assert.equal(check(100,[.4,.5],{w:60,h:60}).reason,'passage_gap_size_change');
 assert.equal(check(100,[.4,.5],{w:20,h:20},'car').reason,'passage_gap_label_changed');
 assert.equal(check(0,[.4,.5],{w:20,h:20}).reason,'passage_gap_time_invalid');
 assert.equal(check(1200,[.45,.5],{w:20,h:20}).valid,true);
});

test('engine persists the specific continuity rejection in bounded diagnostics',()=>{
 const r=replay([.2,.4,{x:.5,predicted:true},{x:.95,ms:201}]);
 assert.ok(r.issues.some(x=>x.startsWith('passage_gap_displacement:')));
 assert.ok(r.cp.passage_diagnostics.some(x=>x.reason==='passage_gap_displacement'));
});
