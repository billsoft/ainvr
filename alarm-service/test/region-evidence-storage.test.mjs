import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {regionEvidenceMetadata,regionEvidenceImage} from '../src/region-evidence.mjs';
const jpeg=Buffer.from([255,216,1,2,255,217]),sha=createHash('sha256').update(jpeg).digest('hex');
function fact(storage){return {occurred_at:new Date().toISOString(),analysis_evidence:{region_state:{},delivery:{state:'complete',frames:[1,2].map(n=>({identity_kind:'region',observation:'region',frame_id:`f${n}`,key:String(n).repeat(64),content_sha256:sha,storage,width:640,height:480,count:0,captured_at:new Date().toISOString()}))}}};}
test('SSD region evidence never regenerates missing retained frames from rolling source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-region-evidence-'));
 try{
  await mkdir(join(root,'pinned'));const row=fact('ssd'),context={root,policy:{retention_days:7},image:()=>{throw Error('must never regenerate');}};
  for(const ref of row.analysis_evidence.delivery.frames)await writeFile(join(root,'pinned',ref.key+'.jpg'),jpeg);
  assert.equal((await regionEvidenceMetadata(context,row)).state,'available');
  assert.deepEqual(await regionEvidenceImage(context,row,'processed','f1'),jpeg);
  await assert.rejects(()=>regionEvidenceImage(context,row,'processed','other'),/Frame does not belong/);
  await writeFile(join(root,'pinned',row.analysis_evidence.delivery.frames[0].key+'.jpg'),Buffer.from('corrupt'));
  assert.equal((await regionEvidenceMetadata(context,row)).reason,'stored_file_missing');
  row.analysis_evidence.delivery.frames[0].storage='unknown';
  assert.equal((await regionEvidenceMetadata(context,row)).reason,'frame_identity_unavailable');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('real Mongo retains exact region frames, rejects hash mismatch and expiry',{skip:!process.env.AINVR_ALARM_TEST_MONGO_URI},async()=>{
 const uri=new URL(process.env.AINVR_ALARM_TEST_MONGO_URI);
 assert.ok(['127.0.0.1','localhost'].includes(uri.hostname)&&uri.port&&uri.port!=='27017');
 const {MongoClient}=await import('mongodb'),{EvidenceImages}=await import('../src/evidence-images.mjs');
 const client=new MongoClient(uri.href),name='ainvr_region_evidence_test_'+randomUUID().replaceAll('-','');await client.connect();
 const db=client.db(name);
 try{
  const images=new EvidenceImages(db);await images.initialize();const row=fact('mongodb'),context={images,policy:{retention_days:7}};
  for(const ref of row.analysis_evidence.delivery.frames)await images.put('context',ref.key,jpeg,{maxBytes:1024*1024,retentionMs:86400000,occurredAt:row.occurred_at});
  assert.equal((await regionEvidenceMetadata(context,row)).state,'available');assert.deepEqual(await regionEvidenceImage(context,row,'processed','f2'),jpeg);
  const ref=row.analysis_evidence.delivery.frames[0];ref.content_sha256='0'.repeat(64);assert.equal((await regionEvidenceMetadata(context,row)).reason,'stored_file_missing');ref.content_sha256=sha;
  await images.rows.updateOne({_id:images.id('context',ref.key)},{$set:{expires_at:new Date(0)}});
  assert.notEqual((await regionEvidenceMetadata(context,row)).state,'available');
  await assert.rejects(()=>regionEvidenceImage(context,row),/unavailable/);
 }finally{await db.dropDatabase();await client.close();}
});
