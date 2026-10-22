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
 constructor(repository,root){this.repository=repository;this.root=resolve(root);if(!this.root.startsWith('/mnt/ainvr-ssd/'))throw Error('SSD context required');this.lastPolicy=0;this.lastMaintenance=0;this.closing=false;this.inFlight=null;}
 async initialize(){await mkdir(join(this.root,'pinned'),{recursive:true,mode:0o700});}
 async publish(){
  if(Date.now()-this.lastPolicy<5000)return;this.lastPolicy=Date.now();
  const snapshot=await this.repository.ruleSnapshots.current();
  const channels=[...new Set((snapshot?.rules??[]).filter(r=>r.review?.enabled&&r.alarm_enabled!==false).map(r=>r.channel_id))];
  const path=join(this.root,'enabled.json');await writeFile(path+'.tmp',JSON.stringify({channels,expires_at:Math.floor(Date.now()/1000)+20}),{mode:0o600});await rename(path+'.tmp',path);
 }
 async maintain(){
  if(Date.now()-this.lastMaintenance<60000)return;this.lastMaintenance=Date.now();
  const root=join(this.root,'pinned'),files=[];let size=0;
  for(const name of await readdir(root)){if(!/^[a-f0-9]{64}\.jpg$/.test(name))continue;const s=await stat(join(root,name));files.push({name,size:s.size,at:s.mtimeMs});size+=s.size;}
  files.sort((a,b)=>a.at-b.at);
  for(const f of files)if(f.at<Date.now()-7*86400000||size>1024**3){await unlink(join(root,f.name));size-=f.size;}
 }
 // Pin the start/entry images before an eventual exit alarm is produced. This
 // runs off the ingestion path and survives restart via durable checkpoints.
 async pinActive(){
  if(!this.repository.checkpoints)return;
  const cursor=this.repository.checkpoints.find({'checkpoint.review_source':{$exists:true}},
   {projection:{'checkpoint.review_source':1,'checkpoint.states':1}});
  const candidates=[];
  for await(const doc of cursor){
   const cp=doc.checkpoint,source=cp.review_source;
   for(const state of Object.values(cp.states??{})){
    if(!state.traversal?.entry&&!state.candidate&&state.seen_since===undefined)continue;
    const trace=state.review_trace??[];
    for(const sample of trace.slice(0,2)){
     if(!sample.event_eligible||sample.observation!=='detected')continue;
     candidates.push([{...source,analysis_evidence:{source:source.source}},sample]);
    }
   }
  }
  const start=(this.pinOffset??0)%Math.max(1,candidates.length),count=Math.min(64,candidates.length);
  for(let i=0;i<count;i++){try{await this.image(...candidates[(start+i)%candidates.length]);}catch{/* Retry pending captures next tick. */}}
  this.pinOffset=start+count;
 }
 async step(){
  await this.publish();await this.maintain();await this.pinActive();
  const rows=await this.repository.events.find({'handling.state':'unacknowledged','review.state':'queued','review.context_state':{$exists:false}}).sort({occurred_at:1}).limit(100).toArray();
  for(const row of rows){
   const proof=reviewSamples(row),fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'review.context_state':{$exists:false}};
   if(!proof.ok){await this.repository.events.updateOne(fence,{$set:{'review.state':'uncertain','review.reason':proof.reason,'review.context_state':'incomplete'}});continue;}
   try{
    const frames=[];for(const s of proof.samples){const {key}=await this.image(row,s);frames.push({...s,key});}
    await this.repository.events.updateOne(fence,{$set:{'review.context_state':'ready','review.frames':frames}});
   }catch{
    if(Date.now()-Date.parse(row.last_seen_at)>30000)await this.repository.events.updateOne(fence,{$set:{'review.state':'uncertain','review.reason':'missing_context','review.context_state':'incomplete'}});
   }
  }
 }
 tick(){if(this.inFlight)return this.inFlight;if(this.closing)return Promise.resolve();this.inFlight=this.step().finally(()=>{this.inFlight=null});return this.inFlight;}
 run(){const work=async()=>{try{await this.tick()}catch{}if(!this.closing)this.timer=setTimeout(work,1000)};void work();}
 async close(){this.closing=true;clearTimeout(this.timer);await this.inFlight;}
 async retained(alarmId,key){
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('missing_context');
  const row=await this.repository.events.findOne({alarm_id:alarmId,'review.frames.key':key});if(!row)throw Error('missing_context');
  const data=await readFile(join(this.root,'pinned',key+'.jpg'));if(data.length>8*1024*1024)throw Error('missing_context');return data;
 }
 async image(row,sample){
  const key=contextKey(row,sample),dest=join(this.root,'pinned',key+'.jpg');
  let data;
  try{data=await readFile(dest);}catch{
   const meta=JSON.parse(await readFile(join(this.root,key+'.json'),'utf8'));
   for(const [k,v] of Object.entries({channel_id:row.channel_id,stream_session_id:row.stream_session_id,source_pts_ns:sample.source_pts_ns,source_frame_index:sample.source_frame_index,frame_width:row.analysis_evidence.source.width,frame_height:row.analysis_evidence.source.height}))if(meta[k]!==v)throw Error('missing_context');
   data=await readFile(join(this.root,key+'.jpg'));if(data.length>8*1024*1024)throw Error('missing_context');
   await writeFile(dest+'.tmp',data,{mode:0o600});await rename(dest+'.tmp',dest);
  }
  if(data.length<4||data.length>8*1024*1024||data[0]!==255||data[1]!==216)throw Error('missing_context');return {key,data,...jpegDimensions(data)};
 }
}
