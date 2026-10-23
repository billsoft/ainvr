import {digest} from '../src/domain.mjs';
import {beginEvidence} from '../src/compact-evidence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {reviewSamples,contextKey,ReviewContext} from '../src/review-context.mjs';
import {classify,reviewFor,reviewDescription} from '../src/review-worker.mjs';
const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'核对行人',reject_below:.05,approve_above:.95};
function passage(xs,behavior='region_traverse',change=()=>{},overrides={}){
 const rule={id:'r',version:1,name:'test',channel_id:'c',state:'enabled',label_ids:['person'],labels:[{label_id:'person',name:'人'}],geometry_revision:'g',label_map_version:'l',behavior,anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy,...overrides};
 let checkpoint=null;const events=[];
 xs.forEach((x,i)=>{const n=String(i+1),pts=String((i+1)*1000000000),f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(1760918400000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-5,y:535,w:10,h:10}}]};change(f,i);const result=evaluate(checkpoint,f,[rule]);checkpoint=result.checkpoint;events.push(...result.events)});return events;
}
test('compact review preserves real traversal and selects exact before/inside/exit frames',()=>{
 const [event]=passage([.2,.4,.5,.6,.8]);const proof=reviewSamples(event);
 assert.equal(proof.ok,true);assert.deepEqual(proof.samples.map(s=>s.frame_id),['1','2','4','5']);
 assert.equal(contextKey(event,proof.samples[0]).length,64);
 assert.notEqual(contextKey(event,proof.samples[0]),contextKey({...event,stream_session_id:'new'},proof.samples[0]));
});
test('later passage does not reuse the first passage evidence',()=>{
 const events=passage([.2,.4,.6,.8,.6,.4,.2]);assert.equal(events.length,2);
 const proof=reviewSamples(events[1]);assert.equal(proof.ok,true);assert.deepEqual(proof.samples.map(s=>s.frame_id),['4','5','6','7']);
});
test('missing geometry, predictions and tampered exit never become automatic rejection',()=>{
 const [event]=passage([.2,.4,.5,.8]);
 for(const change of [e=>e.analysis_evidence.review_context.truncated=true,e=>e.analysis_evidence.review_context.trace[1].event_eligible=false,e=>e.analysis_evidence.traversal.exit.frame_id='wrong',e=>e.rule.snapshot.erp_wrap=true]){
  const row=structuredClone(event);change(row);assert.equal(reviewSamples(row).ok,false);
 }
});
test('appearance can be visually reviewed without inventing a crossing',()=>{
 const [event]=passage([.4],'appearance');assert.equal(reviewSamples(event).ok,true);
 assert.equal(reviewSamples({...event,analysis_evidence:{}}).ok,false);
});
test('scores have uncertain middle, invalid scores rejected and policy immutable',()=>{
 assert.equal(classify(.04,policy),'not_supported');assert.equal(classify(.5,policy),'uncertain');assert.equal(classify(.99,policy),'supported');
 for(const score of [NaN,Infinity,-1,2])assert.throws(()=>classify(score,policy));
 const [event]=passage([.2,.4,.8]);const job=reviewFor(event);event.rule.snapshot.review.description='changed';assert.equal(job.policy.description,'核对行人');
 assert.equal(reviewFor({...event,rule:{snapshot:{review:{enabled:false}}}}).state,'skipped');
});


test('long outside wait does not poison a later complete crossing review',()=>{
 const events=passage([...Array(150).fill(.2),.4,.5,.8]);
 assert.equal(events.length,1);const proof=reviewSamples(events[0]);assert.equal(proof.ok,true);
 assert.deepEqual(proof.samples.map(s=>s.frame_id),['150','151','152','153']);
});
test('long interior dwell retains bounded transition evidence',()=>{
 const [event]=passage([.2,.4,...Array(150).fill(.5),.8]);
 assert.equal(reviewSamples(event).ok,true);assert.ok(JSON.stringify(event.analysis_evidence.review_context).length<8000);
});

