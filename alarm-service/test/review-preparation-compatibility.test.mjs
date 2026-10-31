import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ReviewContext,jpegDimensions} from '../src/review-context.mjs';
const jpeg=(width=64,height=64)=>{
 const data=Buffer.from('ffd8ffc00011080040004003012200021101031101ffd9','hex');
 data.writeUInt16BE(height,7);data.writeUInt16BE(width,9);return data;
};
const hash=data=>createHash('sha256').update(data).digest('hex');
const id='a'.repeat(64);
function fixture(){
 const sample={frame_id:'f',seq:'1',source_pts_ns:'1',source_frame_index:'1',track_id:'t',label_id:'person',bbox:{x:10,y:20,w:64,h:64}};
 const data=jpeg(),key=hash(data);
 const row={channel_id:'c',stream_session_id:'s',frame_id:'f',source_pts_ns:'1',track_ids:['t'],behavior_event_ids:[id],
  rule:{snapshot:{labels:[{label_id:'person',name:'person'}]}},
  analysis_evidence:{source:{width:1920,height:1080},source_frame_index:'1',track:{label_id:'person'}},
  review:{evidence_id:id,frames:[{...sample,bbox:{...sample.bbox},key,content_sha256:key,storage:'mongodb',source_kind:'retained_target',width:64,height:64,crop_event_id:id}]}};
 let vaultCalls=0;
 const context=new ReviewContext({evidenceVault:{metadata:async()=>{vaultCalls++;return {state:'expired'}}}},'/mnt/ainvr-ssd/unused-compatibility-test');
 context.images={get:async()=>data};
 const proof={ok:true,samples:[sample]};
 return {context,row,sample,data,proof,vaultCalls:()=>vaultCalls};
}
test('full-frame cache rejects incompatible aspect geometry',async()=>{
 const f=fixture();f.row.review.frames=[];
 await assert.rejects(f.context.image(f.row,f.sample),/evidence_identity_mismatch/);
 f.context.images.get=async()=>jpeg(1920,1080);
 assert.equal((await f.context.image(f.row,f.sample)).width,1920);
 await assert.rejects(f.context.image({...f.row,analysis_evidence:{source:{width:1920,height:720}}},f.sample),/evidence_identity_mismatch/);
});
test('pinned exact trigger crop survives vault expiry and retains limited evidence semantics',async()=>{
 const f=fixture();f.context.image=async()=>{throw Error('missing_context')};
 const plan=await f.context.prepareInputs(f.row,f.proof);
 assert.equal(plan.confirm_only,true);assert.equal(plan.items[0].source_kind,'retained_target');
 assert.equal(plan.items[0].data,f.data);assert.equal(f.vaultCalls(),0);
 let written;
 f.context.images.put=async()=>{};f.context.repository.events={updateOne:async(_,patch)=>{written=patch.$set}};
 await f.context.ready(f.row,{},plan);
 assert.equal(written['review.frames'][0].width,64);
});
test('pinned identity, hash and dimensions fail closed without vault fallback',async()=>{
 for(const mutate of [r=>r.seq='2',r=>r.source_pts_ns='2',r=>r.source_frame_index='2',r=>r.track_id='other',r=>r.label_id='other',r=>r.frame_id='other',r=>r.crop_event_id='b'.repeat(64),r=>r.content_sha256='b'.repeat(64),r=>r.width=128,r=>delete r.seq,r=>delete r.bbox,...['x','y','w','h'].map(k=>r=>{r.bbox[k]+=1})]){
  const f=fixture();mutate(f.row.review.frames[0]);
  await assert.rejects(f.context.retainedInput(f.row,f.proof),/evidence_(identity|integrity)_mismatch/);
  assert.equal(f.vaultCalls(),0);
 }
 const f=fixture();f.context.images.get=async()=>jpeg(65,64);
 await assert.rejects(f.context.retainedInput(f.row,f.proof),/evidence_integrity_mismatch/);
 assert.equal(f.vaultCalls(),0);
});
test('absent pinned bytes fall back to exact-frame vault, storage errors do not',async()=>{
 const f=fixture();f.context.images.get=async()=>null;
 await assert.rejects(f.context.retainedInput(f.row,f.proof),/missing_context/);assert.equal(f.vaultCalls(),1);
 const busy=Object.assign(Error('busy'),{code:50});f.context.images.get=async()=>{throw busy};
 await assert.rejects(f.context.retainedInput(f.row,f.proof),e=>e===busy);assert.equal(f.vaultCalls(),1);
});
test('vault crop JPEG must match declared crop dimensions',async()=>{
 const f=fixture();f.row.review.frames=[];
 f.context.repository.evidenceVault={metadata:async()=>({state:'available',evidence:{kind:'target_crop',variants:['original'],channel_id:'c',stream_session_id:'s',track_id:'t',source_pts_ns:'1',source_frame_index:'1',frame_width:1920,frame_height:1080,image_width:128,image_height:64,label_id:'person'}}),image:async()=>f.data};
 await assert.rejects(f.context.retainedInput(f.row,f.proof),/evidence_identity_mismatch/);
});
test('malformed and unsupported JPEG headers have stable unsupported_image errors',()=>{
 assert.deepEqual(jpegDimensions(jpeg()),{width:64,height:64});
 const progressive=jpeg();progressive[3]=0xc2;
 const zero=jpeg();zero.writeUInt16BE(0,9);
 const badLength=jpeg();badLength.writeUInt16BE(8,4);
 for(const data of [Buffer.alloc(0),Buffer.from('0000ffc00011','hex'),Buffer.from('ffd8ffffffffffff','hex'),Buffer.from('ffd8ffe0ff','hex'),Buffer.from('ffd8ffe0ffff','hex'),progressive,zero,badLength,...Array.from({length:21},(_,n)=>jpeg().subarray(0,n))])
  assert.throws(()=>jpegDimensions(data),e=>e.message==='unsupported_image'&&!e.code);
});

