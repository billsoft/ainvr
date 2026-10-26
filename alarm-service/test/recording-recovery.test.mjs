import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {evaluate} from '../src/engine.mjs';
import {ReviewContext} from '../src/review-context.mjs';
import {AlarmRepository} from '../src/repository.mjs';
const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'核对行人',reject_below:.05,approve_above:.95};
function passage(xs,behavior='region_traverse',change=()=>{},overrides={}){
 const rule={id:'r',version:1,name:'test',channel_id:'c',state:'enabled',label_ids:['person'],labels:[{label_id:'person',name:'人'}],geometry_revision:'g',label_map_version:'l',behavior,anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy,...overrides};
 let checkpoint=null;const events=[];
 xs.forEach((x,i)=>{const n=String(i+1),pts=String((i+1)*1000000000),f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(1760918400000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-5,y:535,w:10,h:10}}]};change(f,i);const result=evaluate(checkpoint,f,[rule]);checkpoint=result.checkpoint;events.push(...result.events)});return events;
}

test('recording recovery queues only verified complete proof, preserves manual decisions and cleared alarms',{skip:!process.env.AINVR_REVIEW_TEST_MONGO_URI},async()=>{
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI);await client.connect();const db=client.db('ainvr_recovery_test_'+randomUUID().replaceAll('-',''));
 const repo=new AlarmRepository(db),context=new ReviewContext(repo,'/mnt/ainvr-ssd/test-recovery-unused');
 const jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex');
 const make=()=>{const [event]=passage([.2,.4,.5,.8]);return {...event,alarm_id:randomUUID(),occurred_at:new Date().toISOString(),ingested_at:new Date().toISOString(),handling:{state:'unacknowledged',revision:0},review:{generation:1,policy,state:'uncertain',reason:'missing_context',context_state:'incomplete'}};};
 context.image=async()=>{throw Error('missing_context')};
 try{
  const row=make();await repo.events.insertOne(row);let calls=0;
  context.recoverEvidence=async()=>{calls++;return {data:jpeg,provenance:{kind:'recording_exact_sei_v1',segment_id:'test'}}};
  await context.recoverOne();const done=await repo.events.findOne({alarm_id:row.alarm_id});assert.equal(done.review.state,'queued');assert.equal(done.review.context_state,'ready');assert.ok(calls>=2);assert.ok(done.review.frames.every(f=>f.storage==='mongodb'&&f.provenance));assert.equal(done.handling.state,'unacknowledged');
  const human=make();await repo.events.insertOne(human);context.recoverEvidence=async()=>{await repo.events.updateOne({alarm_id:human.alarm_id},{$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human'},$inc:{'handling.revision':1}});return {data:jpeg,provenance:{kind:'recording_exact_sei_v1'}}};await context.recoverOne();assert.equal((await repo.events.findOne({alarm_id:human.alarm_id})).handling.reviewed_by_kind,'human');
  const cleared=make();await repo.events.insertOne(cleared);context.recoverEvidence=async()=>{await repo.clearAll('test','clear');return {data:jpeg}};await context.recoverOne();assert.equal(await repo.events.countDocuments({}),0);assert.equal(await context.images.rows.countDocuments({}),0);
 }finally{await db.dropDatabase();await client.close();}
});
