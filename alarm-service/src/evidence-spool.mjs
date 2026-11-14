// SSD frame ownership follows the durable observation checkpoint, not wall-clock TTL.
import {open,mkdir,readdir,rename,unlink,link,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const metrics={writes:0,failures:0,total_ms:0,max_ms:0,directory_scans:0,deduplicated:0,anchor_rotations:0,released_inactive:0,buckets:{le_1:0,le_5:0,le_20:0,le_100:0,gt_100:0}};
const record=ms=>{++metrics.writes;metrics.total_ms+=ms;metrics.max_ms=Math.max(metrics.max_ms,ms);++metrics.buckets[ms<=1?'le_1':ms<=5?'le_5':ms<=20?'le_20':ms<=100?'le_100':'gt_100'];};
// Per spool root, shared by every EvidenceSpool instance in this process.
// A full listing of a busy spool (tens of thousands of frames) per consumed
// frame, plus two fsyncs per ACK, capped alarm consumption near 10 frames/s.
const dirtyAcks=new Set(),pinIndexes=new Map(),durablePins=new Map(),anchors=new Map();
// Pin names this process has committed with a directory sync. Consecutive frames
// reference the same evidence, so most protections create nothing new; syncing the
// directory anyway cost ~40 ms per consumed frame. Names found on disk at startup
// are not trusted as durable and are committed once when first referenced.
const durableSet=root=>{let set=durablePins.get(root);if(!set)durablePins.set(root,set=new Set());return set;};
// Per root: when each owner last protected anything (any path, HTTP input included) and
// when a sweep first found it without an enabled rule. In memory only: a restart restarts
// the clocks, which can only keep pins longer.
const protectedAt=new Map(),inactiveSince=new Map();
const ownerClock=(map,root)=>{let clock=map.get(root);if(!clock)map.set(root,clock=new Map());return clock;};
// Pin names grouped by the channel that owns them. Releasing pins after each consumed frame
// walks one channel's own handful of names, never every pin in the spool: pins left behind by
// channels that stopped consuming used to cost every other channel a full scan per frame.
const pinName=/^([a-f0-9]{64})\.([a-f0-9]{64})(?:\.(\d+))?\.pin$/;
function pinIndex(root){
 let index=pinIndexes.get(root);
 if(!index){
  index=(async()=>{++metrics.directory_scans;let names=[];try{names=await readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;}const owners=new Map();for(const name of names){const match=pinName.exec(name);if(!match)continue;let set=owners.get(match[2]);if(!set)owners.set(match[2],set=new Set());set.add(name);}return owners;})();
  pinIndexes.set(root,index);index.catch(()=>{if(pinIndexes.get(root)===index)pinIndexes.delete(root);});
 }
 return index;
}
export function evidenceSyncStatus(){return structuredClone(metrics);}
const hash=s=>createHash('sha256').update(s).digest('hex');
export const frameKey=(channel,session,s)=>hash([channel,session,s.source_pts_ns,s.source_frame_index].join('\n'));
export async function durableFile(path,data){
 const started=performance.now();
 const temporary=path+'.'+randomUUID()+'.tmp';
 try{
 const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(data);await file.sync();}finally{await file.close();}
 await rename(temporary,path);
 const dir=await open(join(path,'..'),'r');try{await dir.sync();}finally{await dir.close();}
 }catch(error){++metrics.failures;throw error;}finally{
 const ms=performance.now()-started;++metrics.writes;metrics.total_ms+=ms;metrics.max_ms=Math.max(metrics.max_ms,ms);++metrics.buckets[ms<=1?'le_1':ms<=5?'le_5':ms<=20?'le_20':ms<=100?'le_100':'gt_100'];
 await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function boundedRead(path,limit){
 const file=await open(path,'r');
 try{
  const info=await file.stat();if(!info.isFile()||info.size<=0||info.size>limit)throw Error('evidence_integrity_mismatch');
  const data=Buffer.alloc(info.size);let offset=0;
  while(offset<data.length){const {bytesRead}=await file.read(data,offset,data.length-offset,offset);if(!bytesRead)throw Error('evidence_integrity_mismatch');offset+=bytesRead;}
  return data;
 }finally{await file.close();}
}
export class EvidenceSpool {
 constructor(root){this.root=join(root,'raw');}
 async pinAnchor(){
  // Pins contain no per-frame data: use hard links to one fsynced immutable
  // marker inode. Each generation still has its own fenced filename. A single
  // directory fsync commits the entire batch before Mongo pending is prepared.
  // One durable anchor per spool per process, shared by every instance (the pump
  // creates short-lived instances; re-writing the anchor cost two syncs each).
  let anchor=anchors.get(this.root);
  if(!anchor){const path=join(this.root,'.pin-anchor');anchor=durableFile(path,'1').then(()=>path);anchors.set(this.root,anchor);anchor.catch(()=>{if(anchors.get(this.root)===anchor)anchors.delete(this.root);});}
  return anchor;
 }
 // ext4 caps one inode at 65 000 links. At the cap every protect failed for every
 // channel of the process (.189: one anchor reached 64 999 links), so a full anchor
 // is replaced by a fresh one. Returns the anchor the pin was linked to.
 async linkPin(anchor,name){
  try{await link(anchor,join(this.root,name));return anchor;}
  catch(error){
   if(error.code==='EEXIST')return anchor;
   if(error.code!=='EMLINK')throw error;
  }
  const current=await anchors.get(this.root);
  let next=current;
  if(!current||current===anchor){
   const path=join(this.root,'.pin-anchor.'+randomUUID());
   const made=durableFile(path,'').then(()=>path);anchors.set(this.root,made);
   made.catch(()=>{if(anchors.get(this.root)===made)anchors.delete(this.root);});
   next=await made;++metrics.anchor_rotations;
  }
  await link(next,join(this.root,name)).catch(error=>{if(error.code!=='EEXIST')throw error;});
  return next;
 }
 keys(value,channel,session){
  const keys=new Set();
  const walk=x=>{if(!x||typeof x!=='object')return;
   if(x.source_pts_ns!=null&&x.source_frame_index!=null&&x.frame_id!=null)keys.add(frameKey(channel,session,x));
   for(const v of Object.values(x))if(v&&typeof v==='object')walk(v);
  };walk(value);return keys;
 }
 async protect(value,channel,session,generation=0){
  if(!Number.isSafeInteger(generation)||generation<0)throw Error('invalid_evidence_generation');
  await mkdir(this.root,{recursive:true,mode:0o700});
  const owner=hash(channel);ownerClock(protectedAt,this.root).set(owner,Date.now());
  const keys=this.keys(value,channel,session);if(!keys.size)return;
  let anchor=await this.pinAnchor();const started=performance.now();let synced=false;
  try{
   const index=await pinIndex(this.root),durable=durableSet(this.root),names=[];
   for(const key of keys){const name=key+'.'+owner+'.'+generation+'.pin';anchor=await this.linkPin(anchor,name);let mine=index.get(owner);if(!mine)index.set(owner,mine=new Set());mine.add(name);names.push(name);}
   if(names.every(name=>durable.has(name)))return;
   synced=true;
   const directory=await open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
   for(const name of names)durable.add(name);
   // A retried outcome pins the same frames again under each new lease generation.
   // Once these names are durable, older generations of the SAME keys protect
   // nothing more (.189: 1433 generations per frame). Older pins of other keys are
   // left to settle(). A lost unlink only keeps a frame longer: no directory sync.
   const mine=index.get(owner);
   for(const old of [...mine]){
    const match=pinName.exec(old);
    if(!match||!keys.has(match[1])||Number(match[3]??0)>=generation)continue;
    await unlink(join(this.root,old)).catch(e=>{if(e.code!=='ENOENT')throw e;});mine.delete(old);durable.delete(old);++metrics.deduplicated;
   }
  }catch(error){++metrics.failures;synced=true;throw error;}
  finally{if(synced)record(performance.now()-started);}
 }
 async settle(checkpoint,channel,generation=0){
  if(!Number.isSafeInteger(generation)||generation<0)throw Error('invalid_evidence_generation');
  const owner=hash(channel),keep=this.keys(checkpoint,channel,checkpoint.session);
  // Pins are created only through protect(); the index is loaded from disk once
  // per process. Pins written by another process later are kept (never released
  // early), which can only retain evidence longer, never lose it.
  const mine=(await pinIndex(this.root)).get(owner);
  if(!mine)return;
  for(const name of [...mine]){
   const match=pinName.exec(name);
   if(!match)continue;
   const pinGeneration=Number(match[3]??0);
   // A worker whose lease expired cannot release a newer worker's evidence.
   if(pinGeneration>generation||(pinGeneration===generation&&keep.has(match[1])))continue;
   await unlink(join(this.root,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});mine.delete(name);durableSet(this.root).delete(name);
  }
 }
 // settle() releases pins only when their channel consumes again. A channel whose
 // rules were deleted or disabled never does, so its pins, and the frames they hold,
 // would stay forever. `channels` are the channels with an enabled rule in the rule
 // snapshot just loaded; null (no snapshot) judges nothing inactive. An owner is
 // released after an hour both without an enabled rule and without any protect().
 // Re-enabled later, an old pending outcome finds its frame gone and publishes
 // without a screenshot (source_frame_missing), the existing graceful path.
 async releaseInactive(channels,{now=Date.now(),graceMs=3600000,limit=1000}={}){
  if(!Array.isArray(channels))return 0;
  const active=new Set(channels.map(hash)),index=await pinIndex(this.root);
  const since=ownerClock(inactiveSince,this.root),touched=ownerClock(protectedAt,this.root),durable=durableSet(this.root);
  let released=0;
  owners: for(const [owner,names] of index){
   if(active.has(owner)){since.delete(owner);continue;}
   if(!since.has(owner))since.set(owner,now);
   if(names.size&&now-Math.max(since.get(owner),touched.get(owner)??0)<graceMs)continue;
   for(const name of [...names]){
    if(released>=limit)break owners;
    await unlink(join(this.root,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});names.delete(name);durable.delete(name);++released;
   }
   if(!names.size){index.delete(owner);since.delete(owner);touched.delete(owner);}
  }
  metrics.released_inactive+=released;return released;
 }
 async acknowledge(frame,{defer=false}={}){
  if(frame.evidence_delivery?.schema_version!==2||frame.evidence_delivery.state!=='durable')return;
  const path=join(this.root,frameKey(frame.channel_id,frame.stream_session_id,frame)+'.ack');
  // Empty on purpose: the AI cache reads only the ACK's name and age, and on a
  // memory spool (64 KiB pages on .190) a 1-byte file costs a whole page per frame.
  if(!defer)return durableFile(path,'');
  // The AI cache tests only the ACK name and its age, never its bytes. A deferred
  // ACK is made durable by flushAcknowledgements() before its journal record's
  // deletion is committed, so a crash replays the record and ACKs it again.
  await writeFile(path,'',{mode:0o600});dirtyAcks.add(this.root);
 }
 async flushAcknowledgements(){
  if(!dirtyAcks.has(this.root))return;
  dirtyAcks.delete(this.root);const started=performance.now();
  try{const dir=await open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}
  catch(error){dirtyAcks.add(this.root);++metrics.failures;throw error;}
  finally{record(performance.now()-started);}
 }
 async read(row,sample){
  const key=frameKey(row.channel_id,row.stream_session_id,sample);
  let meta;
  const encoded=await boundedRead(join(this.root,key+'.json'),65536);
  try{meta=JSON.parse(encoded.toString('utf8'));}catch{throw Error('evidence_integrity_mismatch');}
  if(!meta||meta.schema_version!==2||!Number.isSafeInteger(meta.bytes)||meta.bytes<4||meta.bytes>8*1024**2)throw Error('evidence_integrity_mismatch');
  for(const [k,v] of Object.entries({channel_id:row.channel_id,stream_session_id:row.stream_session_id,source_pts_ns:sample.source_pts_ns,source_frame_index:sample.source_frame_index,frame_width:row.analysis_evidence.source.width,frame_height:row.analysis_evidence.source.height}))if(meta[k]!==v)throw Error('evidence_identity_mismatch');
  const data=await boundedRead(join(this.root,key+'.jpg'),8*1024**2);
  if(meta.schema_version!==2||meta.bytes!==data.length||meta.sha256!==hash(data))throw Error('evidence_integrity_mismatch');
  return {key,data};
 }
}
