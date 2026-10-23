import test from 'node:test';
import assert from 'node:assert/strict';
import {replay} from './passage-continuity.test.mjs';
test('rotated boundaries preserve single-line, gates and region counts in both directions',()=>{
 for(const angle of [0,Math.PI/6,Math.PI/2,Math.PI,Math.PI*1.5]){
  const rotate=([x,y])=>[.5+(x-.5)*Math.cos(angle)-(y-.5)*Math.sin(angle),.5+(x-.5)*Math.sin(angle)+(y-.5)*Math.cos(angle)];
  const points=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]].map(rotate);
  const path=xs=>xs.map(x=>{const [a,b]=rotate([x,.5]);return {x:a,y:b}});
  const line=replay(path([.1,.2,.4,.5,.4,.2,.1,.1]),{points,passage:{kind:'line',edges:[3],max_gap_ms:1000}});
  assert.deepEqual(line.events.map(e=>e.direction.line_direction),['inward','outward']);
  for(const passage of [undefined,{kind:'gates',edges:[3,1],max_gap_ms:1000}]){
   const r=replay(path([.2,.4,.6,.8,.9,.6,.4,.2]),{points,...(passage?{passage}:{})});
   assert.deepEqual(r.events.map(e=>[e.direction.entry_edge,e.direction.exit_edge]),[[3,1],[1,3]]);
  }
 }
});

import {traversalStep} from '../src/traversal.mjs';
test('non-square source: every mode preserves direction, finite edges and rejection cases at arbitrary rotation',()=>{
 for(const angle of [0,.17,Math.PI/4,Math.PI/2,2.3,Math.PI,4.7]){
  const rotate=([x,y])=>[(960+x*Math.cos(angle)-y*Math.sin(angle))/1920,(540+x*Math.sin(angle)+y*Math.cos(angle))/1080];
  const points=[[-50,-150],[50,-150],[50,150],[-50,150]].map(rotate);
  function run(kind,path){
   const state={},events=[],rule={points,duration_ms:0,hysteresis_px:5.4,passage:{kind,edges:kind==='line'?[3]:[3,1]}};
   path.forEach(([x,y],i)=>{const event=traversalStep(rule,{source:{width:1920,height:1080},source_pts_ns:String((1000+i*200)*1000000),seq:String(i),frame_id:String(i),captured_at:new Date(1000+i*200).toISOString()},rotate([x,y]),state);if(event)events.push(event)});return events;
  }
  for(const kind of ['line','gates','zone']){
   const events=run(kind,[-100,-80,0,20,80,100,20,-20,-80,-100].map(x=>[x,0]));
   assert.equal(events.length,2,`${kind} at ${angle}`);
   if(kind==='line')assert.deepEqual(events.map(e=>e.direction.line_direction),['inward','outward']);
   else assert.deepEqual(events.map(e=>[e.entry.edge,e.exit.edge]),[[3,1],[1,3]]);
   assert.equal(run(kind,[-100,-80,0,20,80,100].map(x=>[x,200])).length,0,'outside finite boundary');
   assert.equal(run(kind,[-100,-80,0,20,80,100].map(x=>[x,150])).length,0,'ambiguous corner/boundary');
  }
  for(const kind of ['gates','zone']){
   assert.equal(run(kind,[-100,-80,0,-80,-100].map(x=>[x,0])).length,0,'same edge return');
   assert.equal(run(kind,[0,20,80,100].map(x=>[x,0])).length,0,'first observation inside');
  }
  assert.equal(run('zone',[[-100,0],[100,0]]).length,0,'zone requires observed interior');
  assert.equal(run('gates',[[-100,0],[100,0]]).length,1,'gates permit two unambiguous intersections');
 }
});
