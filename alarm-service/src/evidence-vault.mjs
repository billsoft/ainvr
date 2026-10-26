// Independent event-crop retention. The AI service remains a generic source.
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readdir,unlink,readFile,statfs} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {fail} from './domain.mjs';
const maximumImage=8*1024*1024,day=86400000;
const filePattern=/^[a-f0-9]{64}-(processed|original)-[a-f0-9-]{36}\.jpg$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateEvidencePolicy(value){
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['enabled','retention_days','max_bytes'].includes(k))||typeof value.enabled!=='boolean'||
   !Number.isInteger(value.retention_days)||value.retention_days<1||value.retention_days>3650||!Number.isSafeInteger(value.max_bytes)||value.max_bytes<128*1024*1024||value.max_bytes>1024**4)throw Error('Invalid evidence policy');
 return Object.freeze({...value});
}
async function syncDirectory(root){const handle=await open(root,'r');try{await handle.sync();}finally{await handle.close();}}
async function writePrivate(path,data){const h=await open(path,'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
function id(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('invalid_evidence_id','Invalid behavior event identity');return value;}
function imageBuffer(value){
 if(!Buffer.isBuffer(value)||value.length<4||value.length>maximumImage||value[0]!==255||value[1]!==216||value.at(-2)!==255||value.at(-1)!==217)throw Error('Invalid JPEG');
 return value;
}
function exactEvidence(raw,fact){
 const e=raw?.evidence;
 if(raw?.state!=='available'||!e||e.kind!=='target_crop'||typeof e.image_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(e.image_id)||
   e.channel_id!==fact.channel_id||e.track_id!==fact.track_id||e.stream_session_id!==fact.stream_session_id||e.source_pts_ns!==fact.source_pts_ns||e.source_frame_index!==fact.source_frame_index||
   e.frame_width!==fact.analysis_evidence.source.width||e.frame_height!==fact.analysis_evidence.source.height||e.label_id&&e.label_id!==fact.label_id||
   !Number.isInteger(e.image_width)||!Number.isInteger(e.image_height)||e.image_width<1||e.image_height<1||e.image_width>32768||e.image_height>32768||
   !Array.isArray(e.variants)||!e.variants.includes('processed')||e.variants.length>2||new Set(e.variants).size!==e.variants.length||e.variants.some(v=>!['processed','original'].includes(v)))throw Error('Source evidence identity mismatch');
 return Object.fromEntries(['kind','image_id','channel_id','track_id','stream_session_id','source_pts_ns','source_frame_index','frame_width','frame_height','image_width','image_height','label_id','variants'].map(k=>[k,e[k]??null]));
}
export class EvidenceVault{
 constructor(db,{root,policy,source,clock=()=>Date.now(),images=null}){
  this.db=db;this.rows=db.collection('alarm_evidence');this.facts=db.collection('behavior_events');this.root=resolve(root);this.policy=policy;this.source=source;this.clock=clock;
  this.images=images;this.used=0;this.timer=null;this.inFlight=null;this.closing=false;this.lock=null;this.lastError=null;this.needsRecovery=false;
 }
 async initialize(){
  await this.images?.initialize();
  if(process.platform!=='linux')throw Error('Evidence vault requires Linux storage ownership');
  await mkdir(this.root,{recursive:true,mode:0o700});
  const info=await lstat(this.root);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||await realpath(this.root)!==this.root)throw Error('Evidence root must be private and must not use symbolic links');
  // Linux abstract socket ownership is released by the kernel even on SIGKILL.
  const lock=createServer(socket=>socket.destroy());
  await new Promise((yes,no)=>{lock.once('error',no);lock.listen({path:'\0ainvr-evidence-'+sha(this.root)},()=>{lock.removeListener('error',no);yes();});});
  this.lock=lock;
  try{
   const identities=this.db.collection('alarm_storage_identity');
   await identities.updateOne({_id:'evidence'},{$setOnInsert:{uuid:randomUUID()}},{upsert:true});
   const owner=(await identities.findOne({_id:'evidence'})).uuid,marker=join(this.root,'.ainvr-evidence-v1');
   let stored;
   try{const st=await lstat(marker);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('Invalid evidence ownership marker');stored=JSON.parse(await readFile(marker,'utf8'));}
   catch(e){
    if(e.code!=='ENOENT')throw e;
    if((await readdir(this.root)).length)throw Error('Evidence root is not empty or owned');
    stored={schema_version:'1.0',owner};await writePrivate(marker,JSON.stringify(stored));await syncDirectory(this.root);
   }
   if(stored.schema_version!=='1.0'||stored.owner!==owner)throw Error('Evidence storage belongs to a different database');
   await this.rows.createIndex({state:1,next_attempt_at:1,queued_at:1});
   await this.rows.createIndex({state:1,occurred_at:1});
   // A previous writer is confirmed absent by the exclusive kernel lock.
   await this.rows.updateMany({state:'capturing'},{$set:{state:'pending',next_attempt_at:this.clock()}});
   for await(const row of this.rows.find({state:'deleting'}))await this.retire(row,row.reason??'retention');
   await this.reconcileFiles();
  }catch(e){await this.close();throw e;}
 }
 expires(row){return Date.parse(row.occurred_at)+this.policy.retention_days*day;}
 async enqueue(eventId,candidate){
  if(!this.policy.enabled)return;
  id(eventId);
  const now=this.clock(),expires=Date.parse(candidate.occurred_at)+this.policy.retention_days*day;
  const missing=!candidate.analysis_evidence?.source_frame_index;
  const full=await this.rows.countDocuments({state:{$in:['pending','capturing']}},{limit:10000})>=10000;
  const state=expires<=now?'expired':missing||full?'unavailable':'pending';
  await this.rows.updateOne({_id:eventId},{$setOnInsert:{event_id:eventId,occurred_at:candidate.occurred_at,queued_at:now,deadline:now+15*60000,next_attempt_at:now,attempts:0,state,
    reason:expires<=now?'retention':missing?'frame_identity_unavailable':full?'queue_capacity':null,files:[]}}, {upsert:true});
 }
 filePath(name){if(typeof name!=='string'||!filePattern.test(name))throw Error('Invalid managed evidence path');return join(this.root,name);}
 async reconcileFiles(){
  this.used=this.images?await this.images.bytes('crop'):0;
  for(const name of await readdir(this.root)){
   if(!filePattern.test(name)){if(name!=='.ainvr-evidence-v1')throw Error('Unexpected file in private evidence root');continue;}
   const path=this.filePath(name),st=await lstat(path);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('Unexpected evidence file ownership');
   const owner=await this.rows.findOne({_id:name.slice(0,64),state:'stored','files.name':name},{projection:{_id:1,files:1}});
   if(owner?.files?.some(f=>f.name===name&&f.storage==='mongodb'))continue; // Preserve migrated legacy files for rollback.
   if(owner)this.used+=st.size;else await unlink(path);
  }
  await syncDirectory(this.root);
 }
 validateFile(file,eventId){
  if(!file||!['processed','original'].includes(file.variant)||!file.name?.startsWith(eventId+'-'+file.variant+'-')||!Number.isInteger(file.bytes)||file.bytes<4||file.bytes>maximumImage||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid retained file binding');
  return this.filePath(file.name);
 }
 async retire(row,reason){
  await this.rows.updateOne({_id:row._id},{$set:{state:'deleting',reason}});
  for(const f of row.files??[]){
   if(f.storage==='mongodb'){await this.images.remove('crop',f.name);this.used=Math.max(0,this.used-f.bytes);continue;}
   try{const path=this.validateFile(f,row._id),st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('Unexpected evidence file');await unlink(path);this.used=Math.max(0,this.used-st.size);}
   catch(e){if(e.code!=='ENOENT')throw e;}
  }
  await syncDirectory(this.root);
  await this.rows.updateOne({_id:row._id},{$set:{state:'expired',reason,files:[],expired_at:new Date(this.clock()).toISOString()},$unset:{evidence:''}});
 }
 async maintain(required=0){
  for await(const row of this.rows.find({state:'deleting'}).limit(100))await this.retire(row,row.reason??'retention');
  const cutoff=new Date(this.clock()-this.policy.retention_days*day).toISOString();
  for await(const row of this.rows.find({state:{$in:['stored','pending','unavailable']},occurred_at:{$lte:cutoff}}).limit(100))await this.retire(row,'retention');
  for(let count=0;this.used+required>this.policy.max_bytes&&count<100;count++){
   const oldest=await this.rows.findOne({state:'stored'},{sort:{occurred_at:1,_id:1}});
   if(!oldest)break;await this.retire(oldest,'capacity');
  }
  return this.used+required<=this.policy.max_bytes;
 }
 tick(){if(this.inFlight)return this.inFlight;if(this.closing)return Promise.resolve();this.inFlight=this.step().finally(()=>{this.inFlight=null;});return this.inFlight;}
 async step(){
  if(this.needsRecovery){await this.rows.updateMany({state:'capturing'},{$set:{state:'pending',next_attempt_at:this.clock()}});await this.reconcileFiles();this.needsRecovery=false;}
  await this.maintain();
  if(!this.policy.enabled)return;
  const now=this.clock(),token=randomUUID(),row=await this.rows.findOneAndUpdate({state:'pending',next_attempt_at:{$lte:now}},{$set:{state:'capturing',capture_token:token},$inc:{attempts:1}},{sort:{queued_at:1,_id:1},returnDocument:'after'});
  if(!row)return;
  const written=[];
  try{
   if(this.expires(row)<=now){await this.retire(row,'retention');return true;}
   if(now>=row.deadline||row.attempts>20){await this.rows.updateOne({_id:row._id,state:'capturing',capture_token:token},{$set:{state:'unavailable',reason:'capture_timeout'}});return true;}
   const fact=await this.facts.findOne({event_id:row.event_id});if(!fact)throw Error('Fact unavailable');
   if(!this.source)throw Error('Evidence source unavailable');
   const metadata=await this.source.metadata(row.event_id);
   if(metadata?.state!=='available')throw Error('Exact source crop not available');
   const evidence=exactEvidence(metadata,fact),images=[];
   for(const variant of evidence.variants)images.push({variant,data:imageBuffer(await this.source.image(row.event_id,variant))});
   const size=images.reduce((sum,i)=>sum+i.data.length,0);
   if(!await this.maintain(size))throw Error('Evidence capacity unavailable');
   if(!this.images){const disk=await statfs(this.root);if(disk.bavail*disk.bsize<size+128*1024*1024)throw Error('SSD headroom insufficient');}
   for(const {variant,data} of images){
    const name=`${row.event_id}-${variant}-${randomUUID()}.jpg`;
    // Register before writing: partial writes are removed on ordinary failure.
    written.push({name,variant,bytes:data.length,sha256:sha(data),...(this.images?{storage:'mongodb'}:{})});
    if(this.images)await this.images.put('crop',name,data,{maxBytes:this.policy.max_bytes,retentionMs:this.policy.retention_days*day,occurredAt:row.occurred_at});
    else await writePrivate(this.filePath(name),data);
    this.used+=data.length;
   }
   await syncDirectory(this.root);
   await this.rows.updateOne({_id:row._id,state:'capturing',capture_token:token},{$set:{state:'stored',files:written,evidence,saved_at:new Date(this.clock()).toISOString(),reason:null}});
   this.lastError=null;
  }catch{
   const exhausted=this.clock()>=row.deadline||row.attempts>=20;
   // Fence any late/ambiguous publication before deleting its files. A timed-out
   // write may already have committed; in that case preserve the saved images.
   try{
    const fenced=await this.rows.findOneAndUpdate({_id:row._id,state:'capturing',capture_token:token},{$set:{state:exhausted?'unavailable':'pending',reason:exhausted?'capture_timeout':'capture_retry',next_attempt_at:this.clock()+Math.min(60000,5000*2**Math.min(row.attempts-1,4))}},{returnDocument:'after'});
    if(!fenced){const current=await this.rows.findOne({_id:row._id});if(current?.state==='stored'){this.lastError=null;return true;}throw Error('Uncertain evidence ownership');}
    for(const f of written){if(f.storage==='mongodb')await this.images.remove('crop',f.name);else await unlink(this.filePath(f.name)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    await syncDirectory(this.root);await this.reconcileFiles();
    this.lastError=exhausted?'capture_timeout':'capture_retry';
   }catch{this.needsRecovery=true;throw Error('Evidence storage recovery required');}
  }
  return true;
 }
 async metadata(eventId){
  id(eventId);const row=await this.rows.findOne({_id:eventId});
  if(!row)return {state:'not_queued'};
  if(row.state==='stored'&&this.expires(row)>this.clock()){
   for(const f of row.files){try{if(f.storage==='mongodb'){const meta=await this.images.metadata('crop',f.name);if(!meta||meta.bytes!==f.bytes||meta.sha256!==f.sha256)throw Error();continue;}const st=await lstat(this.validateFile(f,row._id));if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==f.bytes)throw Error();}catch{return {state:'unavailable',reason:'stored_file_missing'};}}
   return {state:'available',evidence:{...row.evidence,pinned:true,retention:'alarm',saved_at:row.saved_at,expires_at:new Date(this.expires(row)).toISOString()}};
  }
  return {state:['pending','capturing'].includes(row.state)?'pending':'unavailable',reason:this.expires(row)<=this.clock()?'retention':['pending','capturing'].includes(row.state)&&!this.policy.enabled?'capture_disabled':row.reason??'capture_retry'};
 }
 async image(eventId,variant){
  id(eventId);if(!['original','processed'].includes(variant))fail('invalid_variant','Invalid image variant');
  const row=await this.rows.findOne({_id:eventId,state:'stored'}),f=row?.files.find(f=>f.variant===variant);
  if(!row||!f||this.expires(row)<=this.clock())fail('evidence_unavailable','Retained evidence is unavailable',404);
  if(f.storage==='mongodb'){
   const data=await this.images?.get('crop',f.name);
   if(!data||data.length!==f.bytes||sha(data)!==f.sha256)fail('evidence_unavailable','Retained evidence failed integrity validation',404);
   return data;
  }
  let handle;
  try{
   handle=await open(this.validateFile(f,eventId),constants.O_RDONLY|constants.O_NOFOLLOW);
   const st=await handle.stat();if(!st.isFile()||st.nlink!==1||st.size!==f.bytes||st.size>maximumImage)throw Error();
   const data=imageBuffer(await handle.readFile());if(sha(data)!==f.sha256)throw Error();
   if(this.images){await this.images.put('crop',f.name,data,{maxBytes:this.policy.max_bytes,retentionMs:this.policy.retention_days*day,occurredAt:row.occurred_at});
    await this.rows.updateOne({_id:eventId,state:'stored'},{$set:{'files.$[file].storage':'mongodb'}},{arrayFilters:[{'file.name':f.name,'file.sha256':f.sha256}]});this.needsRecovery=true;}
   return data;
  }catch{fail('evidence_unavailable','Retained evidence failed integrity validation',404);}finally{await handle?.close();}
 }
 async status(){
  const counts=await this.rows.aggregate([{$group:{_id:'$state',count:{$sum:1}}}],{maxTimeMS:2000}).toArray();
  return {storage:this.images?'mongodb':'legacy-files',enabled:this.policy.enabled,retention_days:this.policy.retention_days,max_bytes:this.policy.max_bytes,used_bytes:this.used,counts:{pending:0,capturing:0,stored:0,expired:0,unavailable:0,...Object.fromEntries(counts.map(v=>[v._id,v.count]))},last_error:this.lastError};
 }
 run(){const work=async()=>{let busy=false;try{busy=await this.tick();}catch{this.lastError='storage_unavailable';}if(!this.closing)this.timer=setTimeout(work,busy?100:5000);};void work();}
 async close(){this.closing=true;clearTimeout(this.timer);await this.inFlight;if(this.lock){await new Promise((yes,no)=>this.lock.close(e=>e?no(e):yes()));this.lock=null;}}
}
