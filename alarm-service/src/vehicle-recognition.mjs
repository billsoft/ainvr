// Enrich existing passage facts; never create a second count.
import {createHash,randomUUID} from 'node:crypto';
import {DomainError} from './domain.mjs';
import {behaviorEvent} from './behavior-events.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const validPlate=s=>typeof s==='string'&&/^[京沪津渝冀晋蒙辽吉黑苏浙皖闽赣鲁豫鄂湘粤桂琼川贵云藏陕甘青宁新][A-Z](?:[A-Z0-9]{5,6}|[A-Z0-9]{4}[挂学警港澳])$/.test(s);
export function fusePlates(frames){
 const votes=new Map(),seen=new Set();let detected=0;
 for(const f of frames){if(seen.has(f.frame_key))continue;seen.add(f.frame_key);const list=f.result?.candidates??[];detected+=list.length;
  if(list.length!==1||list[0].status!=='candidate'||!validPlate(list[0].text))continue;
  const c=list[0],group=votes.get(c.text)??[];group.push({...c,frame_key:f.frame_key});votes.set(c.text,group);}
 const ranked=[...votes].sort((a,b)=>b[1].length-a[1].length);
 if(!ranked.length)return {state:detected?'unreadable':'plate_not_detected',text:null,frame_count:seen.size};
 const [text,items]=ranked[0];return {state:items.length>=2&&ranked.length===1?'consistent':ranked.length>1?'ambiguous':'single_frame',text,color_index:items.at(-1).color_index,support:items.length,frame_count:seen.size,model_scores_calibrated:false,frames:items.map(v=>v.frame_key)};
}
export const watchlistDigest=(version,entries)=>hash(JSON.stringify([version,entries.map(e=>e.plate).sort()]));
const MAX_WAIT_MS=60*60*1000;
const terminalCodes=new Set(['original_resolution_required','unsupported_image','target_too_small','missing_context','evidence_integrity_mismatch','evidence_expired','invalid_model_result']);
const inferenceCodes=new Set(['vehicle_inference_failed','invalid_model_result']);
function errorCode(error){
 const raw=error?.code??error?.message;
 return typeof raw==='string'&&/^[a-z_]{1,80}$/.test(raw)?raw:'dependency_unavailable';
}
export class VehicleRecognition {
 constructor(repository,{invoke,watchlist,clock=Date.now}={}){
  this.repository=repository;this.jobs=repository.db.collection('vehicle_recognition_jobs');
  this.invoke=invoke;this.readWatchlist=watchlist??invoke?.watchlist;this.clock=clock;
  this.config=null;this.closing=false;this.inFlight=null;this.locks=new Map();this.listCache=new Map();
 }
 async exclusive(id,work){
  const previous=this.locks.get(id)??Promise.resolve(),next=previous.catch(()=>{}).then(work);
  this.locks.set(id,next);try{return await next;}finally{if(this.locks.get(id)===next)this.locks.delete(id);}
 }
 async initialize(){await this.jobs.createIndex({state:1,next_at:1});await this.jobs.createIndex({expires_at:1},{expireAfterSeconds:0});}
 active(){return this.config&&this.config.expires_ms>this.clock()?this.config:null;}
 channels(){return this.active()?.channels??[];}
 configure(value){
  const now=this.clock(),list=value?.watchlist;
  if(!value||!Number.isSafeInteger(value.expires_ms)||value.expires_ms<=now||value.expires_ms>now+60000||!Number.isSafeInteger(value.issued_ms)||value.issued_ms>now+5000||value.issued_ms<now-60000||!Array.isArray(value.channels)||value.channels.length>32||!Array.isArray(value.counter_ids)||value.counter_ids.length>1000||!Number.isSafeInteger(list?.version)||list.version<0||typeof value.model_pin!=='string'||!/^[a-f0-9]{64}$/.test(value.model_pin))throw new DomainError('invalid_vehicle_configuration','Invalid vehicle configuration');
  if(value.authorized_channels!==undefined&&(!Array.isArray(value.authorized_channels)||value.authorized_channels.length>32))throw new DomainError('invalid_vehicle_configuration','Invalid configured channels');
  for(const id of [...value.channels,...value.counter_ids,...(value.authorized_channels??[])])if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))throw new DomainError('invalid_vehicle_configuration','Invalid vehicle identity');
  // Accept the previous wire format while upgrading. New event snapshots contain references only.
  if(list.entries){if(!Array.isArray(list.entries)||list.entries.length>500||list.entries.some(e=>!validPlate(e.plate)))throw new DomainError('invalid_vehicle_configuration','Invalid watchlist');
   list.digest=watchlistDigest(list.version,list.entries);this.cacheList(list);
  }
  if(typeof list.digest!=='string'||!/^[a-f0-9]{64}$/.test(list.digest))throw new DomainError('invalid_vehicle_configuration','Watchlist digest required');
  if(this.config&&value.issued_ms<this.config.issued_ms)throw new DomainError('stale_vehicle_configuration','Configuration changed',409);
  this.config=structuredClone({...value,watchlist:{version:list.version,digest:list.digest}});
  return {ready:!!this.invoke,channels:this.channels()};
 }
 cacheList(list){const key=list.version+':'+list.digest;this.listCache.set(key,structuredClone(list));while(this.listCache.size>32)this.listCache.delete(this.listCache.keys().next().value);}
 rules(rules,channel){const c=this.active();return rules.map(r=>c?.channels.includes(channel)&&c.counter_ids.includes(r.counter_id)?{...r,vehicle_capture:{model_pin:c.model_pin,watchlist:c.watchlist}}:r);}
 async enqueue(event){
  if(!event.rule.snapshot.vehicle_capture)return;
  const id=behaviorEvent(event).event_id,delivery=event.analysis_evidence.delivery;
  const frames=(delivery?.frames??[]).filter((s,i,a)=>a.findIndex(v=>v.key===s.key)===i).slice(-3);
  const count=await this.jobs.countDocuments({state:{$in:['pending','processing']}},{limit:1000});
  const state=count>=1000?'capacity_exceeded':delivery?.state==='complete'&&frames.length?'pending':'evidence_failed';
  const now=this.clock();
  await this.jobs.updateOne({_id:id},{$setOnInsert:{event,frames,state,phase:'recognition',next_at:0,attempts:0,inference_failures:0,results:[],created_at:now,deadline_at:now+MAX_WAIT_MS,expires_at:new Date(now+7*86400000)}},{upsert:true});
  await this.repository.behaviors.collection.updateOne({event_id:id,vehicle:{$exists:false}},{$set:{vehicle:{state,text:null,version:1}}});
 }
 enabled(job){const c=this.active();return !this.closing&&(c?.authorized_channels??c?.channels)?.includes(job.event.channel_id)&&c.model_pin===job.event.rule.snapshot.vehicle_capture.model_pin;}
 async changeJob(fence,update){const r=await this.jobs.updateOne(fence,update);if(!r.matchedCount)throw Error('lease_lost');}
 async saveResult(job,value){
  const resultKey=hash('vehicle-result:'+job._id+':'+value.model_pin);
  await this.repository.behaviors.collection.updateOne({event_id:job._id,'vehicle.corrected':{$ne:true},'vehicle.result_key':{$ne:resultKey}},[{$set:{vehicle:{$mergeObjects:[{$literal:{...value,result_key:resultKey,delivery:'pending'}},{version:{$add:[{$ifNull:['$vehicle.version',0]},1]}}]}}}]);
 }
 async failure(job,fence,error){
  const code=errorCode(error);if(code==='lease_lost')return;
  const phase=job.result?'delivery':'recognition';
  const attempts=(job.inference_failures??0)+(phase==='recognition'&&inferenceCodes.has(code)?1:0);
  const expired=this.clock()>=(job.deadline_at??job.created_at+MAX_WAIT_MS)||+job.expires_at<=this.clock();
  const cancelled=code==='configuration_changed';
  const terminal=cancelled||expired||phase==='recognition'&&(terminalCodes.has(code)||attempts>=3);
  const reason=cancelled?code:expired?'wait_expired':code;
  this.lastFailure={code:reason,phase,at:new Date(this.clock()).toISOString()};
  const delay=Math.min(60000,2000*2**Math.min(job.wait_count??0,5));
  await this.changeJob(fence,{$set:{state:terminal?'recognition_failed':'pending',phase,reason,inference_failures:attempts,next_at:this.clock()+delay},$inc:{wait_count:1},$unset:{lease_token:'',lease_until:''}});
  await this.exclusive(job._id,async()=>{
   // A storage/delivery failure must never erase a successful plate or reset its version.
   const filter={event_id:job._id,'vehicle.corrected':{$ne:true}};
   if(job.result){await this.repository.behaviors.collection.updateOne(filter,{$set:{'vehicle.delivery':terminal?'failed':'pending','vehicle.delivery_reason':reason}});}
   else await this.repository.behaviors.collection.updateOne({...filter,'vehicle.result_key':{$exists:false},'vehicle.state':{$nin:['consistent','single_frame','ambiguous','unreadable','plate_not_detected','human_corrected']}},{$set:{'vehicle.state':terminal?'recognition_failed':'waiting_runtime','vehicle.reason':reason},$inc:{'vehicle.version':1}});
  });
 }
 async step(){
  if(!this.invoke)return;
  const token=randomUUID(),now=this.clock();
  const job=await this.jobs.findOneAndUpdate({state:{$in:['pending','processing']},next_at:{$lte:now},$or:[{lease_until:{$exists:false}},{lease_until:{$lt:now}}]},{$set:{state:'processing',lease_token:token,lease_until:now+120000},$inc:{attempts:1}},{returnDocument:'after',sort:{next_at:1,created_at:1}});
  if(!job)return false;const fence={_id:job._id,lease_token:token};
  try{
   if(now>=(job.deadline_at??job.created_at+MAX_WAIT_MS)||+job.expires_at<=now)throw Error('wait_expired');
   if(!this.active())throw Error('vehicle_not_ready');if(!this.enabled(job))throw Error('configuration_changed');
   if(!job.result){
    if(!this.active()?.channels.includes(job.event.channel_id))throw Error('vehicle_not_ready');
    const results=[...(job.results??[])];
    for(const frame of job.frames){
     if(results.some(r=>r.frame_key===frame.key))continue;if(!this.active())throw Error('vehicle_not_ready');if(!this.enabled(job))throw Error('configuration_changed');
     const image=await this.repository.reviewContext.image(job.event,frame);
     if(image.width!==job.event.analysis_evidence.source.width||image.height!==job.event.analysis_evidence.source.height)throw Error('original_resolution_required');
     if(image.width%2||image.height%2||image.width*image.height>8*1024*1024)throw Error('unsupported_image');
     const b=frame.bbox,x=Math.max(0,Math.floor(b.x)),y=Math.max(0,Math.floor(b.y)),w=Math.min(image.width-x,Math.ceil(b.x+b.w)-x),h=Math.min(image.height-y,Math.ceil(b.y+b.h)-y);
     if(w<16||h<16)throw Error('target_too_small');
     const pin=job.event.rule.snapshot.vehicle_capture.model_pin;
     const inferenceStarted=this.clock();
     const result=await this.invoke({channel_id:job.event.channel_id,event_id:job._id,frame_key:frame.key,model_pin:pin,vehicle_roi:[x,y,w,h],jpeg_sha256:hash(image.data),expires_ms:this.clock()+30000},image.data);
     if(!this.active())throw Error('vehicle_not_ready');if(result.model_pin!==pin||!this.enabled(job))throw Error('configuration_changed');
     if(!Array.isArray(result.candidates)||result.candidates.length>4)throw Error('invalid_model_result');
     this.lastInferenceMs=Math.max(0,this.clock()-inferenceStarted);
     results.push({frame_key:frame.key,result});await this.changeJob(fence,{$set:{results,lease_until:this.clock()+120000}});
    }
    job.result={...fusePlates(results),model_pin:job.event.rule.snapshot.vehicle_capture.model_pin,updated_at:new Date(this.clock()).toISOString()};
    // Persist before publishing the result. Recovery resumes delivery, never inference.
    await this.changeJob(fence,{$set:{result:job.result,phase:'delivery',wait_count:0}});
   }
   await this.exclusive(job._id,async()=>{
    if(!this.active())throw Error('vehicle_not_ready');if(!this.enabled(job))throw Error('configuration_changed');
    await this.changeJob(fence,{$set:{lease_until:this.clock()+120000}});
    await this.saveResult(job,job.result);
    const outcome=job.result.state==='consistent'?await this.alarm(job,job.result):'not_applicable';
    await this.repository.behaviors.collection.updateOne({event_id:job._id},{$set:{'vehicle.delivery':outcome,'vehicle.delivery_reason':null}});
   });
   await this.changeJob(fence,{$set:{state:'complete',phase:'complete',finished_at:this.clock()},$unset:{lease_token:'',lease_until:'',reason:''}});
   this.lastWorkerError=null;
  }catch(error){await this.failure(job,fence,error);}
  return true;
 }
 async resolveList(policy){
  if(policy.entries)return policy; // Old durable jobs remain replayable.
  const key=policy.version+':'+policy.digest,cached=this.listCache.get(key);if(cached)return cached;
  if(!this.readWatchlist)throw Error('watchlist_unavailable');
  const list=await this.readWatchlist(policy.version);
  if(list.version!==policy.version||!Array.isArray(list.entries)||list.entries.length>500||watchlistDigest(list.version,list.entries)!==policy.digest)throw Error('watchlist_integrity_mismatch');
  this.cacheList({...list,digest:policy.digest});return list;
 }
 async alarm(job,value){
  const fact=await this.repository.behaviors.get(job._id);if(fact.vehicle?.corrected||fact.vehicle?.text!==value.text)return 'manual_override';
  const policy=await this.resolveList(job.event.rule.snapshot.vehicle_capture.watchlist);
  if(!policy.entries.some(v=>v.plate===value.text))return 'not_matched';
  if(!this.active())throw Error('vehicle_not_ready');if(!this.enabled(job))throw Error('configuration_changed');
  if(await this.repository.isCleared?.(job.event))return 'cleared';
  const event=structuredClone(job.event),id=hash('vehicle-watchlist:'+job._id+':'+policy.version);
  delete event.episode_id;delete event.episode_started_at;event.alarm_id=id;event.dedup_key=id;event.behavior_event_ids=[job._id];
  event.analysis_evidence.vehicle={...value,watchlist_version:policy.version,reason:'watchlist_match',passage_event_id:job._id};
  const started=this.clock();await this.repository.insert(event);await this.repository.evidenceVault?.enqueue(job._id,event);this.lastDeliveryMs=Math.max(0,this.clock()-started);return 'delivered';
 }
 async image(id,key){const job=await this.jobs.findOne({_id:id,expires_at:{$gt:new Date(this.clock())}});if(!job||!job.frames.some(f=>f.key===key))throw new DomainError('not_found','Vehicle evidence not found',404);return (await this.repository.reviewContext.image(job.event,job.frames.find(f=>f.key===key))).data;}
 async details(id){const fact=await this.repository.behaviors.get(id),job=await this.jobs.findOne({_id:id},{projection:{frames:1,results:1,state:1,phase:1,reason:1,expires_at:1}});
  return {event_id:id,vehicle:fact.vehicle??{state:'not_requested'},task:job?{state:job.state,phase:job.phase,reason:job.reason,retryable:!['pending','processing','complete'].includes(job.state)&&!!job.frames?.length&&+job.expires_at>this.clock()}:null,frames:job?.expires_at>new Date(this.clock())?(job.frames??[]).map(f=>({key:f.key,width:f.width,height:f.height,bbox:f.bbox,captured_at:f.captured_at})):[],candidates:job?.results??[]};}
 async retry(id,actor){return this.exclusive(id,async()=>{
  const job=await this.jobs.findOne({_id:id});if(!job||+job.expires_at<=this.clock())throw new DomainError('evidence_expired','Evidence retention expired',409);
  if(!this.enabled(job))throw new DomainError('vehicle_disabled','Enable the original channel and model before retry',409);
  if(!job.frames.length)throw new DomainError('evidence_missing','No retained evidence to retry',409);
  if(['pending','processing','complete'].includes(job.state))return this.details(id);
  if(await this.jobs.countDocuments({state:{$in:['pending','processing']}},{limit:1000})>=1000)throw new DomainError('vehicle_busy','Recognition queue is full',429);
  await this.jobs.updateOne({_id:id,state:job.state},{$set:{state:'pending',next_at:0,deadline_at:Math.min(+job.expires_at,this.clock()+MAX_WAIT_MS),inference_failures:0,wait_count:0,retried_by:actor},$unset:{lease_token:'',lease_until:'',reason:''}});
  await this.repository.behaviors.collection.updateOne({event_id:id,'vehicle.result_key':{$exists:false},'vehicle.corrected':{$ne:true},'vehicle.state':{$nin:['consistent','single_frame','ambiguous','unreadable','plate_not_detected','human_corrected']}},{$set:{'vehicle.state':'pending'},$inc:{'vehicle.version':1}});return this.details(id);
 });}
 async correct(id,body,actor){return this.exclusive(id,()=>this.correctLocked(id,body,actor));}
 async correctLocked(id,body,actor){if(!validPlate(body?.text)||!Number.isSafeInteger(body.version)||typeof actor!=='string')throw new DomainError('invalid_correction','Invalid plate correction',422);
  const before=await this.repository.behaviors.get(id);
  const result=await this.repository.behaviors.collection.updateOne({event_id:id,'vehicle.version':body.version},{$set:{'vehicle.text':body.text,'vehicle.state':'human_corrected','vehicle.corrected':true,'vehicle.corrected_by':actor,'vehicle.corrected_at':new Date(this.clock()).toISOString()},$inc:{'vehicle.version':1},$push:{vehicle_audit:{$each:[{actor,previous_text:before.vehicle?.text??null,text:body.text,version:body.version+1,at:new Date(this.clock()).toISOString()}],$slice:-100}}});
  if(!result.modifiedCount)throw new DomainError('version_conflict','Record changed; reload before correcting',409);return this.details(id);
 }
 async status(){const oldest=await this.jobs.find({state:{$in:['pending','processing']}}).sort({created_at:1}).limit(1).toArray();return {configured_channels:this.channels().length,processing:!!this.inFlight,pending:await this.jobs.countDocuments({state:{$in:['pending','processing']}},{limit:1032}),failed:await this.jobs.countDocuments({state:{$in:['recognition_failed','evidence_failed','capacity_exceeded']}},{limit:10000}),oldest_wait_ms:oldest.length?Math.max(0,this.clock()-oldest[0].created_at):0,last_worker_error:this.lastWorkerError??null,last_failure:this.lastFailure??null,last_inference_ms:this.lastInferenceMs??null,last_delivery_ms:this.lastDeliveryMs??null};}
 run(){const tick=()=>{if(this.closing)return;const started=this.clock();this.inFlight=this.step().catch(()=>{this.lastWorkerError={code:'vehicle_worker_unavailable',at:new Date(this.clock()).toISOString()};}).finally(()=>{this.inFlight=null;if(!this.closing){this.timer=setTimeout(tick,Math.max(100,1000-(this.clock()-started)));this.timer.unref();}});};tick();}
 async close(){this.closing=true;clearTimeout(this.timer);await this.inFlight;}
}
