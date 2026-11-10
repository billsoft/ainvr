import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {coverageStep} from '../src/flow-coverage.mjs';
// One walking target sampled at any frame rate. Time, not frame count, decides
// whether a pause in the input can be bridged: a person covers the same distance
// per second at 2 FPS and at 30 FPS.
const square=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const base={version:1,name:'counter',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',
 behavior:'region_traverse',anchor:'center',alarm_enabled:false,hysteresis_px:5,points:square};
const line=(max_gap_ms=1500)=>({...base,id:'line',passage:{kind:'line',edges:[3],max_gap_ms}});
const gates=(max_gap_ms=1500)=>({...base,id:'gates',passage:{kind:'gates',edges:[1,3],max_gap_ms}});
// The AI service marks a source interval above one second as a continuity gap.
const AI_GAP_MS=1000;
function play(rule,samples,{session='s'}={}){
 let cp=null,last=null;const events=[],issues=[];
 samples.forEach((v,i)=>{
  const pts=String(Math.round((v.ms+1000)*1e6));
  const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:v.session??session,seq:String(v.seq??i+1),frame_id:String(i+1),source_pts_ns:pts,
   captured_at:new Date(Date.UTC(2026,10,10)+Math.round(v.ms)).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
   tracks:v.absent?[]:[{track_id:v.id??'p',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,event_eligible:true,bbox:{x:v.x*1000-10,y:v.y*1000-10,w:20,h:20}}],
   ...(last!==null&&v.ms-last>AI_GAP_MS?{gap:true}:{})};
  last=v.ms;
  const result=evaluate(cp,f,[rule]);cp=JSON.parse(JSON.stringify(result.checkpoint));events.push(...result.events);issues.push(...result.issues);
 });
 return {events,issues,cp};
}
// Walk at 0.1 of the frame per second (100 px/s); the counting edge x=.3 is crossed at 1.5 s.
function walk(fps,{from=.15,to=.5,y=.5,drop=()=>false}={}){
 const speed=.1,duration=(to-from)/speed*1000*Math.sign(to-from)||0,out=[];
 for(let k=0;k*1000/fps<=Math.abs(duration)+1e-6;k++){
  const ms=k*1000/fps,x=from+Math.sign(to-from)*speed*ms/1000;
  if(!drop(ms))out.push({ms,x,y});
 }
 return out;
}
// Remove the frames right after the target passes the line at 1.5 s.
const after=(count,fps)=>ms=>ms>1500&&ms<=1500+count*1000/fps+1e-6;
for(const fps of [2,3,15,30])for(const dropped of [0,1,2]){
 test(`line counts exactly once at ${fps} FPS with ${dropped} dropped frame(s) after the crossing`,()=>{
  const {events}=play(line(),walk(fps,{drop:after(dropped,fps)}));
  assert.deepEqual(events.map(e=>e.direction.line_direction),['inward']);
 });
 test(`gates count exactly once at ${fps} FPS with ${dropped} dropped frame(s)`,()=>{
  const {events}=play(gates(),walk(fps,{to:.85,drop:after(dropped,fps)}));
  assert.equal(events.length,1);
  assert.deepEqual([events[0].direction.entry_edge,events[0].direction.exit_edge],[3,1]);
 });
}
test('a stall of 1.2 s at 3 FPS (flagged by the AI service) still counts one passage',()=>{
 const samples=walk(3).filter(s=>s.ms<=1400||s.ms>=2600);
 const {events}=play(line(),samples);
 assert.equal(events.length,1);
 assert.equal(events[0].analysis_evidence.traversal.observation_gaps,1);
});
test('a fluctuating rate (333 -> 667 -> 1000 ms) across the crossing counts once',()=>{
 const times=[0,333,667,1000,1333,2000,3000,3333,3667,4000];
 const {events}=play(line(),times.map(ms=>({ms,x:.15+.1*ms/1000,y:.5})));
 assert.equal(events.length,1);
});
test('the reverse walk counts the other direction once at low and high frame rates',()=>{
 for(const fps of [2,30]){
  const {events}=play(line(),walk(fps,{from:.45,to:.1}));
  assert.deepEqual(events.map(e=>e.direction.line_direction),['outward']);
 }
});
test('a pause longer than the configured retention is not bridged',()=>{
 // 2 FPS, three frames missing at the line = 2 s without any frame.
 assert.equal(play(line(1500),walk(2,{to:.6,drop:after(3,2)})).events.length,0);
 // The same walk without the pause counts, so the pause alone decides.
 assert.equal(play(line(1500),walk(2,{to:.6})).events.length,1);
});
test('an observed crossing interrupted by a pause beyond retention is diagnosed',()=>{
 const samples=[...walk(3).filter(s=>s.ms<=1667),...walk(3,{to:.6}).filter(s=>s.ms>=3700)];
 const {events,cp}=play(line(1500),samples);
 assert.equal(events.length,0);
 assert.ok(cp.passage_diagnostics.some(d=>['passage_gap_timeout','passage_input_gap'].includes(d.reason)),JSON.stringify(cp.passage_diagnostics));
});
test('retention 0 bridges no input pause',()=>{
 const samples=walk(3).filter(s=>s.ms<=1400||s.ms>=2600);
 assert.equal(play(line(0),samples).events.length,0);
});
test('a pause bridged for identity cannot confirm by itself: real post-pause samples are still required',()=>{
 // Crossing observed, then the stream stalls and only one sample follows.
 const samples=[...walk(3).filter(s=>s.ms<=1667),{ms:2900,x:.44,y:.5}];
 assert.equal(play(line(),samples).events.length,0);
});
test('missing records, PTS resets and session changes still break counting evidence',()=>{
 const crossing=walk(3).filter(s=>s.ms<=1667);
 const tail=walk(3).filter(s=>s.ms>1667);
 for(const patch of [{seq:100},{session:'other'}]){
  const samples=[...crossing,...tail.map((s,i)=>({...s,...(i===0||patch.session?patch:{}),...(patch.seq?{seq:patch.seq+i}:{})}))];
  assert.equal(play(line(),samples).events.length,0,JSON.stringify(patch));
 }
});
test('alarm rules keep the strict break across an input gap',()=>{
 const alarm={...base,id:'enter',behavior:'region_enter',alarm_enabled:true};
 const {events}=play(alarm,[{ms:0,x:.2,y:.5},{ms:333,x:.22,y:.5},{ms:1600,x:.4,y:.5},{ms:1933,x:.41,y:.5}]);
 assert.equal(events.length,0);
});
test('a line crossing interrupted by missing records is diagnosed',()=>{
 const samples=[...walk(3).filter(s=>s.ms<=1667),...walk(3).filter(s=>s.ms>1667).map((s,i)=>({...s,seq:200+i}))];
 const {cp}=play(line(),samples);
 assert.ok(cp.passage_diagnostics.some(d=>d.reason==='passage_input_gap'&&d.rule_id==='line'),JSON.stringify(cp.passage_diagnostics));
});
test('a line crossing whose identity ends before confirmation is diagnosed',()=>{
 const samples=[...walk(3).filter(s=>s.ms<=1667),{ms:2000,absent:true,x:0,y:0}];
 const {cp}=play(line(),samples);
 assert.ok(cp.passage_diagnostics.some(d=>d.reason==='passage_identity_ended'&&d.rule_id==='line'),JSON.stringify(cp.passage_diagnostics));
});
// Replayed from .190 (segment 142024.881, a 30 FPS recording with a 1.33 s input
// hole): a large box walks away from the line, the stream pauses, and ByteTrack
// hands the same ID to a smaller person behind the line. Pixel values are exact.
function handover(rule,after){
 const W=1920,H=1080,frames=[[0,1548,876,545,543],[33,1552,885,546,539],[100,1556,895,554,535],[133,1560,903,557,531],[300,1570,925,497,533],[333,1583,932,485,539],[400,1619,1066,444,668],...after];
 let cp=null;const events=[],issues=[];
 frames.forEach(([ms,cx,bottom,w,h],i)=>{
  const pts=String((ms+1000)*1e6),gap=i>0&&ms-frames[i-1][0]>1000;
  const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,10,10)+ms).toISOString(),
   source:{width:W,height:H,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},...(gap?{gap:true}:{}),
   tracks:[{track_id:'p',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,event_eligible:true,bbox:{x:cx-w/2,y:Math.min(H,bottom)-h,w,h}}]};
  const r=evaluate(cp,f,[rule]);cp=JSON.parse(JSON.stringify(r.checkpoint));events.push(...r.events);issues.push(...r.issues);
 });
 return {events,issues,cp};
}
const liveLine={...base,id:'live',anchor:'bottom_center',hysteresis_px:5.4,points:[[.6052,.4466],[.6412,.4466],[.6412,.9553],[.6052,.9553]],passage:{kind:'line',edges:[1],max_gap_ms:1500}};
test('an ID handed to another person across an input pause cannot count a reverse crossing',()=>{
 const {events,cp}=handover(liveLine,[[1733,1097,852,363,438],[1800,1138,860,365,435],[1867,1172,864,386,423],[1900,1171,864,386,423],[1933,1187,874,393,428]]);
 assert.equal(events.length,0);
 // No passage was in progress before the pause, so this is not reported as a possible miss.
 assert.equal((cp.passage_diagnostics??[]).length,0);
 const key=JSON.stringify(['live',1,'p']);
 assert.ok(!cp.states[key]?.traversal?.gaps,'the handover is not bridged');
 // The same person continuing in the same direction after the pause is bridged.
 const same=handover(liveLine,[[1733,1650,1070,450,670],[1767,1665,1070,452,668]]);
 assert.equal(same.cp.states[key].traversal.gaps,1);
});
test('a target approaching the line before an input pause still counts after it',()=>{
 // Walks left toward the line (x=1231 px), pauses 1.3 s, reappears beyond it.
 const W=1920,frames=[[0,1500],[100,1470],[200,1440],[300,1410],[400,1380],[1700,1150],[1800,1120],[1900,1090],[2000,1060]];
 let cp=null;const events=[];
 frames.forEach(([ms,cx],i)=>{
  const pts=String((ms+1000)*1e6),gap=i>0&&ms-frames[i-1][0]>1000;
  const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,10,10)+ms).toISOString(),
   source:{width:W,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},...(gap?{gap:true}:{}),
   tracks:[{track_id:'p',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,event_eligible:true,bbox:{x:cx-60,y:600,w:120,h:300}}]};
  const r=evaluate(cp,f,[liveLine]);cp=JSON.parse(JSON.stringify(r.checkpoint));events.push(...r.events);
 });
 assert.deepEqual(events.map(e=>e.direction.line_direction),['inward']);
});
test('a target standing still before an input pause may cross during it',()=>{
 const samples=[...[0,333,667,1000,1333].map(ms=>({ms,x:.27,y:.5})),...[2600,2933,3267,3600].map(ms=>({ms,x:.36,y:.5}))];
 assert.deepEqual(play(line(),samples).events.map(e=>e.direction.line_direction),['inward']);
});
test('an interrupted coverage segment keeps its unwritten tail',()=>{
 const cp={},rule={behavior:'region_traverse',counter_id:'c',assignment_id:'b',version:1},t0=Date.UTC(2026,10,10),written=[];
 const frame=(ms,seq)=>({channel_id:'ch',input_stream_id:'in',stream_session_id:'s',seq:String(seq),captured_at:new Date(t0+ms).toISOString()});
 let seq=0;
 for(let ms=0;ms<=9000;ms+=333)written.push(...coverageStep(cp,frame(ms,++seq),[rule],false));
 written.push(...coverageStep(cp,frame(12000,++seq),[rule],true));
 const ends=new Map();for(const s of written)ends.set(s.segment_id,s.to>(ends.get(s.segment_id)??'')?s.to:ends.get(s.segment_id));
 assert.deepEqual([...ends.values()].sort(),[new Date(t0+8991).toISOString(),new Date(t0+12000).toISOString()]);
});
