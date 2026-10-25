// Production reference executor, independent of the core alarm consumer.
import {loadBootstrap,createConfigTransport} from './config-center.mjs';
import {validateConfig} from './runtime.mjs';
import {createReviewTransport} from './review-transport.mjs';
import {EvidenceVault} from './evidence-vault.mjs';
import {ReviewContext} from './review-context.mjs';
import {ReferenceReviewWorker} from './reference-review.mjs';
import {MongoClient} from 'mongodb';
import {mkdir,writeFile,readFile,unlink,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
if(process.argv.length!==4)throw Error('Bootstrap and hardware preparation executable required');
const bootstrap=await loadBootstrap(process.argv[2]),request=createConfigTransport(bootstrap),invoke=createReviewTransport(bootstrap);
let prunedAt=0;
const context=new ReviewContext({},'/mnt/ainvr-ssd/ainvr-review-frames');
const tool=process.argv[3],root='/mnt/ainvr-ssd/ainvr-review-frames/reference';
await mkdir(root,{recursive:true,mode:0o700});let stop=false,client,currentVersion,worker,runtime;
process.on('SIGTERM',()=>{stop=true});process.on('SIGINT',()=>{stop=true});
try{while(!stop){
 try{
  const state=await request('service-states/alarm-service');
  if(currentVersion!==state.appliedVersion){
   const docs=await request(`versions/${state.appliedVersion}/snapshot?service=alarm-service`);
   const config=validateConfig({...docs[0].config,schema_version:'1.0',version:state.appliedVersion,operation_id:`reference-${state.appliedVersion}`});
   if(client)await client.close();client=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:5000,maxPoolSize:2});await client.connect();
   const db=client.db(config.database);runtime=db.collection('alarm_reference_runtime');const rows=db.collection('alarms'),vault=new EvidenceVault(db,{root:'/mnt/ainvr-ssd/ainvr-alarm-evidence/'+config.database,policy:config.evidence});
   await rows.createIndex({'handling.state':1,'review.reference.state':1,occurred_at:1});
   worker=new ReferenceReviewWorker({rows,invoke,image:async row=>{
    const id=row.behavior_event_ids?.[0];if(!/^[a-f0-9]{64}$/.test(id??''))throw Error('missing_evidence');
    const meta=await vault.metadata(id),e=meta.evidence;
    if(['pending','not_queued'].includes(meta.state))throw Error('evidence_pending');
    if(meta.state!=='available'||!e.variants.includes('original'))throw Error('missing_evidence');
    if(e.channel_id!==row.channel_id||e.stream_session_id!==row.stream_session_id||e.track_id!==row.track_ids?.[0]||e.source_pts_ns!==row.source_pts_ns||e.source_frame_index!==row.analysis_evidence?.source_frame_index)throw Error('evidence_identity_mismatch');
    if(e.image_width<32||e.image_height<32)throw Error('insufficient_target_pixels');
    const track=row.analysis_evidence?.track;
    const label=row.rule?.snapshot?.labels?.find(l=>l.label_id===track?.label_id)?.name??(track?.class_name==='person'?'人':track?.class_name);
    if(!label||label.length>100)throw Error('missing_label');
    let data;try{data=await vault.image(id,'original')}catch{throw Error('missing_evidence')}
    return {data,width:e.image_width,height:e.image_height,label,sha256:sha(data)};
   },prepare:async(row,original)=>{
    if(!/^[a-f0-9]{64}$/.test(row.alarm_id))throw Error('invalid_request');
    if(Date.now()-prunedAt>60000){await context.prunePool('reference',128*1024**2,7*86400000);prunedAt=Date.now()}
    const input=root+'/'+row.alarm_id+'.source.tmp',output=root+'/'+row.alarm_id+'.prepared.tmp';
    try{
     await writeFile(input,original.data,{mode:0o600});
     await exec(tool,['retained',input,String(original.width),String(original.height),output],{timeout:15000,maxBuffer:65536});
     const data=await readFile(output),key=sha(data);await rename(output,root+'/'+key+'.jpg');return {data,key,sha256:key};
    }finally{await unlink(input).catch(()=>{});await unlink(output).catch(()=>{})}
   }});currentVersion=state.appliedVersion;
  }
  await runtime.updateOne({_id:'reference'},{$set:{expires_at:Date.now()+180000,mode:'reference_only',last_tick:new Date().toISOString()}},{upsert:true});
  const worked=await worker.step();process.stdout.write(JSON.stringify({at:new Date().toISOString(),event:worked?'reference_job_processed':'reference_queue_idle'})+'\n');
 }catch{process.stderr.write(JSON.stringify({at:new Date().toISOString(),event:'reference_worker_unavailable'})+'\n')}
 if(!stop)await new Promise(r=>setTimeout(r,3000));
}}finally{await runtime?.updateOne({_id:'reference'},{$set:{expires_at:0}}).catch(()=>{});await client?.close()}
