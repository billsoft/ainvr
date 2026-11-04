import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {sharedWitness} from '../src/group-review.mjs';
const square=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
function camera(behavior,group,labels=['person']){
 const rule={id:'r',name:'group',version:1,state:'enabled',channel_id:'c',geometry_revision:'g',label_map_version:'l',behavior,group,label_ids:labels,anchor:'center',...(behavior==='appearance'?{}:{points:square}),...(behavior==='region_approach'?{approach_px:100}:{})};
 let cp,seq=0;
 const step=(ms,subjects,extra={})=>{
   seq++;
   const pts=String((ms+1)*1e6);
   const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'session',seq:String(seq),source_frame_index:String(seq),source_pts_ns:pts,frame_id:'f'+seq,captured_at:new Date(1760000000000+ms).toISOString(),source:{width:1000,height:1000,geometry_revision:'g',coordinate_space:'source_pixels'},model:{label_map_version:'l'},
     tracks:subjects.map(([id,label='person',x=.5,eligible=true])=>({track_id:id,label_id:label,observation:'detected',state:'confirmed',last_observed_pts_ns:pts,event_eligible:eligible,bbox:{x:x*1000-10,y:490,w:20,h:20}})),...extra};
   step.frame=frame;const out=evaluate(cp,frame,[rule]);cp=structuredClone(out.checkpoint);return out.events;
 };
 step.rule=rule;return step;
}
test('three people must overlap; a prediction or three sequential arrivals do not satisfy the count',()=>{
 const step=camera('appearance',{labels:'any',minimum:3,window_ms:1000});
 for(const [i,id] of ['a','b','c'].entries())assert.equal(step(i*100,[[id]]).length,0);
 const all=[['a'],['b'],['c']];
 assert.equal(step(300,[['a'],['b'],['c','person',.5,false]]).length,0);
 assert.equal(step(400,all).length,0);assert.equal(step(1399,all).length,0);
 const [alarm]=step(1400,all);assert.equal(alarm.track_ids.length,3);
 assert.equal(new Set(alarm.analysis_evidence.group.members.map(m=>m.sample.frame_id)).size,1);
 assert.equal(step(1500,all).length,0);
});
test('AND requires every category, OR counts across selected categories',()=>{
 const step=camera('appearance',{labels:'all',minimum:2,window_ms:0},['person','bag']);
 assert.equal(step(0,[['a'],['b']]).length,0);
 assert.deepEqual(step(100,[['a'],['b','bag']])[0].track_ids,['a','b']);
 const any=camera('appearance',{labels:'any',minimum:2,window_ms:0},['cat','dog']);
 assert.equal(any(0,[['a','cat'],['b','cat']]).length,1);
});
test('approach requires current outside band; entry requires witnessed ingress and continuing inside presence',()=>{
 const approach=camera('region_approach',{labels:'any',minimum:2,window_ms:0});
 assert.equal(approach(0,[['a','person',.25],['b','person',.5]]).length,0);
 assert.equal(approach(100,[['a','person',.25],['b','person',.26]]).length,1);
 const enter=camera('region_enter',{labels:'any',minimum:2,window_ms:0});
 assert.equal(enter(0,[['a','person',.1],['b','person',.5]]).length,0);
 assert.equal(enter(100,[['a'],['b']]).length,0);
 enter(200,[['a'],['b','person',.1]]);
 assert.equal(enter(300,[['a'],['b']]).length,1);
});
test('passes use distinct completed tracks within the inclusive PTS window; gaps and expiry clear candidates',()=>{
 function scenario(delta,extra={}){
  const step=camera('region_traverse',{labels:'all',minimum:2,window_ms:3000},['person','bag']);
  const pair=(x,y)=>[['a','person',x],['b','bag',y]];
  step(0,pair(.1,.1));step(1000,pair(.5,.1));assert.equal(step(2000,pair(.9,.1)).length,0);
  step(3000,pair(.9,.1),extra);step(4000,pair(.9,.5));
  return step(2000+delta,pair(.9,.9));
 }
 const [a]=scenario(3000);assert.deepEqual(a.group_members.map(m=>m.frame_id),['f3','f6']);
 assert.equal(scenario(3001).length,0);assert.equal(scenario(3000,{gap:true}).length,0);
});

