import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {compactProof} from '../src/compact-evidence.mjs';
import {buildReviewEvidence,reviewTaskContext} from '../src/review-evidence.mjs';
import {boxRegionDistancePx} from '../src/geometry.mjs';
import {stateConfirmation} from '../src/review-state.mjs';
const points=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const base={id:'a',assignment_id:'a',trigger_id:'t',trigger_version:1,version:1,name:'state',channel_id:'ai',input_stream_id:'camera',state:'enabled',label_ids:['person'],labels:[{label_id:'person',name:'person'}],geometry_revision:'g',label_map_version:'lm',behavior:'region_enter',zone_id:'z',zone_version:1,points,anchor:'bottom_center',duration_ms:0,spatial_semantics:'bbox-state-v1',review:{enabled:true,profile_id:'alarm-review-zh-v1',version:1,description:'person',reject_below:.05,approve_above:.95}};
function runner(patch={},detection=false){
 let cp=null,seq=0;
 return (ms,boxes=[{x:290,y:400,w:20,h:30}],predicted=false)=>{
  const pts=String(BigInt(ms+1000)*1000000n),n=String(++seq);
  const f={schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(1792454400000+ms).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},tracks:boxes.map((bbox,i)=>({track_id:'p'+i,label_id:'person',state:'confirmed',observation:predicted?'lost':'detected',last_observed_pts_ns:predicted?String(BigInt(pts)-1n):pts,bbox,...(predicted?{predicted_bbox:bbox}:{})}))};
  if(detection){f.observation_mode='detections';for(const t of f.tracks){t.identity_kind='detection';t.track_id='detection:'+n+':'+t.track_id;}}
  const out=evaluate(cp,f,[{...base,...patch}]);cp=out.checkpoint;return out.events;
 };
}
test('first observed contact triggers without an outside frame; evidence has current state only',()=>{
 const step=runner();const [e]=step(0,[{x:280,y:400,w:20,h:30}]);assert.ok(e);
 assert.equal(e.direction,null);assert.equal(compactProof(e).ok,true);
 assert.equal(e.analysis_evidence.review_context.samples.length,1);
 assert.equal(buildReviewEvidence(e).blocking,false);
 assert.deepEqual(reviewTaskContext(e,e.analysis_evidence.review_context.samples[0]).roles,['首次有效检出','当帧检出']);
 assert.equal(step(100).length,0);
});
test('outside anchor is irrelevant when bounding box overlaps; no contact does not trigger',()=>{
 assert.equal(runner()(0,[{x:280,y:400,w:21,h:30}]).length,1);
 assert.equal(runner()(0,[{x:280,y:400,w:19,h:30}]).length,0);
 assert.equal(runner()(0,[{x:350,y:350,w:20,h:20}]).length,1);
});
test('legacy snapshots retain transition semantics',()=>{
 assert.equal(runner({spatial_semantics:undefined})(0,[{x:350,y:350,w:20,h:20}]).length,0);
});
test('detection-only contact has single-frame proof and cannot invent dwell or groups',()=>{
 const [e]=runner({},true)(0);assert.ok(e);assert.equal(compactProof(e).ok,true);
 assert.equal(buildReviewEvidence(e).blocking,false);
 assert.equal(runner({duration_ms:1000},true)(0).length,0);
 assert.equal(runner({group:{labels:'any',minimum:3,window_ms:1000}},true)(0).length,0);
});
test('state dwell requires continuous observations; predictions cannot trigger',()=>{
 const step=runner({duration_ms:1000});assert.equal(step(0).length,0);assert.equal(step(500,undefined,true).length,0);
 assert.equal(step(1000).length,0);assert.equal(step(1500).length,0);const [e]=step(2000);assert.ok(e);
 assert.equal(compactProof(e).ok,true);assert.equal(buildReviewEvidence(e).blocking,false);
});
test('state rearm requires sustained departure, not border flicker',()=>{
 const step=runner();assert.equal(step(0).length,1);
 const far=[{x:100,y:100,w:20,h:20}];step(100,far);assert.equal(step(200).length,0);
 for(let ms=300;ms<=3300;ms+=500)step(ms,far);
 assert.equal(step(3400).length,1);
});
test('proximity uses rectangle pixel distance, including overlap; respects aspect ratio',()=>{
 const r={behavior:'region_approach',approach_px:20,approach_width_percent:2,source_binding:{stream_fingerprint:'a'.repeat(64),not_before:'2026-10-20T00:00:00Z',width:1000,height:1000,input_stream_id:'camera',geometry_revision:'g',label_map_version:'lm'}};
 assert.equal(runner(r)(0,[{x:260,y:400,w:20,h:20}]).length,1);
 assert.equal(runner(r)(0,[{x:259,y:400,w:20,h:20}]).length,0);
 assert.equal(runner(r)(0,[{x:350,y:350,w:20,h:20}]).length,1);
 assert.equal(boxRegionDistancePx(points,{x:550,y:350,w:20,h:20},2000,1000),30);
});
test('three simultaneous members trigger when the third arrives; the window only tolerates misses',()=>{
 const step=runner({group:{labels:'any',minimum:3,window_ms:1000}});
 const boxes=[0,1,2].map(i=>({x:350+i*30,y:350,w:20,h:20}));
 assert.equal(step(0,boxes.slice(0,2)).length,0);const [e]=step(500,boxes);assert.ok(e);
 assert.equal(step(1000,boxes).length,0);assert.equal(step(1500,boxes).length,0);
 assert.equal(e.group_summary.count,3);assert.equal(buildReviewEvidence(e).blocking,false);
 assert.equal(step(1600,boxes).length,0);
});
test('invalid semantics cannot be combined with traverse or directional restrictions',()=>{
 assert.throws(()=>runner({behavior:'region_traverse'})(0));
 assert.throws(()=>runner({entry_edges:[0]})(0));
});
test('legacy current-frame category witness is confirm-only and excludes temporal/directional/contradictory cases',()=>{
 const row={frame_id:'b',rule:{snapshot:{behavior:'region_enter',duration_ms:0}}};
 const proof={ok:true,samples:[{frame_id:'a'},{frame_id:'b'}]};
 const inputs=proof.samples.map(sample=>({sample,source_kind:'full_frame'}));
 const results=[{real_score:.72,class_scores:{person:.72,non_person:.02,uncertain:.26}},{real_score:.997,class_scores:{person:.997,non_person:.001,uncertain:.002}}];
 assert.deepEqual(stateConfirmation(row,proof,inputs,results).scores,[.997]);
 for(const patch of [{behavior:'region_traverse'},{duration_ms:100},{entry_edges:[0]},{group:{}},{erp_wrap:true}])assert.equal(stateConfirmation({...row,rule:{snapshot:{...row.rule.snapshot,...patch}}},proof,inputs,results),null);
 assert.equal(stateConfirmation(row,{...proof,ok:false},inputs,results),null);
 assert.equal(stateConfirmation(row,proof,inputs,[{...results[0],class_scores:{non_person:.99}},results[1]]),null);
});
