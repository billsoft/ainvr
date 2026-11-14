import {evidenceSyncStatus} from '../src/evidence-spool.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,truncate,stat,unlink} from 'node:fs/promises';
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
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,1);
  await spool.acknowledge({...s,channel_id:'c',stream_session_id:'s',evidence_delivery:{schema_version:2,state:'durable'}});
  // Name-only marker: an empty ACK costs no 64 KiB page on a memory spool.
  assert.equal(await readFile(join(root,'raw',frameKey('c','s',s)+'.ack'),'utf8'),'');
  await spool.acknowledge({...s,frame_id:'s:2',source_frame_index:'2',channel_id:'c',stream_session_id:'s',evidence_delivery:{schema_version:2,state:'durable'}},{defer:true});
  assert.equal((await stat(join(root,'raw',frameKey('c','s',{...s,source_frame_index:'2'})+'.ack'))).size,0);
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

test('durable operation telemetry counts failures and exposes immutable bounded buckets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-metrics-'));try{
  const before=evidenceSyncStatus();
  await durableFile(join(root,'ok'),'1');
  await assert.rejects(durableFile(join(root,'missing','bad'),'1'));
  const after=evidenceSyncStatus();assert.equal(after.writes-before.writes,2);
  assert.equal(after.failures-before.failures,1);assert.ok(after.total_ms>=before.total_ms);
  assert.equal(Object.values(after.buckets).reduce((a,b)=>a+b,0),after.writes);
  after.buckets.le_1=-1;assert.notEqual(evidenceSyncStatus().buckets.le_1,-1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('batched pins share durable marker data, retain generation fences and survive anchor replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pin-batch-'));try{
  const spool=new EvidenceSpool(root),samples=Array.from({length:12},(_,i)=>({frame_id:'s:'+i,source_pts_ns:String(i),source_frame_index:String(i)}));
  await spool.protect(samples,'c','s',4);
  const anchor=await stat(join(root,'raw','.pin-anchor'));
  for(const sample of samples){const p=join(root,'raw',frameKey('c','s',sample)+'.'+sha('c')+'.4.pin');assert.equal((await stat(p)).ino,anchor.ino);assert.equal(await readFile(p,'utf8'),'1');}
  const restarted=new EvidenceSpool(root);await restarted.protect(samples,'c','s',5);
  await spool.settle({session:'s'},'c',4); // stale worker cannot remove generation 5
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.5.pin')).length,12);
  await restarted.settle({session:'s',samples},'c',5);
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,12);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed pin creation rejects preparation and leaves previously protected frames intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pin-failure-'));try{
  const spool=new EvidenceSpool(root),sample={frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1'};
  await spool.protect(sample,'c','s',1);await unlink(join(root,'raw','.pin-anchor'));
  await assert.rejects(spool.protect(sample,'c','s',2),{code:'ENOENT'});
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.1.pin')).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('deferred acknowledgements are visible at once and committed by one directory flush',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  const spool=new EvidenceSpool(root);await mkdir(join(root,'raw'));
  const frames=Array.from({length:20},(_,i)=>({channel_id:'c',stream_session_id:'s',source_pts_ns:String(i),source_frame_index:String(i),evidence_delivery:{schema_version:2,state:'durable'}}));
  const before=evidenceSyncStatus().writes;
  for(const frame of frames)await spool.acknowledge(frame,{defer:true});
  for(const frame of frames)assert.equal((await stat(join(root,'raw',frameKey('c','s',frame)+'.ack'))).isFile(),true);
  await new EvidenceSpool(root).flushAcknowledgements();
  assert.equal(evidenceSyncStatus().writes-before,1,'one directory sync must commit the whole batch');
  await spool.flushAcknowledgements();
  assert.equal(evidenceSyncStatus().writes-before,1,'a clean spool must not sync again');
  await spool.acknowledge({...frames[0],evidence_delivery:{schema_version:2,state:'failed'}},{defer:true});
  await spool.flushAcknowledgements();assert.equal(evidenceSyncStatus().writes-before,1,'non-durable evidence is never acknowledged');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('settle consults a shared pin index instead of rescanning the spool on every frame',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-spool-'));try{
  await mkdir(join(root,'raw'));
  for(let i=0;i<300;++i)await writeFile(join(root,'raw',sha(String(i))+'.jpg'),'x');
  const a={frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1'},b={frame_id:'s:2',source_pts_ns:'2',source_frame_index:'2'};
  const writer=new EvidenceSpool(root),settler=new EvidenceSpool(root);
  await writer.protect({states:{a:{review_compact:{start:a}}}},'c','s',1);
  await settler.settle({session:'s',states:{a:{review_compact:{start:a}}}},'c',1);
  const scans=evidenceSyncStatus().directory_scans;
  for(let i=0;i<50;++i)await settler.settle({session:'s',states:{a:{review_compact:{start:a}}}},'c',1);
  assert.equal(evidenceSyncStatus().directory_scans-scans,0,'steady-state settle must not list the spool');
  await writer.protect({states:{b:{review_compact:{start:b}}}},'c','s',2);
  await settler.settle({session:'s',states:{b:{review_compact:{start:b}}}},'c',2);
  const pins=(await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin'));
  assert.deepEqual(pins,[frameKey('c','s',b)+'.'+sha('c')+'.2.pin'],'pin created by another instance must be indexed and older generation released');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('re-protecting already-durable pins does not sync the spool directory again',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pin-resync-'));try{
  const a={frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1'},b={frame_id:'s:2',source_pts_ns:'2',source_frame_index:'2'};
  const spool=new EvidenceSpool(root);await spool.protect(a,'c','s',1);
  const before=evidenceSyncStatus().writes;
  for(let i=0;i<20;++i)await spool.protect(a,'c','s',1);
  await new EvidenceSpool(root).protect(a,'c','s',1);
  assert.equal(evidenceSyncStatus().writes-before,0,'every consumed frame re-syncing unchanged pins capped alarm consumption');
  await spool.protect({a,b},'c','s',1);
  assert.equal(evidenceSyncStatus().writes-before,1,'a new pin must still be committed before preparation');
  await spool.settle({session:'s',b},'c',1);
  await spool.protect(a,'c','s',1);
  assert.equal(evidenceSyncStatus().writes-before,2,'a released and re-created pin must be committed again');
  assert.ok((await readdir(join(root,'raw'))).includes(frameKey('c','s',a)+'.'+sha('c')+'.1.pin'));
 }finally{await rm(root,{recursive:true,force:true});}
});