test('all four review proofs use production dwell, zone and direction semantics',()=>{
 for(const [behavior,xs,overrides] of [
  ['appearance',[.4,.4,.4],{duration_ms:2000}],
  ['region_approach',[.1,.25,.25,.25],{approach_px:120,duration_ms:2000}],
  ['region_enter',[.2,.4,.5,.6],{duration_ms:2000}],
  ['region_traverse',[.2,.4,.5,.8],{}]]){
  const [event]=passage(xs,behavior,()=>{},overrides);assert.ok(event,behavior);
  assert.equal(reviewSamples(event).ok,true,behavior);
  const altered=structuredClone(event);altered.rule.snapshot.duration_ms=60000;
  assert.equal(reviewSamples(altered).ok,false,behavior+' must not ignore duration');
  if(behavior!=='appearance'){
   const wrong=structuredClone(event);wrong.rule.snapshot.entry_edges=[0];
   assert.equal(reviewSamples(wrong).ok,false,behavior+' must honor direction');
  }
 }
});
test('model prompt identifies one target without coordinates or trajectory JSON',()=>{
 const [event]=passage([.2,.4,.5,.8]);event.review={policy};
 const {label,description}=reviewDescription(event);
 assert.equal(label,'人');assert.ok(description.includes('不要用其他目标代替'));assert.ok(!description.includes('trajectory_summary'));assert.ok(Buffer.byteLength(description)<1024);
});
test('counting and alarms share exact traversal geometry under identical continuity policy',()=>{
 const a=passage([.2,.4,.5,.8])[0];
 const b=passage([.2,.4,.5,.8],'region_traverse',()=>{},{alarm_enabled:false,review:{enabled:false},passage:{kind:'zone',max_gap_ms:0}})[0];
 assert.deepEqual(a.analysis_evidence.traversal,b.analysis_evidence.traversal);
});

test('capture jobs replace checkpoint scans and missing captures retry',async()=>{
 const jobs=[{_id:'a',channel_id:'c',stream_session_id:'s',source:{width:100,height:100},sample:{frame_id:'f',source_pts_ns:'1',source_frame_index:'1'},created_at:Date.now()}];const updates=[];
 const repo={captureJobs:{find:()=>({sort:()=>({limit:()=>({toArray:async()=>jobs})})}),updateOne:async(...a)=>updates.push(a)}};
 const context=new ReviewContext(repo,'/mnt/ainvr-ssd/unit-test-no-writes');context.image=async()=>{throw Error('pending')};
 await context.processCaptureJobs();assert.equal(updates[0][1].$set.state,'queued');
});

test('appearance replay preserves the actual prediction, never invents a predicted box',()=>{
 const alter=(f,i)=>{if(i===1){const t=f.tracks[0];t.observation='predicted';t.last_observed_pts_ns='1000000000';t.predicted_bbox={...t.bbox};}};
 const [event]=passage([.4,.4,.4],'appearance',alter,{duration_ms:2000});
 assert.equal(reviewSamples(event).ok,true);
 const missing=structuredClone(event);missing.analysis_evidence.review_context.trace[0].bbox.x+=1;
 assert.equal(reviewSamples(missing).ok,false);
});


test('missing transition roles stay manual even when remaining samples are valid',()=>{
 const [event]=passage([.2,.4,.5,.8]);
 const c=event.analysis_evidence.review_context;
 c.samples=c.samples.filter(s=>!s.roles.includes('进入前'));c.trace=c.samples;
 c.integrity=digest({samples:c.samples,proof:c.proof});
 assert.deepEqual(reviewSamples(event),{ok:false,reason:'missing_keyframe',samples:[]});
});
test('a new candidate recovers after optional evidence budget exhaustion',()=>{
 const s={review_unavailable:true,review_compact:{last:{frame_id:'before'}}};
 beginEvidence(s,{frame_id:'new'});assert.equal(s.review_unavailable,undefined);
 assert.equal(s.review_compact.before.frame_id,'before');
});
test('first observed inside approach band still alarms but lacks before-frame proof',()=>{
 const [event]=passage([.25,.25,.25],'region_approach',()=>{},{approach_px:120,duration_ms:1000});
 assert.ok(event);assert.equal(reviewSamples(event).reason,'missing_keyframe');
});

test('entry candidate restart after boundary jitter retains genuinely outside frame',()=>{
 const [event]=passage([.2,.4,.301,.4,.5,.6],'region_enter',()=>{},{duration_ms:2000,hysteresis:.01});
 assert.ok(event);const before=reviewSamples(event).samples.find(s=>s.roles.includes('进入前'));
 assert.equal(event.direction.entry_edge,3);assert.equal(before.frame_id,'1');assert.ok(before.bbox.x<.3*1920);
});
test('approach outer tolerance pauses dwell without resetting or counting uncertain time',()=>{
 const events=passage([.1,.25,.235,.25,.25,.25],'region_approach',()=>{},{approach_px:120,duration_ms:2000,hysteresis:.01});
 assert.equal(events.length,1);assert.equal(events[0].frame_id,'6');
 assert.equal(reviewSamples(events[0]).samples.find(s=>s.roles.includes('进入接近带后')).frame_id,'2');
});
