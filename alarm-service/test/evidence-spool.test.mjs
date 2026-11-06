import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EvidenceSpool,durableFile,frameKey} from '../src/evidence-spool.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
test('checkpoint-owned frames stay pinned; only durable consumed frames are acknowledged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  const spool=new EvidenceSpool(root),s={frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1'};
  await spool.protect({states:{a:{review_compact:{start:s}}}},'c','s');
  const pins=await readdir(join(root,'raw'));assert.equal(pins.filter(n=>n.endsWith('.pin')).length,1);
  await spool.settle({session:'s',states:{a:{review_compact:{start:s}}}},'c');
  assert.equal((await readdir(join(root,'raw'))).length,1);
  await spool.acknowledge({...s,channel_id:'c',stream_session_id:'s',evidence_delivery:{schema_version:2,state:'durable'}});
  assert.equal(await readFile(join(root,'raw',frameKey('c','s',s)+'.ack'),'utf8'),'1');
  await spool.settle({session:'s',states:{}},'c');assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('durable spool validates exact frame identity and content, not timestamp proximity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  const spool=new EvidenceSpool(root),sample={source_pts_ns:'1',source_frame_index:'2'},row={channel_id:'c',stream_session_id:'s',analysis_evidence:{source:{width:100,height:100}}};
  const key=frameKey('c','s',sample),data=Buffer.from([255,216,255,217]);await mkdir(join(root,'raw'));
  const meta={schema_version:2,channel_id:'c',stream_session_id:'s',...sample,frame_width:100,frame_height:100,bytes:data.length,sha256:sha(data)};
  await durableFile(join(root,'raw',key+'.jpg'),data);await durableFile(join(root,'raw',key+'.json'),JSON.stringify(meta));
  assert.deepEqual((await spool.read(row,sample)).data,data);
  await writeFile(join(root,'raw',key+'.jpg'),Buffer.from([255,216,0,217]));
  await assert.rejects(spool.read(row,sample),/integrity/);
  await durableFile(join(root,'raw',key+'.json'),JSON.stringify({...meta,channel_id:'other'}));
  await assert.rejects(spool.read(row,sample),/identity/);
  await writeFile(join(root,'raw',key+'.json'),'{broken');
  await assert.rejects(spool.read(row,sample),/evidence_integrity_mismatch/);
  await writeFile(join(root,'raw',key+'.json'),'null');
  await assert.rejects(spool.read(row,sample),/evidence_integrity_mismatch/);
  await durableFile(join(root,'raw',key+'.json'),JSON.stringify(meta));
  await truncate(join(root,'raw',key+'.jpg'),8*1024**2+1);
  await assert.rejects(spool.read(row,sample),/evidence_integrity_mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('expired lease cannot delete newer evidence pins; settled generations remain bounded',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  const spool=new EvidenceSpool(root),a={frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1'},b={frame_id:'s:2',source_pts_ns:'2',source_frame_index:'2'};
  await spool.protect(a,'c','s',1);await spool.protect(b,'c','s',2);
  await spool.settle({session:'s'},'c',1);
  assert.ok((await readdir(join(root,'raw'))).some(n=>n.startsWith(frameKey('c','s',b))&&n.endsWith('.2.pin')));
  await spool.settle({session:'s',states:{b}},'c',2);
  await spool.protect(b,'c','s',3);await spool.settle({session:'s',states:{b}},'c',3);
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('concurrent durable ACK writes use separate temporary files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  const target=join(root,'shared.ack');await Promise.all(Array.from({length:12},()=>durableFile(target,'1')));
  assert.equal(await readFile(target,'utf8'),'1');assert.deepEqual(await readdir(root),['shared.ack']);
 }finally{await rm(root,{recursive:true,force:true});}
});
