// One bounded JPEG per Mongo document; no replica-set/transaction requirement.
import {createHash} from 'node:crypto';
const sha=data=>createHash('sha256').update(data).digest('hex');
// Pool byte sum. With the {pool,bytes} index below it is answered from the index alone (no JPEG fetch),
// so a full 1 GB pool no longer needs seconds of document reads on every put.
export const bytesPipeline=pool=>[{$match:{pool}},{$group:{_id:null,bytes:{$sum:'$bytes'}}}];
export class EvidenceImages {
 constructor(db,{clock=()=>Date.now()}={}){this.rows=db.collection('alarm_evidence_images');this.clearState=db.collection('alarm_history_clear');this.clock=clock;}
 async initialize(){
  await this.rows.createIndex({expires_at:1},{expireAfterSeconds:0});
  await this.rows.createIndex({pool:1,created_at:1});
  await this.rows.createIndex({pool:1,bytes:1});
  await this.rows.createIndex({occurred_at:1});
 }
 id(pool,key){if(!['crop','context','candidate','reference'].includes(pool)||typeof key!=='string'||!/^[a-zA-Z0-9_.-]{1,200}$/.test(key))throw Error('invalid_evidence_key');return `${pool}:${key}`;}
 async metadata(pool,key){return this.rows.findOne({_id:this.id(pool,key),expires_at:{$gt:new Date(this.clock())}},{projection:{bytes:1,sha256:1,expires_at:1}});}
 async get(pool,key){
  const row=await this.rows.findOne({_id:this.id(pool,key),expires_at:{$gt:new Date(this.clock())}});
  if(!row)return null;
  const data=Buffer.isBuffer(row.data)?row.data:row.data?.value?.(true);
  if(!Buffer.isBuffer(data)||data.length!==row.bytes||sha(data)!==row.sha256)throw Error('evidence_integrity_mismatch');
  return data;
 }
 async bytes(pool){const r=await this.rows.aggregate(bytesPipeline(pool),{maxTimeMS:3000}).toArray();return r[0]?.bytes??0;}
 async prune(pool,maxBytes,maxAge){
  this.id(pool,'check');
  await this.rows.deleteMany({pool,$or:[{expires_at:{$lte:new Date(this.clock())}},{created_at:{$lte:new Date(this.clock()-maxAge)}}]});
  let used=await this.bytes(pool);
  // Bounded batches; callers retry later if an extreme backlog cannot be reclaimed.
  for await(const row of this.rows.find({pool},{projection:{_id:1,bytes:1}}).sort({created_at:1,_id:1}).limit(512)){
   if(used<=maxBytes)break;
   const result=await this.rows.deleteOne({_id:row._id});if(result.deletedCount)used-=row.bytes;
  }
  return used<=maxBytes;
 }
 async put(pool,key,data,{maxBytes,retentionMs,occurredAt}={}){
  const _id=this.id(pool,key);
  if(!Buffer.isBuffer(data)||data.length<4||data.length>8*1024**2||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)throw Error('invalid_evidence_image');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<data.length||!Number.isSafeInteger(retentionMs)||retentionMs<1)throw Error('invalid_evidence_policy');
  const at=occurredAt??new Date(this.clock()).toISOString();
  if(!Number.isFinite(Date.parse(at)))throw Error('invalid_evidence_time');
  const cleared=await this.clearState.findOne({_id:'state'});
  if(cleared&&at<=cleared.cutoff)throw Error('evidence_cleared');
  const expires=new Date(Math.min(this.clock(),Date.parse(at))+retentionMs);
  if(expires.getTime()<=this.clock())throw Error('evidence_expired');
  const digest=sha(data),old=await this.rows.findOne({_id},{projection:{sha256:1}});
  if(old){if(old.sha256!==digest)throw Error('evidence_identity_conflict');if(await this.get(pool,key))return;await this.rows.deleteOne({_id,sha256:digest});}
  if(!await this.prune(pool,maxBytes-data.length,retentionMs))throw Error('evidence_capacity');
  try{await this.rows.updateOne({_id},{$setOnInsert:{pool,key,data,bytes:data.length,sha256:digest,created_at:new Date(this.clock()),occurred_at:at,expires_at:expires}},{upsert:true});}
  catch(e){if(e.code!==11000)throw e;}
  const afterClear=await this.clearState.findOne({_id:'state'});
  if(afterClear&&at<=afterClear.cutoff){await this.rows.deleteOne({_id});throw Error('evidence_cleared');}
  const saved=await this.get(pool,key);if(!saved||sha(saved)!==digest)throw Error('evidence_integrity_mismatch');
 }
 async remove(pool,key){await this.rows.deleteOne({_id:this.id(pool,key)});}
}
