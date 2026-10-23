import test from 'node:test';
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
test('unvalidated profile waits without claiming an attempt or invoking the model',async()=>{
 let updated=0;
 const worker=new ReviewWorker({events:{updateMany:async(filter,update)=>{assert.equal(filter.$or[0]['review.state'],'queued');assert.equal(update.$set['review.state'],'waiting_validation');updated++;},findOneAndUpdate:()=>assert.fail('must not claim')}},{readiness:async()=>false,invoke:()=>assert.fail('must not infer')});
 assert.equal(await worker.step(),false);assert.equal(updated,1);
});
