import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {behaviorEvent} from '../src/behavior-events.mjs';
const base={id:'r',version:1,name:'Passage',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'center',alarm_enabled:false,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
export function replay(xs,options={}){
 let cp=null;const events=[],issues=[];
 xs.forEach((value,i)=>{
  const v=typeof value==='number'?{x:value}:value,ms=v.ms??i*100,pts=String((ms+1000)*1000000);
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:v.session??'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,21)+ms).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:v.absent?[]:[{track_id:v.id??'t',label_id:v.label??'person',state:v.state??'confirmed',observation:v.predicted?'predicted':'detected',last_observed_pts_ns:v.predicted?String((ms+900)*1000000):pts,event_eligible:v.eligible??true,bbox:{x:v.x*1000-10,y:(v.y??.5)*1000-10,w:20,h:20}}],...(v.gap?{gap:true}:{})};
  const result=evaluate(cp,frame,[{...base,...options}]);cp=result.checkpoint;events.push(...result.events);issues.push(...result.issues);
 });return {events,issues,cp};
}
test('same-ID short hidden observation preserves entry; prediction alone never completes passage',()=>{
 const r=replay([.2,.4,{x:.5,predicted:true},.6,.8,.9]);assert.equal(r.events.length,1);
 const q=behaviorEvent(r.events[0]).quality;assert.equal(q.observation_gaps,1);assert.equal(q.basis,'observed_endpoints');
 assert.equal(replay([.2,.4,{x:.8,predicted:true}]).events.length,0);
 assert.equal(replay([.2,.4,{x:.5,eligible:false},.6,.8]).events.length,1);
});
test('hard loss, ID/session changes, explicit input gap and gap over deadline never bridge',()=>{
 for(const middle of [{x:.5,absent:true},{x:.5,id:'new'},{x:.5,session:'new'},{x:.5,gap:true},{x:.5,state:'tentative'},{x:.5,label:'other'}])assert.equal(replay([.2,.4,middle,.8]).events.length,0);
 assert.equal(replay([.2,.4,{x:.5,predicted:true},{x:.8,ms:1400}]).events.length,0);
 // Alarm sources remain strict unless explicitly opted into the statistics contract.
 assert.equal(replay([.2,.4,{x:.5,predicted:true},.8],{alarm_enabled:true}).events.length,0);
});
test('crossing at a hidden interval needs plausible observed endpoints and unique geometry',()=>{
 assert.equal(replay([.2,.4,.5,{x:.6,predicted:true},.8]).events.length,1);
 assert.equal(replay([.2,.4,{x:.5,predicted:true},{x:.95,ms:201}]).events.length,0);
 assert.equal(replay([.2,.4,.8,.9,.6,.2]).events.length,2);
});
test('line counts finite stable segment crossings in both directions, not jitter or endpoint extension',()=>{
 const passage={kind:'line',edges:[3],max_gap_ms:1000};
 const r=replay([.1,.2,.4,.5,.4,.2,.1,.1],{passage});
 assert.equal(r.events.length,2);assert.deepEqual(r.events.map(e=>e.direction.line_direction),['inward','outward']);
 assert.equal(replay([.29,.301,.299,.302,.298],{passage}).events.length,0);
 assert.equal(replay([{x:.2,y:.1},{x:.4,y:.1}],{passage}).events.length,0);
});
test('two gates count observed segment spanning both gates, reject same-gate return and ordinary zone skip',()=>{
 const passage={kind:'gates',edges:[3,1],max_gap_ms:1000};
 assert.equal(replay([.2,.8],{passage}).events.length,1);
 assert.equal(replay([.2,.4,.2],{passage}).events.length,0);
 assert.equal(replay([.2,.8]).events.length,0);
 const r=replay([.2,.8,.9,.2],{passage});assert.equal(r.events.length,2);
 assert.deepEqual(r.events.map(e=>[e.direction.entry_edge,e.direction.exit_edge]),[[3,1],[1,3]]);
});
test('checkpoint replay is deterministic and a completed passage cannot repeat',()=>{
 const run=replay([.2,.4,{x:.5,predicted:true},.6,.8,.9]);
 assert.equal(run.events.length,1);assert.equal(JSON.parse(JSON.stringify(run.cp)).states[JSON.stringify(['r',1,'t'])].traversal.entry,null);
});

test('continuity diagnostics require an active passage, not a distant waiting track',()=>{
 const passage={kind:'line',edges:[3],max_gap_ms:1000};
 const far=replay([.1,.1,{x:.1,predicted:true},{x:.1,ms:1400}],{passage});
 assert.equal(far.events.length,0);
 assert.equal(far.issues.some(x=>x.startsWith('passage_gap_')),false);
 const active=replay([.1,.2,.4,{x:.4,predicted:true},{x:.5,ms:1400}],{passage});
 assert.equal(active.events.length,0);
 assert.ok(active.issues.some(x=>x.startsWith('passage_gap_timeout:')));
});