test('durable group replay has one alarm, distinct crop references and independent AI member scores',{skip:!process.env.AINVR_REVIEW_TEST_MONGO_URI},async()=>{
 const {MongoClient}=await import('mongodb'),{randomUUID}=await import('node:crypto');
 const {AlarmRepository}=await import('../src/repository.mjs'),{ObservationConsumer}=await import('../src/ingestion.mjs');
 const {ReferenceReviewWorker}=await import('../src/reference-review.mjs');
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI);await client.connect();
 const db=client.db('group_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const step=camera('appearance',{labels:'all',minimum:2,window_ms:0},['person','bag']);
  Object.assign(step.rule,{labels:[{label_id:'person',name:'person'},{label_id:'bag',name:'bag'}],review:{enabled:true,profile_id:'alarm-review-zh-v1',version:1,description:'category',approve_above:.95,reject_below:.05}});
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[step.rule]},'test');step(0,[['a'],['b','bag']]);
  const consumer=new ObservationConsumer(repo);
  const envelope={schema_version:'1.0',producer_id:'p',offset:'1',frame:step.frame};
  const result=await consumer.consume(envelope);await consumer.consume(envelope);
  assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),2);
  const row=await repo.get(result.events[0]);assert.equal(row.review.state,'skipped');
  assert.deepEqual(row.behavior_event_ids,row.analysis_evidence.group.members.map(m=>m.event_id));
  const subjects=[];
  const worker=new ReferenceReviewWorker({rows:repo.events,image:async subject=>{
    subjects.push([subject.track_ids[0],subject.review.evidence_id]);return {label:subject.analysis_evidence.track.label_id,sha256:'original'};
  },prepare:async()=>({data:Buffer.from('fixture'),sha256:'fixture',key:'fixture'}),
   invoke:async()=>({schema:'ainvr.alarm_review.v1',real_score:.995,model:{package_sha256:'a'.repeat(64)}})});
  await worker.step();await worker.step();
  const final=await repo.get(row.alarm_id);
  assert.deepEqual(subjects,[['a',row.behavior_event_ids[0]],['b',row.behavior_event_ids[1]]]);
  assert.equal(final.review.group_scores.length,2);assert.equal(final.review.reference.state,'completed');
  assert.equal(final.handling.state,'unacknowledged');
 }finally{await db.dropDatabase();await client.close();}
});

test('zero traversal window requires same completion frame and burst produces no delayed duplicate',()=>{
 const step=camera('region_traverse',{labels:'any',minimum:2,window_ms:0});
 const tracks=x=>['a','b','c','d'].map(id=>[id,'person',x]);
 step(0,tracks(.1));step(100,tracks(.5));
 assert.equal(step(200,tracks(.9)).length,1);assert.equal(step(300,tracks(.9)).length,0);
});

