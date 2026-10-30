import {EvidenceImages} from './evidence-images.mjs';
import {retainedTarget} from './retained-target.mjs';
import {selectVisualEvidence,missingVisual} from './review-visual-evidence.mjs';
import {isStorageBusy} from './review-storage.mjs';
import {recordingFailureReason} from './recording-evidence.mjs';
import {compactProof} from './compact-evidence.mjs';
import {readFile,mkdir,writeFile,rename,stat,unlink,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {evaluate} from './engine.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function contextKey(row,sample){return hash([row.channel_id,row.stream_session_id,sample.source_pts_ns,sample.source_frame_index].join('\n'));}
// The production evaluator is the only behavior oracle. Replay never invokes a
// model or performs I/O; disabling review avoids collecting a second trace.
export function reviewSamples(row){
 const c=row.analysis_evidence?.review_context,r=row.rule?.snapshot;
 if(c?.schema_version==='2.0')return compactProof(row);
 const trace=c?.trace;
 const no=reason=>({ok:false,reason,samples:[]});
 if(!r||!Array.isArray(trace)||!trace.length)return no('missing_trajectory');
 if(r.erp_wrap)return no('panorama_review_unavailable');
 if(c.truncated)return no('incomplete_trajectory');
 if(trace.at(-1).frame_id!==row.frame_id)return no('incomplete_trajectory');
 for(let i=1;i<trace.length;i++){try{if(BigInt(trace[i].seq)<=BigInt(trace[i-1].seq)||BigInt(trace[i].source_pts_ns)<=BigInt(trace[i-1].source_pts_ns))return no('incomplete_trajectory');}catch{return no('incomplete_trajectory');}}
 if(trace.some(s=>s.track_id!==row.track_ids?.[0]||s.label_id!==row.analysis_evidence.track.label_id||s.seq==null||s.source_frame_index==null))return no('incomplete_trajectory');
 let cp=null,matched;
 try{
  for(const s of trace){
   const f={schema_version:'1.0',channel_id:row.channel_id,input_stream_id:row.input_stream_id,
    stream_session_id:row.stream_session_id,seq:s.seq,frame_id:s.frame_id,source_frame_index:s.source_frame_index,
    source_pts_ns:s.source_pts_ns,captured_at:s.captured_at,source:row.analysis_evidence.source,model:row.model_snapshot,
    tracks:[{track_id:s.track_id,label_id:s.label_id,state:'confirmed',observation:s.observation,
      event_eligible:s.event_eligible,bbox:s.bbox,...(s.predicted_bbox?{predicted_bbox:s.predicted_bbox}:{}),
      last_observed_pts_ns:s.last_observed_pts_ns??s.source_pts_ns}]};
   const result=evaluate(cp,f,[{...r,review:{enabled:false}}]);cp=result.checkpoint;
   matched??=result.events.find(e=>e.frame_id===row.frame_id&&e.behavior===row.behavior);
  }
 }catch{return no('incomplete_trajectory');}
 if(!matched)return no('geometry_unconfirmed');
 if(JSON.stringify(matched.direction)!==JSON.stringify(row.direction))return no('geometry_unconfirmed');
 const real=trace.filter(s=>s.observation==='detected'&&s.event_eligible);
 const last=real.find(s=>s.frame_id===row.frame_id);if(!last)return no('missing_trajectory');
 let samples=[last];
 if(r.behavior==='region_traverse'){
  const tr=matched.analysis_evidence.traversal,recorded=row.analysis_evidence.traversal;
  if(!tr||tr.observation_gaps!==0||JSON.stringify(tr)!==JSON.stringify(recorded))return no('incomplete_trajectory');
  const i=real.findIndex(s=>s.frame_id===tr.entry.frame_id);
  if(i<1)return no('missing_entry');samples=[real[i-1],real[i],last];
 }else if(r.behavior==='region_enter'){
  const trigger=real.findIndex(s=>s.seq===matched.analysis_evidence.first_seq);
  if(trigger<1)return no('missing_entry');samples=[real[trigger-1],real[trigger],last];
 }else if(real.length>1)samples=[real[0],last];
 return {ok:true,samples:[...new Map(samples.map(s=>[s.frame_id,s])).values()],
  verification:{method:'production_evaluator_replay',behavior:r.behavior,rule_id:r.id,rule_version:r.version,
   direction:matched.direction,first_seq:matched.analysis_evidence.first_seq,trigger_seq:matched.analysis_evidence.trigger_seq}};
}
export function jpegDimensions(data){
 let p=2;
 while(p+4<=data.length){
  if(data[p++]!==255)throw Error('missing_context');
  while(data[p]===255)p++;const marker=data[p++];
  if(marker===0xda||marker===0xd9)break;
  if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
  const length=data.readUInt16BE(p);if(length<2||p+length>data.length)break;
  if(marker===0xc0&&length>=8)return {width:data.readUInt16BE(p+5),height:data.readUInt16BE(p+3)};
  p+=length;
 }
 throw Error('unsupported_image');
}
export class ReviewContext {
 constructor(repository,root,{clock=()=>Date.now()}={}){this.clock=clock;this.lastError=null;this.repository=repository;this.images=repository.db?new EvidenceImages(repository.db):null;this.root=resolve(root);if(!this.root.startsWith('/mnt/ainvr-ssd/'))throw Error('SSD context required');this.lastPolicy=0;this.lastMaintenance=0;this.closing=false;this.inFlight=null;}
 async initialize(){await this.images?.initialize();for(const dir of ['pinned','candidates'])await mkdir(join(this.root,dir),{recursive:true,mode:0o700});}
 async publish(){
  if(Date.now()-this.lastPolicy<1000)return;this.lastPolicy=Date.now();
  const snapshot=await this.repository.ruleSnapshots.current();
  const channels=[...new Set((snapshot?.rules??[]).filter(r=>r.review?.enabled&&r.alarm_enabled!==false).map(r=>r.channel_id))];
  const jobs=this.repository.captureJobs?await this.repository.captureJobs.find({state:'queued',created_at:{$gt:Date.now()-30000}}).sort({created_at:1}).limit(128).toArray():[];
  const retained_keys=jobs.map(job=>contextKey(job,job.sample));
  const path=join(this.root,'enabled.json');await writeFile(path+'.tmp',JSON.stringify({channels,retained_keys,expires_at:Math.floor(Date.now()/1000)+20}),{mode:0o600});await rename(path+'.tmp',path);
 }
 async maintain(){
  if(Date.now()-this.lastMaintenance<60000)return;this.lastMaintenance=Date.now();
  if(this.images){await this.images.prune('candidate',this.policy?.candidate_max_bytes??128*1024**2,24*3600000);await this.images.prune('context',this.policy?.max_bytes??1024**3,(this.policy?.retention_days??7)*86400000);return;}
  await this.prunePool('candidates',this.policy?.candidate_max_bytes??128*1024**2,24*3600000);
  await this.prunePool('pinned',this.policy?.max_bytes??1024**3,(this.policy?.retention_days??7)*86400000);
 }
 async prunePool(pool,maxBytes,maxAge){
  const root=join(this.root,pool),files=[];let size=0;
  for(const name of await readdir(root)){if(!/^[a-f0-9]{64}\.jpg$/.test(name))continue;const s=await stat(join(root,name));files.push({name,size:s.size,at:s.mtimeMs});size+=s.size;}
  files.sort((a,b)=>a.at-b.at);
  for(const f of files)if(f.at<Date.now()-maxAge||size>maxBytes){await unlink(join(root,f.name));size-=f.size;}
 }
 async processCaptureJobs(){
  const jobs=this.repository.captureJobs;if(!jobs)return;
  const rows=await jobs.find({state:'queued',next_at:{$lte:Date.now()}}).sort({created_at:1}).limit(64).toArray();
  for(const job of rows){try{
   await this.image({...job,analysis_evidence:{source:job.source}},job.sample,true);
   await jobs.updateOne({_id:job._id},{$set:{state:'done',finished_at:new Date()}});
  }catch{
   const expired=Date.now()-job.created_at>30000;
   await jobs.updateOne({_id:job._id},{$set:{state:expired?'missing':'queued',last_error:'exact_frame_unavailable',last_attempt_at:new Date(),next_at:Date.now()+500,...(expired?{finished_at:new Date()}: {})}});
  }}
 }
 async step(){
  await this.publish();await this.processCaptureJobs();
  const now=this.clock();
  const rows=await this.repository.events.find({'handling.state':'unacknowledged','review.state':'queued','review.context_state':{$exists:false},$or:[{'review.context_next_at':{$exists:false}},{'review.context_next_at':{$lte:now}}]}).sort({occurred_at:1}).limit(100).toArray();
  for(const row of rows){
   const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'review.context_state':{$exists:false},'handling.state':'unacknowledged','handling.revision':row.handling.revision};
   const started=row.review.context_started_at??now;
   try{
    const proof=reviewSamples(row);
    if(!proof.ok){await this.repository.events.updateOne(fence,{$set:{'review.state':'uncertain','review.reason':proof.reason,'review.context_state':'incomplete'},$inc:{version:1}});continue;}
    if(row.review.context_started_at==null)await this.repository.events.updateOne(fence,{$set:{'review.context_started_at':started}});
    await this.ready(row,fence,await this.prepareInputs(row,proof));
    this.lastError=null;
   }catch(error){
    // A busy database is not evidence that the source image never existed.
    let patch;
    if(missingVisual(error)){
     if(now-started<=30000)continue;
     patch={'review.state':'uncertain','review.reason':'missing_context','review.context_state':'incomplete'};
    }else if(['evidence_identity_mismatch','evidence_integrity_mismatch','insufficient_target_pixels','unsupported_image','incomplete_trajectory','missing_label'].includes(error.message)){
     patch={'review.state':'uncertain','review.reason':error.message,'review.context_state':'incomplete'};
    }else if(isStorageBusy(error)){
     const retries=Math.min(20,Math.max(0,Number.isSafeInteger(row.review.context_storage_retries)?row.review.context_storage_retries:0)+1);
     patch={'review.reason':'storage_busy','review.context_storage_retries':retries,'review.context_next_at':now+Math.min(300000,5000*2**Math.min(retries-1,6))};
    }else{
     const attempts=Math.min(3,Math.max(0,Number.isSafeInteger(row.review.context_failures)?row.review.context_failures:0)+1);
     patch={'review.reason':attempts>=3?'evidence_preparation_failed':'evidence_preparation_retry','review.context_failures':attempts,
      ...(attempts>=3?{'review.state':'failed','review.context_state':'incomplete'}:{'review.context_next_at':now+1000*2**(attempts-1)})};
    }
    this.lastError=patch['review.reason'];
    // Do not persist exception text: a driver/tool error can contain paths or credentials.
    await this.repository.events.updateOne(fence,{$set:patch,$inc:{version:1}});
   }
  }
  // Preserve expiring source frames before scanning and pruning SSD pools.
  await this.maintain();
 }
 tick(){if(this.inFlight)return this.inFlight;if(this.closing)return Promise.resolve();this.inFlight=this.step().finally(()=>{this.inFlight=null});return this.inFlight;}
 async prepareInputs(row,proof=reviewSamples(row)){
  return selectVisualEvidence(row,proof,{image:s=>this.image(row,s),retained:()=>retainedTarget(this.repository.evidenceVault,row)});
 }
 async ready(row,fence,plan,requeue=false){
  const frames=[];
  for(const item of plan.items){
   this.validateRetained(item.data,[]);
   if(item.source_kind==='retained_target')await this.images.put('context',item.key,item.data,this.imagePolicy(row));
   frames.push({...item.sample,key:item.key,content_sha256:hash(item.data),...(this.images?{storage:'mongodb'}:{}),source_kind:item.source_kind,
    ...(item.source_kind==='retained_target'?{width:item.width,height:item.height,crop_event_id:item.event_id}:{})});
  }
  return this.repository.events.updateOne(fence,{$set:{'review.context_state':'ready','review.reason':null,'review.context_next_at':0,'review.frames':frames,
   'review.evidence_mode':plan.mode,'review.missing_frame_ids':plan.missing_frame_ids,'review.visual_recovery_version':1,
   ...(requeue?{'review.state':'queued','review.reason':null,'review.attempt':0,'review.next_attempt_at':0,'review.recovery.state':'visual_completed','review.recovery.method':'retained_evidence','review.recovery.reason':null,'review.recovery.completed_at':new Date().toISOString()}:{})},
   ...(requeue?{$inc:{version:1}}:{})});
 }
 async recoverOne(){
  if(!this.images)return;
  const now=Date.now();
  const row=await this.repository.events.findOneAndUpdate({'handling.state':'unacknowledged','review.policy.enabled':true,'review.reason':'missing_context','review.context_state':'incomplete',occurred_at:{$gte:new Date(now-7*86400000).toISOString()},$and:[{$or:[{'review.recovery.attempt':{$not:{$gte:6}}},{'review.visual_recovery_version':{$ne:1}}]},{$or:[{'review.recovery.next_at':{$exists:false}},{'review.recovery.next_at':{$lte:now}}]}]},{$set:{'review.recovery.state':'running','review.recovery.next_at':now+300000},$inc:{'review.recovery.attempt':1}},{sort:{occurred_at:-1},returnDocument:'after'});
  if(!row)return;
  const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'handling.revision':row.handling.revision,'handling.state':'unacknowledged','review.context_state':'incomplete'};
  try{
   const proof=reviewSamples(row);if(!proof.ok)throw Error('incomplete_trajectory');
   try{
    const plan=await this.prepareInputs(row,proof);await this.ready(row,fence,plan,true);
    return;
   }catch(error){if(!missingVisual(error))throw error;}
   if(row.review.recovery.attempt>6||!this.recoverEvidence)throw Error('recording_evidence_unavailable');
   const frames=[];
   for(const sample of proof.samples){
    if(!await this.repository.events.findOne(fence,{projection:{alarm_id:1}}))return;
    let image,provenance=(row.review.recovery?.frames??[]).find(f=>f.key===contextKey(row,sample))?.provenance;
    try{image=await this.image(row,sample);}catch{
     const recovered=await this.recoverEvidence(row,sample);this.validateRetained(recovered.data,[]);
     const key=contextKey(row,sample);await this.images.put('context',key,recovered.data,this.imagePolicy(row));
     image={key,data:recovered.data};provenance=recovered.provenance;
     await this.repository.events.updateOne(fence,{$push:{'review.recovery.frames':{key,provenance}}});
    }
    frames.push({...sample,key:image.key,content_sha256:hash(image.data),storage:'mongodb',...(provenance?{provenance}:{})});
   }
   await this.repository.events.updateOne(fence,{$set:{'review.frames':frames,'review.context_state':'ready','review.state':'queued','review.reason':null,'review.attempt':0,'review.next_attempt_at':0,'review.recovery.state':'completed','review.recovery.method':'recording_exact_sei_v1','review.recovery.reason':null,'review.recovery.completed_at':new Date().toISOString()},$inc:{version:1}});
  }catch(error){
   if(isStorageBusy(error)){
    await this.repository.events.updateOne(fence,{$set:{'review.recovery.state':'queued','review.recovery.reason':'storage_busy','review.recovery.next_at':Date.now()+30000},$inc:{'review.recovery.attempt':-1,version:1}});return;
   }
   await this.repository.events.updateOne(fence,{$set:{'review.visual_recovery_version':1,'review.recovery.state':row.review.recovery.attempt>=6?'unavailable':'queued','review.recovery.reason':error.message==='incomplete_trajectory'?'incomplete_trajectory':recordingFailureReason(error),'review.recovery.next_at':Date.now()+Math.min(300000,30000*2**row.review.recovery.attempt)},$inc:{version:1}});
  }
 }
 run(){const recovery=async()=>{if(this.closing)return;this.recoveryFlight=this.recoverOne().catch(()=>{});await this.recoveryFlight;if(!this.closing)this.recoveryTimer=setTimeout(recovery,10000);};void recovery();const work=async()=>{try{await this.tick()}catch(error){this.lastError=isStorageBusy(error)?'storage_busy':'evidence_preparation_failed'}if(!this.closing)this.timer=setTimeout(work,1000)};void work();}
 async close(){this.closing=true;clearTimeout(this.timer);clearTimeout(this.recoveryTimer);await Promise.allSettled([this.inFlight,this.recoveryFlight]);}
 async status(){
  let cache=null;try{cache=JSON.parse(await readFile(join(this.root,'cache-status.json'),'utf8'));}catch{}
  const rows=this.repository.captureJobs?await this.repository.captureJobs.aggregate([{$group:{_id:'$state',count:{$sum:1}}}],{maxTimeMS:2000}).toArray():[];
  return {capture_counts:Object.fromEntries(rows.map(r=>[r._id,r.count])),cache,last_error:this.lastError,retention_days:this.policy?.retention_days??7,max_bytes:this.policy?.max_bytes??1024**3};
 }
 async savePrepared(row,sample,image){
  if(!['target-crop-v1','context-marked-v1'].includes(image.layout)||typeof image.jpeg_base64!=='string'||image.jpeg_base64.length>2*1024*1024)throw Error('invalid_model_result');
  const data=Buffer.from(image.jpeg_base64,'base64');jpegDimensions(data);
  const key=hash(data),path=join(this.root,'pinned',key+'.jpg');
  if(this.images)await this.images.put('context',key,data,this.imagePolicy(row));
  else {await writeFile(path+'.tmp',data,{mode:0o600});await rename(path+'.tmp',path);}
  const meta={frame_id:sample.frame_id,key,...(this.images?{storage:'mongodb',content_sha256:key}:{}),layout:image.layout,target:image.target,width:image.width,height:image.height,...(image.layout==='target-crop-v1'?{expansion:image.expansion}:{region:image.region,approach_width_fraction:image.approach_width_fraction,fit:image.fit})};
  const field=image.layout==='context-marked-v1'?'review.context_frames':'review.prepared_frames';
  await this.repository.events.updateOne({alarm_id:row.alarm_id,'review.generation':row.review.generation},{$addToSet:{[field]:meta}});
  return meta;
 }
 async retained(alarmId,key){
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('missing_context');
  const row=await this.repository.events.findOne({alarm_id:alarmId,$or:[{'review.frames.key':key},{'review.prepared_frames.key':key},{'review.context_frames.key':key}]});if(!row)throw Error('missing_context');
  let data=this.images?await this.images.get('context',key):null;
  const refs=['frames','prepared_frames','context_frames'].flatMap(field=>row.review?.[field]??[]).filter(f=>f.key===key);
  if(!data){
   if(refs.some(f=>f.storage==='mongodb'))throw Error('missing_context');
   data=await readFile(join(this.root,'pinned',key+'.jpg'));
   if(this.images){this.validateRetained(data,refs);await this.images.put('context',key,data,this.imagePolicy(row));await this.markMongo(row,key);}
  }
  this.validateRetained(data,refs);return data;
 }
 // Candidate captures never consume the retention quota of actual alarms.
 // A frame is copied into pinned only when an alarm references it.
 imagePolicy(row,candidate=false){return {maxBytes:candidate?(this.policy?.candidate_max_bytes??128*1024**2):(this.policy?.max_bytes??1024**3),retentionMs:candidate?86400000:(this.policy?.retention_days??7)*86400000,occurredAt:row.occurred_at??row.sample?.captured_at};}
 validateRetained(data,refs){if(data.length>8*1024**2||refs.some(f=>(f.content_sha256??(f.layout?f.key:null))&&(f.content_sha256??f.key)!==hash(data)))throw Error('evidence_integrity_mismatch');jpegDimensions(data);}
 async markMongo(row,key){
  for(const field of ['frames','prepared_frames','context_frames'])if(row.review?.[field]?.some(f=>f.key===key))
   await this.repository.events.updateOne({alarm_id:row.alarm_id,'review.generation':row.review.generation},{$set:{[`review.${field}.$[frame].storage`]:'mongodb'}},{arrayFilters:[{'frame.key':key}]});
 }
 async mongoImage(row,sample,candidate){
  const key=contextKey(row,sample),pool=candidate?'candidate':'context';
  let data=await this.images.get(pool,key);
  if(!data){
   const known=row.review?.frames?.find(f=>f.key===key);
   if(known?.storage==='mongodb')throw Error('missing_context');
   if(!candidate)data=await this.images.get('candidate',key);
   // Read-only legacy compatibility. No new retained image files are written.
   for(const dir of candidate?['candidates']:['pinned','candidates'])if(!data){try{data=await readFile(join(this.root,dir,key+'.jpg'));}catch(e){if(e.code!=='ENOENT')throw e;}}
   if(!data){
    const raw='/dev/shm/ainvr-review-frames';
    if(Date.now()-(await stat(join(raw,key+'.jpg'))).mtimeMs>60000)throw Error('missing_context');
    const meta=JSON.parse(await readFile(join(raw,key+'.json'),'utf8'));
    for(const [k,v] of Object.entries({channel_id:row.channel_id,stream_session_id:row.stream_session_id,source_pts_ns:sample.source_pts_ns,source_frame_index:sample.source_frame_index,frame_width:row.analysis_evidence.source.width,frame_height:row.analysis_evidence.source.height}))if(meta[k]!==v)throw Error('missing_context');
    data=await readFile(join(raw,key+'.jpg'));
   }
   this.validateRetained(data,known?[known]:[]);
   await this.images.put(pool,key,data,this.imagePolicy(row,candidate));
   if(!candidate)await this.markMongo(row,key);
  }
  this.validateRetained(data,(row.review?.frames??[]).filter(f=>f.key===key));
  return {key,data,...jpegDimensions(data)};
 }
 async image(row,sample,candidate=false){
  if(this.images)return this.mongoImage(row,sample,candidate);
  const key=contextKey(row,sample),dest=join(this.root,candidate?'candidates':'pinned',key+'.jpg');
  let data;
  try{data=await readFile(dest);}catch{
   if(!candidate){try{data=await readFile(join(this.root,'candidates',key+'.jpg'));}catch{}}
   if(!data){
   // Read-only compatibility for frames captured before the v2 rolling cache upgrade.
   let raw='/dev/shm/ainvr-review-frames';try{await stat(join(raw,key+'.json'));}catch{raw=this.root;}
   if(raw.startsWith('/dev/shm/')&&Date.now()-(await stat(join(raw,key+'.jpg'))).mtimeMs>60000)throw Error('missing_context');
   const meta=JSON.parse(await readFile(join(raw,key+'.json'),'utf8'));
   for(const [k,v] of Object.entries({channel_id:row.channel_id,stream_session_id:row.stream_session_id,source_pts_ns:sample.source_pts_ns,source_frame_index:sample.source_frame_index,frame_width:row.analysis_evidence.source.width,frame_height:row.analysis_evidence.source.height}))if(meta[k]!==v)throw Error('missing_context');
   data=await readFile(join(raw,key+'.jpg'));if(data.length>8*1024*1024)throw Error('missing_context');
   }
   jpegDimensions(data);
   if(candidate){const limit=this.policy?.candidate_max_bytes??128*1024**2;if(data.length>limit)throw Error('missing_context');await this.prunePool('candidates',limit-data.length,24*3600000);}
   await writeFile(dest+'.tmp',data,{mode:0o600});await rename(dest+'.tmp',dest);
  }
  const expected=row.review?.frames?.find(f=>f.key===key)?.content_sha256;
  if(expected&&hash(data)!==expected)throw Error('evidence_integrity_mismatch');
  if(data.length<4||data.length>8*1024*1024||data[0]!==255||data[1]!==216)throw Error('missing_context');return {key,data,...jpegDimensions(data)};
 }
}
