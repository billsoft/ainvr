// Pins of a frame must stay bounded however often its outcome is retried, and pins of a
// channel that no longer consumes must eventually be released. On .189 a retry storm
// left 1433 generations of pins per frame: 64 999 hardlinks on one anchor inode (the
// ext4 cap), after which every protect failed for all channels and nothing settled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,link,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EvidenceSpool,frameKey,evidenceSyncStatus} from '../src/evidence-spool.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const sample=i=>({source_pts_ns:String(i),source_frame_index:String(i),frame_id:`s:${i}`});
const pins=async root=>(await readdir(join(root,'raw'))).filter(n=>n.endsWith('.pin'));
const HOUR=3600000;

test('retrying one outcome keeps one pin per frame; a frame held only by an older generation stays pinned',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pins-'));
 try{
  const spool=new EvidenceSpool(root);
  await spool.protect({a:sample(1),b:sample(2)},'live','s',1);
  for(let g=2;g<=50;g++)await spool.protect({a:sample(1)},'live','s',g);
  const names=await pins(root),owner=hash('live');
  assert.deepEqual(names.filter(n=>n.startsWith(frameKey('live','s',sample(1)))),[`${frameKey('live','s',sample(1))}.${owner}.50.pin`]);
  assert.deepEqual(names.filter(n=>n.startsWith(frameKey('live','s',sample(2)))),[`${frameKey('live','s',sample(2))}.${owner}.1.pin`],'settle owns pins of keys not in this call');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a full anchor inode does not stop protection',async()=>{
 // ext4 caps one inode at 65 000 links. Fill the anchor to the cap, then protect.
 await mkdir('/mnt/ainvr-ssd/ainvr-tests',{recursive:true}).catch(()=>{});
 const base=await stat('/mnt/ainvr-ssd/ainvr-tests').then(()=>'/mnt/ainvr-ssd/ainvr-tests',()=>tmpdir());
 const root=await mkdtemp(join(base,'ainvr-pins-'));
 try{
  const spool=new EvidenceSpool(root);
  await spool.protect({a:sample(1)},'live','s',1);
  const anchor=join(root,'raw','.pin-anchor');
  let full=false;
  for(let i=0;!full&&i<70000;i+=1000){
   const batch=await Promise.allSettled(Array.from({length:1000},(_,j)=>link(anchor,join(root,'raw',`fill-${i+j}`))));
   full=batch.some(r=>r.status==='rejected'&&r.reason.code==='EMLINK');
  }
  await spool.protect({a:sample(2)},'live','s',2);
  assert.ok((await pins(root)).includes(`${frameKey('live','s',sample(2))}.${hash('live')}.2.pin`));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('pins of a channel without an enabled rule are released after an hour without protection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-pins-'));
 try{
  await mkdir(join(root,'raw'));
  // Left by a deleted channel before this process started (no protect seen).
  const gone=hash('deleted');
  await Promise.all(Array.from({length:2500},(_,i)=>writeFile(join(root,'raw',`${hash('k'+i)}.${gone}.7.pin`),'')));
  const spool=new EvidenceSpool(root);
  await spool.protect({a:sample(1)},'live','s',1);
  await spool.protect({a:sample(2)},'paused','s',1);   // no enabled rule, but protected just now
  const t=Date.now();
  assert.equal(await spool.releaseInactive(null,{now:t+10*HOUR}),0,'no rule snapshot: nothing is judged inactive');
  assert.equal(await spool.releaseInactive(['live'],{now:t}),0,'first sighting only starts the clock');
  assert.equal(await spool.releaseInactive(['live'],{now:t+HOUR-1000}),0,'within the hour');
  assert.equal(await spool.releaseInactive(['live'],{now:t+HOUR+1000,limit:1000}),1000,'bounded per sweep');
  assert.equal(await spool.releaseInactive(['live'],{now:t+HOUR+2000,limit:1000}),1000);
  assert.equal(await spool.releaseInactive(['live'],{now:t+HOUR+3000,limit:1000}),501,'the rest, and the paused channel once its last protect is an hour old');
  assert.deepEqual(await pins(root),[`${frameKey('live','s',sample(1))}.${hash('live')}.1.pin`],'an enabled channel keeps its pins');
  assert.ok(evidenceSyncStatus().released_inactive>=2501);
  // A channel enabled again pins normally.
  await spool.protect({a:sample(3)},'deleted','s',8);
  assert.equal((await pins(root)).length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
