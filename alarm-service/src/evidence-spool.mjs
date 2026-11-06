// SSD frame ownership follows the durable observation checkpoint, not wall-clock TTL.
import {open,mkdir,readdir,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
export const frameKey=(channel,session,s)=>hash([channel,session,s.source_pts_ns,s.source_frame_index].join('\n'));
export async function durableFile(path,data){
 const temporary=path+'.'+randomUUID()+'.tmp';
 try{
 const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(data);await file.sync();}finally{await file.close();}
 await rename(temporary,path);
 const dir=await open(join(path,'..'),'r');try{await dir.sync();}finally{await dir.close();}
 }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
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
  const owner=hash(channel);
  for(const key of this.keys(value,channel,session))await durableFile(join(this.root,key+'.'+owner+'.'+generation+'.pin'),'1');
 }
 async settle(checkpoint,channel,generation=0){
  if(!Number.isSafeInteger(generation)||generation<0)throw Error('invalid_evidence_generation');
  const owner=hash(channel),keep=this.keys(checkpoint,channel,checkpoint.session);
  for(const name of await readdir(this.root)){
   const match=/^([a-f0-9]{64})\.([a-f0-9]{64})(?:\.(\d+))?\.pin$/.exec(name);
   if(!match||match[2]!==owner)continue;
   const pinGeneration=Number(match[3]??0);
   // A worker whose lease expired cannot release a newer worker's evidence.
   if(pinGeneration>generation||(pinGeneration===generation&&keep.has(match[1])))continue;
   await unlink(join(this.root,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
 }
 async acknowledge(frame){
  if(frame.evidence_delivery?.schema_version!==2||frame.evidence_delivery.state!=='durable')return;
  await durableFile(join(this.root,frameKey(frame.channel_id,frame.stream_session_id,frame)+'.ack'),'1');
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
