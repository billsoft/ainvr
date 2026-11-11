// A missed-detection tolerance is meant in frames. Frames sampled at 2 FPS from a 25 FPS camera arrive
// 480 and 520 ms apart, so "1500 ms" used to cover two missed frames or only one, by 20 ms of chance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {gapAllowance} from '../src/passage-continuity.mjs';
const W=1920,H=1080;
const counter={id:'flow:r',version:1,name:'counter',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'bottom_center',alarm_enabled:false,
 points:[[.60,.3],[.64,.3],[.64,.9],[.60,.9]],duration_ms:0,hysteresis_px:5,passage:{kind:'line',edges:[1],max_gap_ms:1500}};
// steps: [time in ms, x of the bottom-centre or null when the target is not detected]
function play(steps){
 let cp=null,last=.3;const events=[],issues=[];
 steps.forEach(([ms,x],i)=>{
  const pts=String(BigInt(ms+1000)*1000000n),seen=x!==null;if(seen)last=x;
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:`s:${i+1}`,source_pts_ns:pts,source_frame_index:String(i+1),captured_at:new Date(1760918400000+ms).toISOString(),
   source:{width:W,height:H,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
   tracks:[{track_id:'t',label_id:'p',state:'confirmed',observation:seen?'detected':'lost',last_observed_pts_ns:pts,bbox:{x:last*W-100,y:400,w:200,h:300}}]};
  const result=evaluate(cp,frame,[counter]);cp=result.checkpoint;events.push(...result.events);issues.push(...result.issues);
 });
 return {events,issues};
}
const approach=[[0,.28],[520,.30],[1000,.31],[1520,.35],[2000,.42],[2520,null]];
test('two missed frames after the crossing are tolerated whichever way the 480/520 ms intervals fall',()=>{
 // Crosses to .70 at 3000, missed at 3520 and 4000, seen again 1520 ms after the last detection.
 const {events,issues}=play([...approach,[3000,.70],[3520,null],[4000,null],[4520,.80],[5000,null],[5520,.86],[6000,.875]]);
 assert.deepEqual(issues.filter(i=>i.startsWith('passage_gap')),[]);
 assert.equal(events.length,1);
});
test('three missed frames still exceed a 1500 ms tolerance at 2 FPS',()=>{
 const {events,issues}=play([...approach,[3000,.70],[3520,null],[4000,null],[4520,null],[5000,.80],[5520,.86],[6000,.875]]);
 assert.equal(events.length,0);
 assert.ok(issues.some(i=>i.startsWith('passage_')));
});
test('the tolerance is rounded to whole frames: never below the setting, less than one frame above it',()=>{
 const rule={passage:{max_gap_ms:1500}};
 assert.equal(gapAllowance(rule),1500);
 for(const cadence of [33,40,66,67,100,200,320,333,360,480,500,520,1000]){
  const allowed=gapAllowance(rule,cadence);
  assert.ok(allowed>=1500&&allowed<1500+cadence,`${cadence} ms cadence gives ${allowed}`);
  // The limit never sits within a tenth of a frame of a whole number of frames.
  const frames=allowed/cadence,offset=Math.abs(frames-Math.round(frames));
  assert.ok(allowed===1500||offset>.4,`${cadence} ms cadence: limit ${allowed} is ${frames.toFixed(2)} frames`);
 }
 assert.equal(gapAllowance(rule,480),1680);assert.equal(gapAllowance(rule,520),1820);
 assert.equal(gapAllowance(rule,1000),1500,'exactly one and a half frames stays at the setting');
 assert.equal(gapAllowance(rule,2000),1500,'a channel slower than the tolerance keeps the setting');
 assert.equal(gapAllowance({alarm_enabled:true},500),0,'alarm rules still tolerate nothing');
});
