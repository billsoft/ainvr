import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluate} from '../src/engine.mjs';
import {digest,validateRule} from '../src/domain.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {behaviorEvent} from '../src/behavior-events.mjs';
import {compactRegionEvidence} from '../src/region-state.mjs';
import {buildRegionReviewEvidence} from '../src/region-review-evidence.mjs';

// No Mongo client, filesystem, hardware or network. JSON boundaries model the
// durable checkpoint serialization that duplicates shared sample objects.
const clone=value=>JSON.parse(JSON.stringify(value));
const size=value=>Buffer.byteLength(JSON.stringify(value));
const softLimit=7*1024**2,hardLimit=8*1024**2;
const baseTime=Date.parse('2026-11-13T00:00:00Z');
const base={id:'region',version:1,name:'Pose region',channel_id:'ai',input_stream_id:'camera',state:'enabled',
  label_ids:['person'],geometry_revision:'g',label_map_version:'lm',behavior:'appearance',duration_ms:0,
  zone_id:'zone',zone_version:1,points:[[.01,.01],[.99,.01],[.99,.99],[.01,.99]],review:{enabled:false},
  region_state:{operator:'presence',threshold:1,duration_ms:2000,recovery_ms:2000,event_kind:'suspected_down'}};
const rules=(count=800)=>Array.from({length:count},(_,i)=>({...base,id:`region-${i}`}));
function track(i,pts){
  const dx=(i%2)*700,dy=Math.floor(i/2)*700,frac=.1234567890123,score=.91234567890123;
  const points=Array.from({length:17},()=>({x:300+dx+frac,y:300+dy+frac,score}));
  for(const [a,b,x] of [[5,6,300],[11,12,400],[13,14,500],[15,16,600]]){
    points[a]={x:x+dx+frac,y:290+dy+frac,score};points[b]={x:x+dx+frac,y:310+dy+frac,score};
  }
  return {track_id:`person-${i}`,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,
    bbox:{x:250+dx,y:250+dy,w:400,h:100},attributes:{pose:{schema_version:'1.0',type:'keypoints',status:'observed',
      layout:'coco17',coordinate_space:'original_image',image_size:[2000,2000],visibility_threshold:.5,source_model_sha256:'a'.repeat(64),points}}};
}
function envelope(n,{count=4,unknown=false,durable=false,channel='ai'}={}){
  const pts=String(BigInt(n)*1000000000n);
  return {schema_version:'1.0',producer_id:'capacity-test',offset:String(n),frame:{schema_version:'1.0',channel_id:channel,input_stream_id:'camera',
    stream_session_id:'s',seq:String(n),source_pts_ns:pts,source_frame_index:String(n),frame_id:`s:${n}`,captured_at:new Date(baseTime+n*1000).toISOString(),
    source:{width:2000,height:2000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
    tracks:Array.from({length:count},(_,i)=>track(i,pts)),region_observations:{suspected_down:{state:'valid',source_pts_ns:pts,label_ids:['person']}},
    ...(unknown?{observation_status:'unknown'}:{}),...(durable?{evidence_delivery:{schema_version:2,state:'durable'}}:{})}};
}
function memoryRepository(configured){
  const checkpoints=new Map(),facts=new Map(),alarms=new Map(),prepared=[],jobs=new Map(),coverage=[];
  const matches=(row,filter)=>Object.entries(filter).every(([key,value])=>{
    const actual=key.split('.').reduce((x,k)=>x?.[k],row);
    if(value&&typeof value==='object')return Object.entries(value).every(([operator,expected])=>operator==='$gt'?actual>expected:operator==='$lte'?actual<=expected:false);
    return actual===value;
  });
  const update=(row,patch)=>{
    Object.assign(row,clone(patch.$set??{}));
    for(const [key,value] of Object.entries(patch.$inc??{}))row[key]=(row[key]??0)+value;
    for(const key of Object.keys(patch.$unset??{}))delete row[key];
  };
  const repository={
    checkpoints:{
      updateOne:async(filter,patch,options)=>{
        let row=checkpoints.get(filter.channel_id);
        if(!row&&options?.upsert){row=clone(patch.$setOnInsert);checkpoints.set(filter.channel_id,row);}
        if(row&&matches(row,filter))update(row,patch);
      },
      findOneAndUpdate:async(filter,patch,options)=>{
        const row=checkpoints.get(filter.channel_id);if(!row||!matches(row,filter))return null;
        if(patch.$set?.pending){assert.ok(size(patch.$set.pending)<hardLimit);prepared.push(clone(patch.$set.pending));}
        if(patch.$set?.offset)assert.deepEqual(options.writeConcern,{w:1,j:true});
        update(row,patch);return clone(row);
      },
    },
    listRules:async channel=>configured.filter(rule=>rule.channel_id===channel),
    behaviors:{insert:async event=>{const fact=behaviorEvent(event);if(!facts.has(fact.event_id))facts.set(fact.event_id,clone(fact));return fact.event_id;}},
    insert:async event=>{if(!alarms.has(event.alarm_id))alarms.set(event.alarm_id,clone(event));},
    events:{updateOne:async(filter,patch)=>{const row=alarms.get(filter.alarm_id);if(row&&patch.$max)row.last_seen_at=patch.$max.last_seen_at;}},
    endEpisode:async value=>{const row=alarms.get(value.episode_id);if(row)row.lifecycle={state:'ended',end_reason:value.end_reason};},
    captureJobs:{updateOne:async(filter,patch)=>{if(!jobs.has(filter._id))jobs.set(filter._id,clone(patch.$setOnInsert));}},
    flow:{record:async value=>coverage.push(clone(value))},
  };
  return {repository,checkpoints,facts,alarms,prepared,jobs,coverage};
}

test('compaction preserves region identity/proof/latches and ignores unrelated evidence',()=>{
  const configured=rules(1),first=evaluate(null,envelope(1).frame,configured);
  const second=evaluate(first.checkpoint,envelope(2).frame,configured);
  const third=evaluate(second.checkpoint,envelope(3).frame,configured);
  const event=third.events[0],context=event.analysis_evidence.review_context;
  const checkpoint=clone(second.checkpoint),before=clone(checkpoint.region_states['region-0']);
  checkpoint.region_states['region-0'].episode_id='existing-episode';
  const unrelated={incident_scope:'target',analysis_evidence:{review_context:{samples:[{identity_kind:'target',pose_witnesses:['keep']}],integrity:'untouched'}}};
  const pending={checkpoint,events:[event,unrelated],capture_intents:second.capture_intents};
  const originalProof=clone(context.proof),originalIdentity=[event.alarm_id,event.dedup_key,event.episode_id];
  assert.equal(compactRegionEvidence(pending),true);
  const state=checkpoint.region_states['region-0'];
  assert.equal(state.episode_id,'existing-episode');assert.equal(state.phase,before.phase);
  for(const field of ['elapsed_ns','sample_count','max_interval_ms'])assert.equal(state.window[field],before.window[field]);
  assert.deepEqual(context.proof,originalProof);
  assert.deepEqual([event.alarm_id,event.dedup_key,event.episode_id],originalIdentity);
  assert.equal(context.integrity,digest({samples:context.samples,proof:context.proof}));
  assert.equal(buildRegionReviewEvidence(event).blocking,false);
  for(const sample of context.samples){assert.equal(sample.count,4);assert.deepEqual(sample.pose_witnesses,[]);assert.equal(sample.pose_witnesses_truncated,true);assert.equal(sample.members_truncated,true);assert.equal(sample.detail_omitted_reason,'region_evidence_capacity');}
  assert.deepEqual(unrelated.analysis_evidence.review_context,{samples:[{identity_kind:'target',pose_witnesses:['keep']}],integrity:'untouched'});
  assert.equal(compactRegionEvidence(pending),false);
});

test('800 valid rules formerly exceed 8 MiB; first frame commits without dropping windows or other business',async()=>{
  const configured=rules(),input=envelope(1),raw=evaluate(null,input.frame,configured);
  assert.ok(size(configured.map(validateRule))<hardLimit);
  assert.ok(input.frame.tracks.every(t=>size(t.attributes)<=2048));
  assert.ok(size(raw.checkpoint)>hardLimit,'original regression requires an oversized checkpoint');
  const ordinary={...base,id:'ordinary',channel_id:'other'};delete ordinary.region_state;
  const memory=memoryRepository([...configured,ordinary]);
  const result=await new ObservationConsumer(memory.repository).consume(input);
  assert.equal(result.durable,true);assert.ok(result.issues.includes('region_evidence_capacity'));
  assert.ok(!result.issues.includes('optional_evidence_capacity'));assert.ok(!result.issues.includes('dwell_capacity'));
  assert.ok(size(memory.prepared[0])<softLimit);assert.ok(memory.prepared[0].capture_intents.length>0);
  assert.equal(Object.keys(memory.checkpoints.get('ai').checkpoint.region_states).length,800);
  for(const state of Object.values(memory.checkpoints.get('ai').checkpoint.region_states)){
    assert.equal(state.phase,'pending');assert.equal(state.window.start.frame_id,'s:1');assert.equal(state.window.elapsed_ns,'0');
  }
  assert.equal((await new ObservationConsumer(memory.repository).consume(envelope(1,{channel:'other'}))).durable,true);
  assert.equal([...memory.alarms.values()].filter(event=>event.channel_id==='other').length,4);
  assert.equal(memory.coverage.length,2);
});

test('compacted trigger burst survives prepared replay, retains exact frames and never invents recovery',async()=>{
  const configured=rules(),memory=memoryRepository(configured);
  const jpeg=Buffer.from([255,216,1,255,217]);
  memory.repository.reviewContext={images:{},image:async(row,sample)=>({key:digest([row.channel_id,sample.frame_id]),data:jpeg,width:1280,height:1280})};
  const consumer=new ObservationConsumer(memory.repository);
  await consumer.consume(envelope(1,{durable:true}));await consumer.consume(envelope(2,{durable:true}));
  const broken=new ObservationConsumer(memory.repository,{hook:async point=>{if(point==='prepared')throw Error('audit prepared crash');}});
  await assert.rejects(()=>broken.consume(envelope(3,{durable:true})),/audit prepared crash/);
  const pending=clone(memory.checkpoints.get('ai').pending);
  assert.ok(size(pending)<softLimit);assert.equal(pending.events.length,800);
  assert.ok(pending.issues.includes('region_evidence_capacity'));
  const expected=pending.events.map(event=>event.episode_id).sort();
  const recovered=new ObservationConsumer(memory.repository);
  assert.equal((await recovered.consume(envelope(3,{durable:true}))).outcome,'already_consumed');
  assert.equal(memory.facts.size,800);assert.equal(memory.alarms.size,800);
  assert.deepEqual([...memory.alarms.keys()].sort(),expected);
  const sha=createHash('sha256').update(jpeg).digest('hex');
  for(const alarm of memory.alarms.values()){
    assert.equal(buildRegionReviewEvidence(alarm).blocking,false);
    assert.equal(alarm.analysis_evidence.delivery.state,'complete');
    assert.deepEqual(alarm.analysis_evidence.delivery.frames.map(ref=>ref.frame_id),['s:1','s:2','s:3']);
    assert.ok(alarm.analysis_evidence.delivery.frames.every(ref=>ref.content_sha256===sha&&ref.count===4));
  }
  await recovered.consume(envelope(4));assert.equal(memory.facts.size,800);
  await recovered.consume(envelope(5,{count:0}));
  await recovered.consume(envelope(6,{count:0,unknown:true}));
  for(const state of Object.values(memory.checkpoints.get('ai').checkpoint.region_states)){
    assert.equal(state.phase,'unknown');assert.ok(state.episode_id);assert.equal(state.window,null);
  }
  assert.ok([...memory.alarms.values()].every(event=>event.lifecycle.state==='active'));
  await recovered.consume(envelope(7,{count:0}));await recovered.consume(envelope(8,{count:0}));
  assert.ok([...memory.alarms.values()].every(event=>event.lifecycle.state==='active'));
  await recovered.consume(envelope(9,{count:0}));
  assert.ok([...memory.alarms.values()].every(event=>event.lifecycle.end_reason==='condition_cleared'));
  assert.equal(memory.facts.size,800);
});

test('normal-size observations retain all pose/member diagnostics',async()=>{
  const memory=memoryRepository(rules(1));
  const result=await new ObservationConsumer(memory.repository).consume(envelope(1));
  assert.ok(!result.issues.includes('region_evidence_capacity'));
  const sample=memory.checkpoints.get('ai').checkpoint.region_states['region-0'].window.start;
  assert.equal(sample.pose_witnesses.length,4);assert.equal(sample.member_track_ids.length,4);
  assert.equal(sample.detail_omitted_reason,undefined);
});
