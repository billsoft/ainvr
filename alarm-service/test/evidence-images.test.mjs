import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {EvidenceImages} from '../src/evidence-images.mjs';
import {EvidenceVault} from '../src/evidence-vault.mjs';
import {ReviewContext,contextKey} from '../src/review-context.mjs';
import {AlarmRepository} from '../src/repository.mjs';
const jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex');
const enabled=process.env.AINVR_ALARM_TEST_MONGO==='1';
async function fixture(fn){
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_blob_test_'+randomUUID().replaceAll('-',''));
 const root=await mkdtemp('/mnt/ainvr-ssd/evidence-mongo-test-');
 try{await fn(db,root);}finally{await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
}
test('Mongo JPEG storage: bytes, hash, idempotency, capacity, expiry, corruption and clearing',{skip:!enabled},()=>fixture(async db=>{
 let now=Date.now();const images=new EvidenceImages(db,{clock:()=>now});await images.initialize();
 const policy={maxBytes:jpeg.length*2,retentionMs:10000};
 await images.put('context','a',jpeg,policy);await images.put('context','a',jpeg,policy);
 assert.equal(await images.rows.countDocuments({}),1);assert.deepEqual(await images.get('context','a'),jpeg);
 await assert.rejects(images.put('context','a',Buffer.from([255,216,0,255,217]),policy),/identity_conflict/);
 now++;await images.put('context','b',jpeg,policy);now++;await images.put('context','c',jpeg,policy);
 assert.equal(await images.get('context','a'),null);assert.equal(await images.bytes('context'),jpeg.length*2);
 await images.rows.updateOne({_id:'context:c'},{$set:{data:Buffer.from([0])}});
 await assert.rejects(images.get('context','c'),/integrity/);
 now+=10001;assert.equal(await images.get('context','b'),null);await images.prune('context',0,10000);assert.equal(await images.rows.countDocuments({}),0);
 await db.collection('alarm_history_clear').insertOne({_id:'state',cutoff:new Date(now).toISOString()});
 await assert.rejects(images.put('context','old',jpeg,{...policy,occurredAt:new Date(now-1).toISOString()}),/cleared/);
}));
test('review candidates promote to Mongo; prepared images and legacy migration keep exact hashes',{skip:!enabled},()=>fixture(async(db,root)=>{
 const repo=new AlarmRepository(db),context=new ReviewContext(repo,root);await context.initialize();
 const sample={frame_id:'f',source_pts_ns:'1',source_frame_index:'1'},row={alarm_id:'a',occurred_at:new Date().toISOString(),channel_id:'c',stream_session_id:'s',analysis_evidence:{source:{width:20,height:10}},review:{generation:1}};
 const key=contextKey(row,sample);await writeFile(root+'/candidates/'+key+'.jpg',jpeg);
 await repo.events.insertOne(row);
 assert.deepEqual((await context.image(row,sample,true)).data,jpeg);
 assert.deepEqual((await context.image(row,sample)).data,jpeg);
 assert.equal((await readdir(root+'/pinned')).length,0);
 await context.images.remove('candidate',key);assert.deepEqual(await context.images.get('context',key),jpeg);
 const saved=await context.savePrepared(row,sample,{layout:'target-crop-v1',jpeg_base64:jpeg.toString('base64'),width:20,height:10});
 assert.equal(saved.storage,'mongodb');assert.deepEqual(await context.retained('a',saved.key),jpeg);
 await context.images.remove('context',saved.key);
 await writeFile(root+'/pinned/'+saved.key+'.jpg',jpeg);
 await assert.rejects(context.retained('a',saved.key),/missing_context/); // no resurrection from old files
 const legacyKey='d'.repeat(64);await writeFile(root+'/pinned/'+legacyKey+'.jpg',jpeg);
 await repo.events.updateOne({alarm_id:'a'},{$set:{'review.frames':[{key:legacyKey,content_sha256:createHash('sha256').update(jpeg).digest('hex')}]}});
 assert.deepEqual(await context.retained('a',legacyKey),jpeg);
 assert.equal((await repo.events.findOne({alarm_id:'a'})).review.frames[0].storage,'mongodb');
 await repo.clearAll('test','clear-1');assert.equal(await context.images.rows.countDocuments({}),0);
}));
test('new crop evidence uses Mongo and survives restart without JPEG files',{skip:!enabled},()=>fixture(async(db,root)=>{
 const id='a'.repeat(64),now=new Date().toISOString();
 const fact={event_id:id,occurred_at:now,channel_id:'c',stream_session_id:'s',track_id:'t',label_id:'person',source_pts_ns:'1',source_frame_index:'1',analysis_evidence:{source_frame_index:'1',source:{width:20,height:10}}};
 await db.collection('behavior_events').insertOne(fact);
 const options={root,policy:{enabled:true,retention_days:1,max_bytes:1024*1024},images:new EvidenceImages(db),source:{metadata:async()=>({state:'available',evidence:{kind:'target_crop',image_id:'img',channel_id:'c',stream_session_id:'s',track_id:'t',label_id:'person',source_pts_ns:'1',source_frame_index:'1',frame_width:20,frame_height:10,image_width:20,image_height:10,variants:['processed','original']}}),image:async()=>jpeg}};
 const vault=new EvidenceVault(db,options);
 try{await vault.initialize();await vault.enqueue(id,fact);await vault.tick();assert.deepEqual(await vault.image(id,'original'),jpeg);assert.equal((await vault.metadata(id)).state,'available');assert.equal((await readdir(root)).filter(n=>n.endsWith('.jpg')).length,0);}
 finally{await vault.close();}
 const restarted=new EvidenceVault(db,options);try{await restarted.initialize();assert.deepEqual(await restarted.image(id,'processed'),jpeg);await restarted.retire(await restarted.rows.findOne({_id:id}),'test');assert.equal(await options.images.rows.countDocuments({}),0);}finally{await restarted.close();}
}));

test('clear racing with a pending image insert cannot resurrect evidence',{skip:!enabled},()=>fixture(async db=>{
 const images=new EvidenceImages(db);await images.initialize();
 const insert=images.rows.updateOne.bind(images.rows);
 images.rows.updateOne=async(...args)=>{
  await db.collection('alarm_history_clear').insertOne({_id:'state',cutoff:new Date(Date.now()+1000).toISOString()});
  return insert(...args);
 };
 await assert.rejects(images.put('context','racing',jpeg,{maxBytes:10000,retentionMs:10000}),/cleared/);
 assert.equal(await images.rows.countDocuments({}),0);
}));