// Local SSD transport. Only durably consumed or explicitly ineligible records
// are removed; failed materialization stays at the head of its channel queue.
import {readdir,lstat,readFile,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,validateFrame,identity,integerText} from './domain.mjs';
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
  const channelRules=rules.filter(r=>r.state==='enabled'&&r.channel_id===sample.channel_id);
  if(!channelRules.length)return {ignored:'no_active_monitor'};
  const bindings=channelRules.map(r=>r.source_binding);
  if(bindings.some(b=>!b))return {waiting:'source_binding_unavailable'};
  const matches=bindings.filter(b=>b.stream_fingerprint===rawHash(sample.stream_url)&&b.width===sample.width&&b.height===sample.height&&b.label_map_version===labelVersion);
  if(!matches.length)return {ignored:'source_binding_mismatch'};
  const eligible=matches.filter(b=>Number.isFinite(sample.timestamp)&&sample.timestamp*1000>=Date.parse(b.not_before));
  if(!eligible.length)return {ignored:'before_monitor_binding'};
  const distinct=new Set(eligible.map(b=>JSON.stringify([b.input_stream_id,b.geometry_revision])));
  if(distinct.size!==1)throw Error('Conflicting active source bindings');
  const binding=eligible[0];
  if(!Array.isArray(sample.tracks))throw Error('Invalid tracks');
  if(sample.observation_mode!==undefined&&!['tracks','detections'].includes(sample.observation_mode))throw Error('Invalid observation mode');
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
    model:{id:sample.model.id,label_map_version:labelVersion},observation_mode:detectionOnly?'detections':'tracks',tracks});
  if(frame.tracks.some(t=>!labels.some(l=>l.label_id===t.label_id)))throw Error('Unknown track label');
  return {envelope:{schema_version:'1.0',producer_id:sample.producer_id,offset:sample.offset,frame}};
}
export class ObservationPump {
  constructor(root,consumer,repository){
    if(!path.isAbsolute(root)||root.length>4096)throw Error('Absolute observation root required');
    this.root=root;this.consumer=consumer;this.repository=repository;this.stopping=false;this.running=null;this.issues=new Map();
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
    for(const directory of directories){
      if(this.stopping)break;
      if(!directory.isDirectory()||!/^[a-f0-9]{64}$/.test(directory.name))continue;
      const folder=path.join(this.root,directory.name);
      const records=(await readdir(folder)).filter(n=>recordName.test(n)).sort();pending+=records.length;
      // Fair bounded batches keep one busy channel from starving another.
      let step='read',sample,reason;
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
          if(converted.envelope){step='consume';const result=await this.consumer.consume(converted.envelope);if(result.durable!==true)throw Error('Consumption not durable');this.status.consumed++;this.status.last_persisted_at=new Date().toISOString();}
          else {this.status.ignored++;this.status.last_ignored_reason=converted.ignored;}
          if(converted.ignored==='source_binding_mismatch')this.rememberIssue(directory.name,sample,'source_binding_mismatch','ignored');
          else this.issues.delete(directory.name);
          step='acknowledge';
          await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
          const handle=await open(folder,'r');try{await handle.sync();}finally{await handle.close();}
          pending--;
        }catch(e){
          if(e.code==='ENOENT')continue;
          this.status.failed++;failed=true;this.status.last_error='record_not_consumed';
          this.rememberIssue(directory.name,sample,reason??(step==='consume'?'processing_unavailable':step==='acknowledge'?'acknowledgement_pending':'invalid_observation'),'blocked');
          break;
        }
      }
    }
    const present=new Set(directories.filter(d=>d.isDirectory()).map(d=>d.name));
    for(const key of this.issues.keys())if(!present.has(key))this.issues.delete(key);
    this.status.channel_issues=[...this.issues.values()];
    this.status.pending=pending;this.status.state=failed||this.issues.size?'degraded':'ready';
    if(!failed)this.status.last_error=this.issues.size?'source_binding_mismatch':null;
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
