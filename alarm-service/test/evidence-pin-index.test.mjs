// Releasing one channel's evidence pins must not cost time in proportion to every other channel's pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EvidenceSpool,frameKey} from '../src/evidence-spool.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const sample=i=>({source_pts_ns:String(i),source_frame_index:String(i),frame_id:`s:${i}`});
test('settling one channel leaves other channels pins alone and does not scan them per frame',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pins-'));
 try{
  await mkdir(join(root,'raw'));
  // Pins left behind by channels that no longer consume (deleted while blocked).
  const foreign=30000,dead=hash('deleted-channel');
  for(let i=0;i<foreign;i+=2000)await Promise.all(Array.from({length:2000},(_,j)=>writeFile(join(root,'raw',`${hash('k'+(i+j))}.${dead}.1.pin`),'1')));
  const spool=new EvidenceSpool(root);
  await spool.protect({checkpoint:{a:sample(1)}},'live','s',1);
  const started=performance.now();
  for(let i=2;i<=400;i++){
   await spool.protect({a:sample(i)},'live','s',1);
   await spool.settle({session:'s',a:sample(i)},'live',1);
  }
  const perFrame=(performance.now()-started)/399;
  const names=await readdir(join(root,'raw'));
  const mine=names.filter(n=>n.includes('.'+hash('live')+'.'));
  assert.deepEqual(mine,[`${frameKey('live','s',sample(400))}.${hash('live')}.1.pin`],'only the frame still referenced stays pinned');
  assert.equal(names.filter(n=>n.includes('.'+dead+'.')).length,foreign,'another channel is never released from here');
  // 30 000 foreign pins cost tens of ms per frame when every settle walked the whole index.
  assert.ok(perFrame<8,`per-frame protect+settle took ${perFrame.toFixed(1)} ms`);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a stale lease cannot release pins of a newer generation of the same channel',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pins-'));
 try{
  const spool=new EvidenceSpool(root);
  await spool.protect({a:sample(1)},'live','s',5);
  await spool.settle({session:'s'},'live',4);
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,1);
  await spool.settle({session:'s'},'live',5);
  assert.equal((await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin')).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
