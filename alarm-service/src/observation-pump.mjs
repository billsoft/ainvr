// Local SSD transport. Only durably consumed or explicitly ineligible records
// are removed; failed materialization stays at the head of its channel queue.
import {readdir,lstat,readFile,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,validateFrame,identity,integerText} from './domain.mjs';
import {EvidenceSpool} from './evidence-spool.mjs';
const recordName=/^[0-9]{20}\.json$/;
const rawHash=value=>createHash('sha256').update(value).digest('hex');
export function observationEnvelope(sample,rules){
  if(sample?.schema_version!=='1.0')throw Error('Unsupported observation journal');
  identity(sample.producer_id,'producer_id');integerText(sample.offset,'offset');
  identity(sample.channel_id,'channel_id');integerText(sample.source_frame_index,'source_frame_index');
  const catalog=sample.model?.label_catalog;
  if(catalog?.schema_version!=='1.0'||typeof catalog.adapter!=='string'||!Array.isArray(catalog.labels)||!catalog.labels.length||catalog.labels.length>128)throw Error('Invalid label catalog');
  const labels=catalog.labels.map((l,i)=>{
    if(l.class_id!==i||typeof l.name!=='string'||typeof l.description!=='string')throw Error('Invalid label mapping');
    identity(l.label_id,'label_id');return {class_id:l.class_id,label_id:l.label_id,name:l.name,description:l.description};
  });
  if(new Set(labels.map(l=>l.label_id)).size!==labels.length)throw Error('Duplicate labels');
  const labelVersion='labels-'+digest([catalog.adapter,labels]);
  // Accept an older primary catalogue only when every ID, name and description
  // is exactly preserved in the merged result. Never alias renamed prompt labels.
  const compatible=[];
  const oldCatalogs=sample.model.compatible_label_catalogs??[];
  if(!Array.isArray(oldCatalogs)||oldCatalogs.length>4)throw Error('Invalid compatible catalogs');
  for(const old of oldCatalogs){
    if(old?.schema_version!=='1.0'||typeof old.adapter!=='string'||!Array.isArray(old.labels)||!old.labels.length||old.labels.length>128)throw Error('Invalid compatible catalog');
    const rows=old.labels.map((l,i)=>{const clean={class_id:l.class_id,label_id:l.label_id,name:l.name,description:l.description};if(l.class_id!==i||!labels.some(n=>JSON.stringify(n)===JSON.stringify(clean)))throw Error('Incompatible label alias');return clean;});
    compatible.push({version:'labels-'+digest([old.adapter,rows]),label_ids:rows.map(l=>l.label_id)});
  }
  const compatibleVersion=version=>version===labelVersion||compatible.some(c=>c.version===version);
  const channelRules=rules.filter(r=>r.state==='enabled'&&r.channel_id===sample.channel_id);
  if(!channelRules.length)return {ignored:'no_active_monitor'};
  const bindings=channelRules.map(r=>r.source_binding);
  if(bindings.some(b=>!b))return {waiting:'source_binding_unavailable'};
  const matches=bindings.filter(b=>b.stream_fingerprint===rawHash(sample.stream_url)&&b.width===sample.width&&b.height===sample.height&&compatibleVersion(b.label_map_version));
  if(!matches.length)return {ignored:'source_binding_mismatch'};
  const eligible=matches.filter(b=>Number.isFinite(sample.timestamp)&&sample.timestamp*1000>=Date.parse(b.not_before));
  if(!eligible.length)return {ignored:'before_monitor_binding'};
  const distinct=new Set(eligible.map(b=>JSON.stringify([b.input_stream_id,b.geometry_revision])));
  if(distinct.size!==1)throw Error('Conflicting active source bindings');
  const binding=eligible[0];
  if(!Array.isArray(sample.tracks))throw Error('Invalid tracks');
  if(sample.observation_mode!==undefined&&!['tracks','detections'].includes(sample.observation_mode))throw Error('Invalid observation mode');
  if(sample.gap!==undefined&&typeof sample.gap!=='boolean')throw Error('Invalid observation gap');
  const detectionOnly=sample.observation_mode==='detections';
  if(detectionOnly&&(!Array.isArray(sample.detections)||sample.detections.length>4096||sample.tracks.length))throw Error('Invalid detections');
  // These IDs identify a real observation in ONE frame, never a tracked person.
  const observations=detectionOnly?sample.detections.map((d,i)=>({
    track_id:`detection:${sample.producer_id}:${sample.offset}:${i}`,identity_kind:'detection',
    label_id:d.label_id,bbox:d.bbox,state:'confirmed',observation:'detected',last_observed_pts_ns:sample.source_pts_ns,
  })):sample.tracks;
  const tracks=observations.map(t=>({...t,...(t.display_kind==='low_confidence'?{event_eligible:false}:{})}));
  const frame=validateFrame({schema_version:'1.0',channel_id:sample.channel_id,input_stream_id:binding.input_stream_id,
    stream_session_id:sample.stream_session_id,seq:sample.offset,
    frame_id:`${sample.stream_session_id}:${sample.source_frame_index}`,source_pts_ns:sample.source_pts_ns,source_frame_index:sample.source_frame_index,
    captured_at:new Date(sample.timestamp*1000).toISOString(),
    source:{width:sample.width,height:sample.height,coordinate_space:'source_pixels',geometry_revision:binding.geometry_revision},
    model:{id:sample.model.id,label_map_version:labelVersion,...(compatible.length?{compatible_label_versions:compatible}:{})},observation_mode:detectionOnly?'detections':'tracks',tracks,
    ...(sample.gap===true?{gap:true}:{}),
    ...(sample.evidence_delivery?{evidence_delivery:sample.evidence_delivery}:{})});
  if(frame.tracks.some(t=>!labels.some(l=>l.label_id===t.label_id)))throw Error('Unknown track label');
  return {envelope:{schema_version:'1.0',producer_id:sample.producer_id,offset:sample.offset,frame}};
}
export class ObservationPump {
  constructor(root,consumer,repository){
    if(!path.isAbsolute(root)||root.length>4096)throw Error('Absolute observation root required');
    this.root=root;this.consumer=consumer;this.repository=repository;this.stopping=false;this.concurrency=8;this.running=null;this.issues=new Map();this.blockedLog=new Map();this.pendingDirectorySyncs=new Set();
    this.status={state:'waiting',pending:0,consumed:0,ignored:0,failed:0,last_error:null,last_persisted_at:null,channel_issues:[]};
  }
  tick(){if(this.running)return this.running;this.running=this.scan().finally(()=>{this.running=null});return this.running;}
  async scan(){
    let directories;
    try{
      const info=await lstat(this.root);if(info.isSymbolicLink()||!info.isDirectory())throw Error('Invalid journal root');
      directories=await readdir(this.root,{withFileTypes:true});
    }catch(e){this.status.state=e.code==='ENOENT'?'waiting':'degraded';this.status.last_error=e.code==='ENOENT'?'journal_not_started':'journal_unavailable';return;}
    const snapshot=await this.repository.ruleSnapshots.current();
    if(!snapshot){this.status.state='waiting';this.status.last_error='rules_not_configured';return;}
    if(this.reconciledRevision!==snapshot.revision){await this.repository.reconcileActivities?.(snapshot);this.reconciledRevision=snapshot.revision;}
    let pending=0,failed=false;
    // Channels are independent (one lease and checkpoint each): consume them
    // concurrently so their syncs and journaled Mongo commits overlap, while each
    // channel stays strictly ordered. One-at-a-time capped ALL channels together
    // near 19 frames/s (8 channels x 3 FPS needs 24).
    const channelDirectories=directories.filter(d=>d.isDirectory()&&/^[a-f0-9]{64}$/.test(d.name));
    const consumeChannel=async directory=>{
      const folder=path.join(this.root,directory.name);
      const records=(await readdir(folder)).filter(n=>recordName.test(n)).sort();pending+=records.length;
      // Fair bounded batches keep one busy channel from starving another.
      let step='read',sample,reason,removed=false;
      for(const name of records.slice(0,100)){
        if(this.stopping)break;
        const file=path.join(folder,name);
        try{
          step='read';reason=null;sample=null;
          const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('Invalid journal file');
          sample=JSON.parse(await readFile(file,'utf8'));
          if(name!==sample.offset.padStart(20,'0')+'.json'||rawHash(sample.channel_id)!==directory.name)throw Error('Journal identity mismatch');
          step='convert';
          const converted=observationEnvelope(sample,snapshot.rules);
          if(converted.waiting){reason=converted.waiting;throw Error('Source binding not configured');}
          if(converted.envelope){step='consume';const result=await this.consumer.consume(converted.envelope,{deferAcknowledgement:true});if(result.durable!==true)throw Error('Consumption not durable');this.status.consumed++;this.status.last_persisted_at=new Date().toISOString();}
          else {this.status.ignored++;this.status.last_ignored_reason=converted.ignored;
            if(this.repository.reviewContext?.root)await new EvidenceSpool(this.repository.reviewContext.root).acknowledge(sample,{defer:true});
          }
          if(converted.ignored==='source_binding_mismatch')this.rememberIssue(directory.name,sample,'source_binding_mismatch','ignored');
          else this.issues.delete(directory.name);
          step='acknowledge';
          await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
          removed=true;
          pending--;
        }catch(e){
          if(e.code==='ENOENT')continue;
          this.status.failed++;failed=true;this.status.last_error='record_not_consumed';
          if(!reason)this.logBlocked(directory.name,sample,step,e);
          this.rememberIssue(directory.name,sample,reason??(step==='consume'?'processing_unavailable':step==='acknowledge'?'acknowledgement_pending':'invalid_observation'),'blocked');
          break;
        }
      }
      // Consumption is already durable and idempotent. Batch directory sync
      // only for deletion ACKs (at most 100 records/channel); after a crash,
      // reappearing records replay the existing checkpoint, never new alarms.
      if(removed)this.pendingDirectorySyncs.add(directory.name);
      if(this.pendingDirectorySyncs.has(directory.name))try{
        // Evidence ACKs of this batch become durable before the deletions do.
        await this.consumer.flushAcknowledgements?.();
        if(this.repository.reviewContext?.root)await new EvidenceSpool(this.repository.reviewContext.root).flushAcknowledgements();
        await this.syncDirectory(folder);
        this.pendingDirectorySyncs.delete(directory.name);
        if(this.issues.get(directory.name)?.reason==='acknowledgement_pending')this.issues.delete(directory.name);
      }
      catch{this.status.failed++;failed=true;this.status.last_error='acknowledgement_pending';this.rememberIssue(directory.name,sample,'acknowledgement_pending','blocked');}
    };
    const queue=[...channelDirectories];
    await Promise.all(Array.from({length:Math.min(this.concurrency,queue.length)},async()=>{
      for(let directory;!this.stopping&&(directory=queue.shift());)await consumeChannel(directory);
    }));
    const present=new Set(directories.filter(d=>d.isDirectory()).map(d=>d.name));
    for(const key of this.issues.keys())if(!present.has(key))this.issues.delete(key);
    for(const key of this.pendingDirectorySyncs)if(!present.has(key))this.pendingDirectorySyncs.delete(key);
    this.status.channel_issues=[...this.issues.values()];
    this.status.pending=pending;this.status.state=failed||this.issues.size?'degraded':'ready';
    if(!failed)this.status.last_error=this.issues.size?'source_binding_mismatch':null;
  }
  async syncDirectory(folder){const handle=await open(folder,'r');try{await handle.sync();}finally{await handle.close();}}
  // The status API only carries a coarse reason. Write the real cause to the service log, once per
  // channel when it changes and at most once a minute while it lasts (the scan retries every 100 ms).
  logBlocked(key,sample,step,error){
    const cause=`${step}:${error?.code??''}:${error?.message??''}`.slice(0,300),last=this.blockedLog.get(key),now=Date.now();
    if(last?.cause===cause&&now-last.at<60000)return;
    this.blockedLog.delete(key);this.blockedLog.set(key,{cause,at:now});
    while(this.blockedLog.size>128)this.blockedLog.delete(this.blockedLog.keys().next().value);
    process.stderr.write(JSON.stringify({at:new Date(now).toISOString(),event:'observation_blocked',service:'alarm-service',
      channel_id:typeof sample?.channel_id==='string'?sample.channel_id.slice(0,256):null,step,
      error:String(error?.message??error).slice(0,200),...(error?.code!==undefined?{code:String(error.code).slice(0,64)}:{})})+'\n');
  }
  rememberIssue(key,sample,reason,state){
    this.issues.delete(key);
    const captured=new Date(Number.isFinite(sample?.timestamp)?sample.timestamp*1000:Number.NaN);
    this.issues.set(key,{channel_id:typeof sample?.channel_id==='string'&&sample.channel_id.length<=256?sample.channel_id:null,
      reason,state,detected_at:new Date().toISOString(),
      source_captured_at:Number.isFinite(captured.getTime())?captured.toISOString():null});
    while(this.issues.size>128)this.issues.delete(this.issues.keys().next().value);
  }
  run(){const next=async()=>{if(this.stopping)return;try{await this.tick();}catch{this.status.state='degraded';this.status.failed++;this.status.last_error='journal_scan_failed';}if(!this.stopping){this.timer=setTimeout(next,100);this.timer.unref();}};void next();}
  async close(){this.stopping=true;clearTimeout(this.timer);await this.running;}
}
