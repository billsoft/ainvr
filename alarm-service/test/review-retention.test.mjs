import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {ReviewContext,contextKey} from '../src/review-context.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';

test('candidate quota cannot evict promoted alarm evidence',async()=>{
 const root=await mkdtemp('/mnt/ainvr-ssd/review-retention-test-');
 try{
  const context=new ReviewContext({},root);await context.initialize();
  const sample={source_pts_ns:'1',source_frame_index:'1'},row={channel_id:'c',stream_session_id:'s',analysis_evidence:{source:{width:20,height:10}}};
  const key=contextKey(row,sample),jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex');
  await writeFile(root+'/candidates/'+key+'.jpg',jpeg);
  await assert.rejects(stat(root+'/pinned/'+key+'.jpg'));
  await context.image(row,sample);
  await context.prunePool('candidates',0,86400000);
  await assert.rejects(stat(root+'/candidates/'+key+'.jpg'));
  assert.deepEqual(await readFile(root+'/pinned/'+key+'.jpg'),jpeg);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unvalidated reference selection is generation and prompt bounded, newest first',async()=>{
 let queried=0;
 const worker=new ReviewWorker({events:{findOneAndUpdate:async(filter,update,options)=>{
  assert.equal(filter['review.policy.enabled'],true);
  assert.equal(filter['review.context_state'],'ready');
  assert.equal(filter['handling.state'],'unacknowledged');
  assert.ok(filter.$expr.$or.some(clause=>JSON.stringify(clause).includes('$review.reference.generation')));
  assert.ok(filter.$expr.$or.some(clause=>JSON.stringify(clause).includes('$review.reference.prompt_version')));
  assert.deepEqual(options.sort,{occurred_at:-1,alarm_id:-1});queried++;return null;
 }}},{readiness:async()=>false,authorization:async()=>null,invoke:()=>assert.fail('no eligible record must not infer')});
 assert.equal(await worker.step(),false);assert.equal(queried,1);
});

test('changed pinned evidence cannot be submitted to the model',async()=>{
 const root=await mkdtemp('/mnt/ainvr-ssd/review-integrity-test-');
 try{
  const context=new ReviewContext({},root);await context.initialize();
  const sample={source_pts_ns:'1',source_frame_index:'1'},row={channel_id:'c',stream_session_id:'s',analysis_evidence:{source:{width:20,height:10}}};
  const key=contextKey(row,sample),jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex');
  await writeFile(root+'/pinned/'+key+'.jpg',jpeg);
  row.review={frames:[{key,content_sha256:createHash('sha256').update(jpeg).digest('hex')}]};
  assert.deepEqual((await context.image(row,sample)).data,jpeg);
  await writeFile(root+'/pinned/'+key+'.jpg',Buffer.concat([jpeg,Buffer.from('changed')]));
  await assert.rejects(context.image(row,sample),/evidence_integrity_mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
