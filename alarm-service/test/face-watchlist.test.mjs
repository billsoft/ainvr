import test from 'node:test';
import assert from 'node:assert/strict';
import {candidate,acknowledged} from './face-watchlist-fixture.mjs';
import {makeFaceWatchlistAlarm,validateFaceCandidate} from '../src/face-watchlist-candidate.mjs';
import {FaceWatchlistWorker} from '../src/face-watchlist-worker.mjs';
import {reviewFor} from '../src/review-worker.mjs';
import {ConfigCenterController} from '../src/config-center.mjs';

function repository(){
 const rows=new Map();let insertError=null,cleared=false;
 return {rows,setError:e=>{insertError=e;},setCleared:()=>{cleared=true;rows.clear();},
  insert:async(event,options)=>{assert.deepEqual(options,{durable:true});if(insertError)throw insertError;if(cleared)return false;const fresh=!rows.has(event.alarm_id);if(fresh)rows.set(event.alarm_id,structuredClone(event));return fresh;},
  events:{findOne:async q=>rows.get(q.alarm_id)},isCleared:async()=>cleared};
}
test('candidate keeps original reference and rule snapshot, never creates a fake track/bbox or automatic review',()=>{
 const c=candidate(),e=makeFaceWatchlistAlarm(c);
 assert.match(e.alarm_id,/^[a-f0-9]{64}$/);assert.equal(e.dedup_key,e.alarm_id);assert.equal(e.event_kind,'face_watchlist');
 assert.deepEqual(e.analysis_evidence.face,c);assert.equal(e.rule.snapshot.library_version,7);assert.equal(e.rule.name,c.library_name);
 assert.equal(e.channel_id,c.processor_id);assert.equal(e.input_stream_id,null);assert.equal(e.analysis_evidence.source_frame_index,'1');
 assert.equal(e.analysis_evidence.track,undefined);assert.equal(e.analysis_evidence.source,undefined);assert.equal(e.episode_id,undefined);
 assert.equal(e.evidence.refs[0].photo_ref,c.photo_ref);assert.equal(e.handling.state,'unacknowledged');
 assert.equal(reviewFor({...e,rule:{...e.rule,snapshot:{...e.rule.snapshot,review:{enabled:true}}}}).reason,'face_watchlist_manual_review');
 for(const marker of [{event_kind:'face_watchlist'},{analysis_evidence:{face:c}},{rule:{snapshot:{event_kind:'face_watchlist',review:{enabled:true}}}}])assert.equal(reviewFor(marker).policy.enabled,false);
 assert.deepEqual(makeFaceWatchlistAlarm(candidate({track_id:''})).track_ids,[]);
});
test('strict candidate boundary rejects embeddings, URLs, ambiguous IDs, false assertions and unsupported values',()=>{
 for(const patch of [{vector:[1]},{embedding:[1]},{url:'http://invalid'},{accuracy_verified:true},{review_required:false},{event_kind:'spatial'},
  {photo_ref:'55555555-5555-4555-a555-555555555555'},{similarity:.8},{similarity:NaN},{threshold:2},{library_version:0},
  {space_id:'unknown'},{model:'other'},{occurred_at:'yesterday'},{source_pts_ns:'-1'},{processor_id:undefined},{processor_id:''},{processor_id:'\nsecret'},{library_name:'x'.repeat(257)}])
  assert.throws(()=>validateFaceCandidate(candidate(patch)),/invalid_face_candidate/);
 const c=candidate();assert.throws(()=>validateFaceCandidate({...c,event_id:'b'.repeat(64)}),/invalid_face_candidate/);
 assert.doesNotThrow(()=>validateFaceCandidate(candidate({threshold:-.5,similarity:-.2})));
});
test('ACK loss retries exactly one stored alarm and preserves first-frame evidence and human handling',async()=>{
 const repo=repository();let current=candidate(),attempt=0;
 const worker=new FaceWatchlistWorker(repo,{transport:{poll:async()=>({items:[current]}),ack:async c=>{assert.equal(repo.rows.size,1);if(++attempt===1)throw Error('connection lost');return acknowledged(c);}}});
 await worker.tick();assert.equal(worker.status().acknowledged,0);assert.equal(repo.rows.size,1);
 const stored=[...repo.rows.values()][0];stored.handling={state:'acknowledged',disposition:'false_positive',reviewed_by_kind:'human'};
 const original=structuredClone(stored);
 current=candidate({frame_id:'session:2',source_pts_ns:'2000000000',source_frame_index:'2',record_id:'55555555-5555-4555-a555-555555555555',photo_ref:'55555555-5555-4555-a555-555555555555',member_name:'后续姓名'});
 await worker.tick();assert.equal(worker.status().acknowledged,1);assert.deepEqual([...repo.rows.values()][0],original);
 assert.equal(attempt,2);await worker.close();
});
test('failed persistence never ACKs; invalid item does not block valid peers in the bounded batch',async()=>{
 const repo=repository();let acks=0;const transport={poll:async()=>({items:[{vector:[1]},candidate()]}),ack:async c=>{acks++;return acknowledged(c);}};
 const worker=new FaceWatchlistWorker(repo,{transport});repo.setError(Error('database offline'));
 await worker.tick();assert.equal(acks,0);repo.setError(null);await worker.tick();assert.equal(acks,1);
 assert.equal(worker.status().invalid,2);assert.equal(repo.rows.size,1);await worker.close();
});
test('bounds batches, observes work budget, deduplicates concurrent tick and aborts shutdown',async()=>{
 const repo=repository();let release,polls=0,acks=0,now=1000;
 const worker=new FaceWatchlistWorker(repo,{clock:()=>now,workBudgetMs:1000,transport:{
  poll:async()=>{polls++;return new Promise(resolve=>{release=resolve;});},ack:async c=>{acks++;now+=1000;return acknowledged(c);}}});
 const a=worker.tick(),b=worker.tick();assert.equal(a,b);assert.equal(polls,1);
 release({items:[candidate(),candidate({track_id:'other'})]});await a;assert.equal(acks,1);await worker.close();assert.equal(await worker.tick(),false);
 const oversized=new FaceWatchlistWorker(repository(),{batchLimit:1,transport:{poll:async()=>({items:[candidate(),candidate()]}),ack:async()=>{throw Error('should not ACK');}}});
 await oversized.tick();assert.equal(oversized.status().persisted,0);await oversized.close();
 let signal;
 const pending=new FaceWatchlistWorker(repository(),{transport:{poll:async(_n,s)=>{signal=s;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}}});
 pending.run();await pending.close();assert.equal(signal.aborted,true);assert.equal(pending.status().state,'stopped');
 for(const options of [{batchLimit:51},{intervalMs:1},{workBudgetMs:60001}])assert.throws(()=>new FaceWatchlistWorker(repo,options));
});
test('clear-history policy ACKs a suppressed replay without resurrecting the alarm',async()=>{
 const repo=repository();repo.setCleared();let acks=0;
 const worker=new FaceWatchlistWorker(repo,{transport:{poll:async()=>({items:[candidate()]}),ack:async c=>{acks++;return acknowledged(c);}}});
 await worker.tick();assert.equal(acks,1);assert.equal(repo.rows.size,0);await worker.close();
});
test('configuration restart and rollback preserve face transport and close the previous instance',async()=>{
 const faceOutbox={poll:async()=>({items:[]})};let version=1;const starts=[],closed=[];
 const settings={host:'127.0.0.1',port:8200,mongo_uri:'mongodb://127.0.0.1:27932',database:'face_test',api_token:'a'.repeat(40),producer_token:'b'.repeat(40)};
 const controller=new ConfigCenterController({faceOutbox,request:async(path,body)=>body??(path.includes('snapshot')?[{service:'alarm-service',group:'system',name:'settings',config:settings}]:{desiredVersion:version}),
  start:async(config,deps)=>{assert.equal(deps.faceOutbox,faceOutbox);starts.push(config.version);if(config.version===2)throw Error('failed start');return {close:async()=>closed.push(config.version)};}});
 await controller.tick();version=2;await controller.tick();await controller.close();assert.deepEqual(starts,[1,2,1]);assert.deepEqual(closed,[1,1]);
});
