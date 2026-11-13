import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const uri=process.env.AINVR_ALARM_TEST_MONGO_URI;
const startedAt=Date.now()-10000;
const rule={id:'region-mongo',version:1,name:'连续无人',channel_id:'ai',input_stream_id:'camera',state:'enabled',label_ids:['person'],
  geometry_revision:'g',label_map_version:'lm',behavior:'appearance',duration_ms:0,zone_id:'z',zone_version:1,points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],review:{enabled:false},
  region_state:{operator:'count_below',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'region_absence'}};
function envelope(seq,count=0){const pts=String(BigInt(seq)*1000000000n);return {schema_version:'1.0',producer_id:'region-test',offset:String(seq),frame:{schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(seq),source_pts_ns:pts,source_frame_index:String(seq),frame_id:`s:${seq}`,captured_at:new Date(startedAt+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},tracks:Array.from({length:count},(_,i)=>({track_id:`p${i}`,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:300,y:300,w:20,h:50}}))}};}
for(const v2 of [false,true])for(const crashPoint of ['prepared','behavior_inserted','event_inserted','before_checkpoint'])test(`region Mongo v${v2?2:1} recovery after ${crashPoint} retains one fact and one episode`,{skip:!uri},async()=>{
  const endpoint=new URL(uri);assert.equal(endpoint.protocol,'mongodb:');assert.ok(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname));assert.ok(endpoint.port&&endpoint.port!=='27017','isolated non-production Mongo port required');
  const {MongoClient}=await import('mongodb'),{AlarmRepository}=await import('../src/repository.mjs'),{ObservationConsumer}=await import('../src/ingestion.mjs');
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:3000});await client.connect();
  const name='ainvr_region_state_test_'+randomUUID().replaceAll('-',''),db=client.db(name);
  const triggerSeq=v2&&crashPoint==='before_checkpoint'?3:2;
  const root=await mkdtemp(fileURLToPath(new URL('./.region-state-',import.meta.url)));
  const {ReviewContext}=await import('../src/review-context.mjs'),{durableFile,frameKey}=await import('../src/evidence-spool.mjs');
  // Fixed baseline JPEG header fixture: storage/identity test, not image decoding.
  const jpeg=Buffer.from('ffd8ffc000110803e803e803012200021101031101ffd9','hex');
  const makeRepo=()=>{const repo=new AlarmRepository(db);if(v2){repo.reviewContext=new ReviewContext(repo,'/mnt/ainvr-ssd/region-test-fixture');repo.reviewContext.root=root;}return repo;};
  const input=async(seq,count=0)=>{const e=envelope(seq,count);if(v2){e.frame.evidence_delivery={schema_version:2,state:'durable'};const key=frameKey('ai','s',e.frame);await mkdir(join(root,'raw'),{recursive:true});await durableFile(join(root,'raw',key+'.jpg'),jpeg);await durableFile(join(root,'raw',key+'.json'),JSON.stringify({schema_version:2,channel_id:'ai',stream_session_id:'s',source_pts_ns:e.frame.source_pts_ns,source_frame_index:e.frame.source_frame_index,frame_width:1000,frame_height:1000,bytes:jpeg.length,sha256:createHash('sha256').update(jpeg).digest('hex')}));}return e;};
  try{
    const repo=makeRepo();await repo.initialize();await repo.reviewContext?.initialize();await repo.saveRule({...rule,region_state:{...rule.region_state,duration_ms:(triggerSeq-1)*1000}},0,'test');
    await new ObservationConsumer(repo).consume(await input(1));if(triggerSeq===3)await new ObservationConsumer(repo).consume(await input(2));let crashed=false;
    const broken=new ObservationConsumer(repo,{hook:async point=>{if(point===crashPoint&&!crashed){crashed=true;throw Error('region crash injection');}}});
    const second=await input(triggerSeq);
    await assert.rejects(()=>broken.consume(second),/region crash injection/);
    const recovered=new ObservationConsumer(makeRepo());await recovered.consume(second);
    assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),1);
    const event=await repo.events.findOne(),fact=await repo.behaviors.collection.findOne();
    assert.equal(event.event_kind,'region_absence');assert.equal(event.lifecycle.state,'active');assert.equal(event.review.state,'skipped');assert.equal(event.review.reason,'region_manual_review');
    assert.equal(fact.incident_scope,'region');assert.equal(fact.event_kind,'region_absence');
    assert.equal(fact.track_id,null);assert.equal(fact.analysis_evidence.region_state.count,0);
    assert.equal((await recovered.consume(second)).outcome,'already_consumed');
    await recovered.consume(await input(triggerSeq+1));assert.equal(await repo.events.countDocuments(),1);
    await recovered.consume(await input(triggerSeq+2,1));await recovered.consume(await input(triggerSeq+3,1));
    assert.equal((await repo.events.findOne()).lifecycle.end_reason,'condition_cleared');
    const stats=await repo.behaviors.statistics({from:envelope(1).frame.captured_at,to:envelope(triggerSeq+4).frame.captured_at});
    assert.deepEqual(stats.items,[],'region episode must not add appearance occurrences or tracked targets');
    const {_id,incident_scope,identity_kind,region_identity,event_kind,analysis_evidence,...legacy}=fact;
    await repo.behaviors.collection.insertOne({...legacy,event_id:'legacy-person',track_id:'person-1',label_id:'person',analysis_evidence:{}});
    await repo.behaviors.collection.insertOne({...legacy,event_id:'counter-only',track_id:'person-2',counter_id:'counter',analysis_evidence:{}});
    const mixed=await repo.behaviors.statistics({from:envelope(1).frame.captured_at,to:envelope(triggerSeq+4).frame.captured_at,event_type:'appearance'});
    assert.equal(mixed.items.length,1);assert.equal(mixed.items[0].occurrences,1);assert.equal(mixed.items[0].tracked_targets,1);
    if(v2){
      await repo.reviewContext.processCaptureJobs();
      const refs=event.analysis_evidence.delivery.frames;
      assert.equal(event.analysis_evidence.delivery.state,'complete');assert.deepEqual(refs.map(f=>f.frame_id),Array.from({length:triggerSeq},(_,i)=>`s:${i+1}`));
      assert.deepEqual(fact.analysis_evidence.delivery.frames,refs);assert.deepEqual(event.review.frames,refs);
      assert.equal(await repo.captureJobs.countDocuments({state:{$ne:'done'}}),0);assert.equal(await repo.captureJobs.countDocuments(),triggerSeq+1);
      for(const ref of refs){assert.equal(ref.identity_kind,'region');assert.equal(ref.track_id,undefined);assert.equal(ref.count,0);assert.deepEqual(await repo.reviewContext.images.get('context',ref.key),jpeg);}
      const {ReviewWorker}=await import('../src/review-worker.mjs'),{ReferenceReviewWorker}=await import('../src/reference-review.mjs');
      // Even a legacy/corrupt row with person authorization must never be leased.
      let calls=0;const invoke=async()=>{calls++;throw Error('region must not invoke person review');};
      const worker=new ReviewWorker(repo,{invoke,context:repo.reviewContext,readiness:async()=>true,authorization:async()=>({id:'person-authorized',focus:{},mode:'confirm_or_reject'})});
      const reference=new ReferenceReviewWorker({rows:repo.events,invoke,image:invoke,prepare:invoke});
      for(const state of ['ready','incomplete']){
        await repo.events.updateOne({alarm_id:event.alarm_id},{$set:{'review.policy.enabled':true,'review.state':'queued','review.generation':'legacy-person','review.context_state':state,'review.next_attempt_at':0}});
        assert.equal(await worker.step(),false);assert.equal(await reference.step(),false);
      }
      assert.equal(calls,0);assert.equal((await repo.events.findOne()).handling.state,'unacknowledged');
    }
    const checkpoint=await repo.checkpoints.findOne({channel_id:'ai'});assert.equal(checkpoint.checkpoint.region_states[rule.id].phase,'normal');
  }finally{assert.match(name,/^ainvr_region_state_test_[a-f0-9]{32}$/);await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
});