test('legacy ready persists and reuses a crop without Mongo image storage',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'ainvr-crop-compat-'));
 try{
  f.context.root=root;f.context.images=null;await mkdir(join(root,'pinned'));
  let patch;f.context.repository.events={updateOne:async(_,p)=>{patch=p.$set}};
  const key=hash(f.data),item={sample:f.sample,key,data:f.data,source_kind:'retained_target',width:64,height:64,event_id:id};
  await f.context.ready(f.row,{}, {items:[item],mode:'verified_behavior_available_visuals',missing_frame_ids:['f']});
  assert.deepEqual(await readFile(join(root,'pinned',key+'.jpg')),f.data);
  f.row.review.frames=patch['review.frames'];assert.equal(f.row.review.frames[0].storage,undefined);
  assert.deepEqual((await f.context.retainedInput(f.row,f.proof)).data,f.data);assert.equal(f.vaultCalls(),0);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('real 1920x1080 full-frame evidence accepts 1280x720 JPEG without changing normalized geometry',async()=>{
 const f=fixture();f.row.review.frames=[];f.context.images.get=async()=>jpeg(1280,720);
 const image=await f.context.image(f.row,f.sample);
 assert.equal(image.width,1280);assert.equal(image.height,720);
 const box=f.sample.bbox;
 assert.ok(Math.abs((box.x*1280/1920)/image.width-box.x/1920)<1e-12);
 assert.ok(Math.abs((box.y*720/1080)/image.height-box.y/1080)<1e-12);
});
test('only the documented even-axis frame-cache rounding permits aspect drift',()=>{
 const f=fixture(),source={width:1920,height:1082};
 assert.deepEqual(f.context.validateGeometry(jpeg(1280,720),source,true),{width:1280,height:720});
 for(const [w,h] of [[1280,718],[1278,720],[1280,722],[1280,1280]])
  assert.throws(()=>f.context.validateGeometry(jpeg(w,h),source,true),/evidence_identity_mismatch/);
 // Retained target crops always require their exact recorded dimensions.
 assert.throws(()=>f.context.validateGeometry(jpeg(1280,720),{width:1920,height:1080}),/evidence_identity_mismatch/);
});
