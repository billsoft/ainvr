import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {buildReviewEvidence} from '../src/review-evidence.mjs';
// Group conditions for state behaviours: the selected targets must satisfy the
// behaviour at the same time; the window only tolerates missed detections
// (a member stays counted while its last real qualifying sighting is younger
// than the window). It is not a dwell time. Sampled at 3 FPS.
const square=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const FRAME=333;
function camera(behavior,group,labels=['person','bag'],extra={}){
 const rule={id:'r',name:'group',version:1,state:'enabled',channel_id:'c',geometry_revision:'g',label_map_version:'l',behavior,label_ids:labels,anchor:'bottom_center',
  ...(group?{group}:{}),...(behavior==='appearance'?{}:{points:square}),...(behavior==='region_approach'?{approach_px:60}:{}),
  ...(['region_enter','region_approach'].includes(behavior)?{spatial_semantics:'bbox-state-v1'}:{}),...extra};
 let cp=null,seq=0;
 // subject: [id,label,x,observation('d' detected,'p' predicted,'w' weak)]
 const step=(ms,subjects)=>{
  seq++;const pts=String((ms+1000)*1e6),last=String((ms+1000-FRAME)*1e6);
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),source_frame_index:String(seq),source_pts_ns:pts,frame_id:'f'+seq,
   captured_at:new Date(1760000000000+ms).toISOString(),source:{width:1000,height:1000,geometry_revision:'g',coordinate_space:'source_pixels'},model:{label_map_version:'l'},
   tracks:subjects.map(([id,label='person',x=.5,o='d'])=>({track_id:id,label_id:label,state:'confirmed',observation:o==='p'?'predicted':'detected',
    last_observed_pts_ns:o==='p'?last:pts,event_eligible:o!=='w',bbox:{x:x*1000-20,y:460,w:40,h:60}}))};
  const out=evaluate(cp,frame,[rule]);cp=structuredClone(out.checkpoint);return out.events;
 };
 return step;
}
const run=(step,frames)=>frames.map(([ms,subjects])=>step(ms,subjects).length);
const at=(...lists)=>lists.map((s,i)=>[i*FRAME,s]);
const and=w=>({labels:'all',minimum:2,window_ms:w});
for(const behavior of ['appearance','region_enter']){
 test(`${behavior}: person alone or bag alone never triggers person AND bag`,()=>{
  assert.deepEqual(run(camera(behavior,and(1000)),at([['p']],[['p']],[['p']],[['p']])),[0,0,0,0]);
  assert.deepEqual(run(camera(behavior,and(1000)),at([['b','bag']],[['b','bag']],[['b','bag']])),[0,0,0]);
 });
 test(`${behavior}: the bag arriving while the person is still there triggers at once, exactly once`,()=>{
  const p=['p'],b=['b','bag'];
  assert.deepEqual(run(camera(behavior,and(1000)),at([p],[p],[p,b],[p,b],[p,b],[p,b],[p,b])),[0,0,1,0,0,0,0]);
 });
 test(`${behavior}: a missed detection of one member within the window does not break the condition`,()=>{
  const p=['p'],b=['b','bag'];
  // The person coasts (predicted) on the frame the bag first appears.
  assert.deepEqual(run(camera(behavior,and(1000)),at([p],[['p','person',.5,'p'],b])),[0,1]);
  // A weak (low-confidence) sighting is treated the same way.
  assert.deepEqual(run(camera(behavior,and(1000)),at([p],[['p','person',.5,'w'],b])),[0,1]);
  // Flicker after the alarm does not raise it twice.
  assert.equal(run(camera(behavior,and(1000)),at([p,b],[p,['b','bag',.5,'p']],[p,b],[['p','person',.5,'p'],b],[p,b])).reduce((a,n)=>a+n,0),1);
 });
 test(`${behavior}: beyond the window a coasting member no longer counts`,()=>{
  const p=['p'],b=['b','bag'],coast=['p','person',.5,'p'];
  assert.deepEqual(run(camera(behavior,and(500)),at([p],[coast],[coast],[coast,b])),[0,0,0,0]);
 });
 test(`${behavior}: a person who has left cannot pair with a bag arriving soon after`,()=>{
  const p=['p'],b=['b','bag'];
  // The track ends (no longer reported) before the bag arrives.
  assert.deepEqual(run(camera(behavior,and(1000)),at([p],[p],[],[b],[b])),[0,0,0,0,0]);
 });
 test(`${behavior}: window 0 keeps the strict same-frame meaning`,()=>{
  const p=['p'],b=['b','bag'];
  assert.deepEqual(run(camera(behavior,and(0)),at([p],[['p','person',.5,'p'],b],[p,b])),[0,0,1]);
 });
}
test('review evidence accepts a member last seen within the window and rejects a stale one',()=>{
 const step=camera('region_enter',and(1000));
 step(0,[['p']]);
 const [alarm]=step(FRAME,[['p','person',.5,'p'],['b','bag']]);
 const evidence=buildReviewEvidence(alarm);
 assert.equal(evidence.blocking,false,JSON.stringify(evidence.checks.filter(c=>c.status!=='pass')));
 // Tampering the member sample to be older than the window is a conflict.
 const stale=structuredClone(alarm);
 const m=stale.analysis_evidence.group.members.find(x=>x.sample.track_id==='p');
 m.sample.source_pts_ns=String(BigInt(stale.source_pts_ns)-1200000000n);
 assert.ok(buildReviewEvidence(stale).checks.some(c=>c.id==='member_p'&&c.status==='conflict'));
});
test('region_enter: a person observed outside the zone is not a member',()=>{
 const step=camera('region_enter',and(1000));
 // The person walks out of the zone (detected outside) the frame the bag enters.
 assert.deepEqual(run(step,at([['p']],[['p','person',.1],['b','bag']],[['p','person',.1],['b','bag']])),[0,0,0]);
});
test('region_approach: two people in the approach band, one flickering, trigger once',()=>{
 const step=camera('region_approach',{labels:'any',minimum:2,window_ms:1000},['person']);
 // Both within 60 px of the zone, boxes apart (IoU < 0.5).
 const a=['a','person',.27],b=['b','person',.245];
 assert.deepEqual(run(step,at([a],[['a','person',.27,'p'],b],[a,b],[a,b])),[0,1,0,0]);
});
test('count: three people trigger as soon as three are present, staggered arrivals included',()=>{
 const step=camera('appearance',{labels:'any',minimum:3,window_ms:1000},['person']);
 const a=['a','person',.2],b=['b','person',.5],c=['c','person',.8];
 assert.deepEqual(run(step,at([a],[a,b],[a,b,c],[a,b,c],[a,b,c])),[0,0,1,0,0]);
});
test('count: three people one after another, never together, do not trigger',()=>{
 const step=camera('appearance',{labels:'any',minimum:3,window_ms:1000},['person']);
 assert.deepEqual(run(step,at([['a','person',.2]],[['b','person',.5]],[['c','person',.8]],[['d','person',.4]])),[0,0,0,0]);
});
test('count: an ID switch on one body (old ID coasting beside the new ID) counts once',()=>{
 const step=camera('appearance',{labels:'any',minimum:2,window_ms:1000},['person']);
 assert.deepEqual(run(step,at([['a','person',.5]],[['a','person',.5,'p'],['a2','person',.502]],[['a','person',.5,'p'],['a2','person',.505]])),[0,0,0]);
 // Two real people side by side do count.
 const two=camera('appearance',{labels:'any',minimum:2,window_ms:1000},['person']);
 assert.deepEqual(run(two,at([['a','person',.5]],[['a','person',.5,'p'],['b','person',.6]])),[0,1]);
});
test('a gathering that really dispersed may trigger again; one that only flickered may not',()=>{
 const step=camera('appearance',and(1000));
 const p=['p'],b=['b','bag'];let alarms=0;
 for(let ms=0;ms<=2000;ms+=FRAME)alarms+=step(ms,[p,b]).length;
 for(let ms=2331;ms<=6000;ms+=FRAME)alarms+=step(ms,[]).length;
 for(let ms=6327;ms<=7000;ms+=FRAME)alarms+=step(ms,[['p2'],['b2','bag']]).length;
 assert.equal(alarms,2);
});