test('group adjudication bounds, leases and operator revocation with real Mongo',{skip:!process.env.AINVR_REVIEW_TEST_MONGO_URI},async()=>{
 const {MongoClient}=await import('mongodb'),{randomUUID}=await import('node:crypto');
 const {AlarmRepository}=await import('../src/repository.mjs'),{ReferenceReviewWorker}=await import('../src/reference-review.mjs');
 const {groupDecision}=await import('../src/group-review.mjs');
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI);await client.connect();
 const db=client.db('group_decisions_'+randomUUID().replaceAll('-','')),repo=new AlarmRepository(db);
 const key='a'.repeat(64),policy={id:'policy',model_sha256:key,labels:['person'],mode:'confirm_or_reject',layout:'target-crop-v1',prompt_template:'alarm-review-zh-v1',caller_template:'target-context-zh-v3-border',approve_above:.99,secondary:{confirm_above:.99,reject_below:.01}};
 try{
  await repo.initialize();
  async function exercise(types,{positions,scene=1,sideEffect,cap,labels,grant}={}){
   let auth=grant?{...policy,id:'group-test',group_labels:grant}:policy;
   const categories=[...new Set(labels??['person'])];
   const step=camera('appearance',{labels:labels?'all':'any',minimum:labels?2:3,window_ms:0},categories);
   Object.assign(step.rule,{id:randomUUID(),labels:categories.map(name=>({label_id:name,name})),review:{enabled:true,profile_id:'alarm-review-zh-v1',version:1,description:'class',approve_above:.95,reject_below:.05}});
   const xs=positions??types.map((_,i)=>(i+1)/(types.length+1));
   const [event]=step(0,xs.map((x,i)=>['t'+i,labels?.[i]??'person',x]));
   const {group_members,...row}=event;
   const group=row.analysis_evidence.group;
   await repo.insert({...row,behavior_event_ids:group.members.map(m=>m.event_id)});
   const worker=new ReferenceReviewWorker({rows:repo.events,authorization:async()=>auth,
    context:{image:async()=>({key:'f'.repeat(64),data:Buffer.from('mock'),width:1000,height:1000})},
    invoke:async body=>{
     const target=body.preparation?.target;
     const prior=worker.current??0;
     const idx=target?xs.reduce((best,x,i)=>Math.abs(x-(target[0]+target[2])/2)<Math.abs(xs[best]-(target[0]+target[2])/2)?i:best,0):prior;
     worker.current=idx;
     const isScene=body.alarm.kind==='组合目标同时可见';
     if(isScene&&sideEffect==='human')await repo.confirm(row.alarm_id,{expected_handling_revision:0,disposition:'false_positive',note:'human'},'test','op');
     if(isScene&&sideEffect==='revoke')auth=null;
     const score=isScene?scene:['明确非人员目标','明确非指定类别'].includes(body.alarm.kind)?(types[idx]==='dark'?.6:1):types[idx]==='yes'?1:.001;
     return {schema:'ainvr.alarm_review.v1',template:policy.prompt_template,model:{package_sha256:key},real_score:score,prepared_image:{layout:policy.layout,target,jpeg_base64:'YQ=='}};
    }});
   for(let i=0;i<group.members.length;i++)await worker.step();
   const final=await repo.get(row.alarm_id);
   if(cap)assert.equal(group.candidate_count,cap);
   return final;
  }
  const positive=await exercise(['no','yes','yes','yes']);
  assert.equal(positive.handling.disposition,'handled');assert.equal(positive.review.group_scene.score,1);assert.equal(positive.review.frames.length,1);
  assert.equal((await exercise(['yes','no','no'])).handling.disposition,'false_positive');
  assert.equal((await exercise(['yes','yes','dark'])).handling.state,'unacknowledged');
  assert.equal((await exercise(['yes','yes','yes'],{positions:[.2,.2,.8]})).handling.state,'unacknowledged');
  assert.equal((await exercise(['yes','yes','yes'],{scene:.3})).handling.state,'unacknowledged');
  assert.equal((await exercise(['yes','yes','yes'],{sideEffect:'human'})).handling.reviewed_by_kind,'human');
  assert.equal((await exercise(['yes','yes','yes'],{sideEffect:'revoke'})).handling.state,'unacknowledged');
  assert.equal((await exercise(['yes','yes'],{labels:['person','backpack']})).handling.state,'unacknowledged');
  assert.equal((await exercise(['yes','yes'],{labels:['person','backpack'],grant:['person','backpack']})).handling.disposition,'handled');
  assert.equal((await exercise(['yes','no'],{labels:['person','backpack'],grant:['person','backpack']})).handling.disposition,'false_positive');
  const truncated=await exercise(Array(17).fill('no'),{cap:17});assert.equal(truncated.handling.state,'unacknowledged');
  assert.equal(groupDecision(positive,positive.review.group_scores,null),'uncertain');
 }finally{await db.dropDatabase();await client.close();}
});

test('production stage evidence is retained for each crossing, and a gap cannot certify a full negative window',()=>{
 const step=camera('region_traverse',{labels:'any',minimum:2,window_ms:3000});
 Object.assign(step.rule,{labels:[{label_id:'person',name:'person'}],review:{enabled:true,profile_id:'alarm-review-zh-v1',version:1,description:'person',approve_above:.95,reject_below:.05}});
 const tracks=x=>[['a','person',x],['b','person',x]];
 step(0,tracks(.1));step(500,tracks(.4));step(1000,tracks(.6));
 const [event]=step(1500,tracks(.9));
 assert.equal(event.analysis_evidence.group.window_complete,false);
 for(const m of event.analysis_evidence.group.members){
   assert.equal(m.stage_proven,true);
   const roles=m.transition.flatMap(s=>s.roles);
   for(const role of ['进入前','进入后','离开前','离开后'])assert.ok(roles.includes(role));
 }
});

test('one missed detection does not raise the same gathering twice, a real drop does',()=>{
 for(const win of [0,1000]){
  const step=camera('appearance',{labels:'any',minimum:3,window_ms:win});
  const all=[['a'],['b'],['c']];let alarms=0;
  for(let t=0;t<=3000;t+=100)alarms+=step(t,t===1500?[['a'],['b']]:all).length;
  assert.equal(alarms,1,'window '+win);
 }
 const step=camera('appearance',{labels:'any',minimum:3,window_ms:0});
 const all=[['a'],['b'],['c']];let alarms=0;
 for(let t=0;t<=500;t+=100)alarms+=step(t,all).length;
 for(let t=600;t<=1800;t+=100)alarms+=step(t,[['a']]).length;
 for(let t=1900;t<=2300;t+=100)alarms+=step(t,all).length;
 assert.equal(alarms,2,'a gathering that really dispersed may alarm again');
});
test('a target that legitimately entered rejoins the count after one missed detection',()=>{
 const run=drop=>{const d=camera('region_enter',{labels:'any',minimum:2,window_ms:0});const out=[];
  out.push(d(0,[['a','person',.1],['b','person',.1]]).length);out.push(d(100,[['a'],['b','person',.1]]).length);
  out.push(d(200,drop?[['b','person',.1]]:[['a'],['b','person',.1]]).length);out.push(d(300,[['a'],['b']]).length);return out;};
 assert.deepEqual(run(false),[0,0,0,1]);
 assert.deepEqual(run(true),[0,0,0,1]);
});
test('sharedWitness: different categories may overlap, same-category duplicates are one object',()=>{
 const mem=(track,label,bbox)=>{const s={frame_id:'f1',source_pts_ns:'1',source_frame_index:'1',track_id:track,label_id:label,bbox,observation:'detected',event_eligible:true};return {sample:s,transition:[],start:s,identity_sample:s,name:label};};
 const and={group:{minimum:2,labels:'all'},label_ids:['person','bag']};
 assert.ok(sharedWitness([mem('a','person',{x:100,y:100,w:100,h:300}),mem('b','bag',{x:120,y:250,w:50,h:60})],and));
 const any={group:{minimum:3,labels:'any'},label_ids:['person']};
 assert.ok(sharedWitness([mem('a','person',{x:100,y:100,w:100,h:300}),mem('b','person',{x:190,y:100,w:100,h:300}),mem('c','person',{x:400,y:100,w:100,h:300})],any),'a huddle with touching boxes');
 assert.equal(sharedWitness([mem('a','person',{x:100,y:100,w:100,h:300}),mem('b','person',{x:105,y:100,w:100,h:300}),mem('c','person',{x:400,y:100,w:100,h:300})],any),null,'two boxes on one body count once');
});

test('a crowd above the state bound keeps its clock and still alarms; the candidate list is marked incomplete',()=>{
 for(const crowd of [3,256,257,400]){
  const step=camera('appearance',{labels:'any',minimum:3,window_ms:1000});
  const people=Array.from({length:crowd},(_,i)=>['p'+String(i).padStart(4,'0')]);
  const alarms=[];
  for(let ms=0;ms<=2000;ms+=500)for(const a of step(ms,people))alarms.push([ms,a]);
  assert.equal(alarms.length,1,'crowd '+crowd);assert.equal(alarms[0][0],1000);
  assert.equal(alarms[0][1].analysis_evidence.group.candidates_truncated,crowd>256,'crowd '+crowd);
 }
});

test('staggered arrivals alarm only once every member has been present for the whole window',()=>{
 const step=camera('appearance',{labels:'any',minimum:3,window_ms:1000});
 const fired=[];
 for(let ms=0;ms<=2200;ms+=100){
  const present=[['a']];if(ms>=500)present.push(['b']);if(ms>=900)present.push(['c']);
  if(step(ms,present).length)fired.push(ms);
 }
 assert.deepEqual(fired,[1900],'A at 0, B at 0.5 s, C at 0.9 s: all three have been together for the last full second only at 1.9 s');
});
test('AND keeps the only bag among 256 people for simultaneous and completed-pass windows',()=>{
 for(const behavior of ['appearance','region_traverse']){
  const step=camera(behavior,{labels:'all',minimum:2,window_ms:1000},['person','bag']);
  const tracks=x=>[...Array.from({length:256},(_,i)=>['p'+i,'person',x]),['zbag','bag',x]];
  const alarms=[];
  for(const [ms,x] of [[0,.1],[500,.5],[1000,.9],[1500,.9]]){
   for(const event of step(ms,tracks(x)))alarms.push({ms,group:event.analysis_evidence.group});
  }
  assert.equal(alarms.length,1,behavior);
  assert.equal(alarms[0].ms,1000);
  assert.ok(alarms[0].group.members.some(m=>m.sample.track_id==='zbag'));
  assert.equal(alarms[0].group.candidates_truncated,true);
 }
});
