// Bounded reference-only evaluation of retained production alarm crops.
// Never updates alarms, review jobs, policies or validation credentials.
import {loadBootstrap,createConfigTransport} from '../../alarm-service/src/config-center.mjs';
import {EvidenceVault} from '../../alarm-service/src/evidence-vault.mjs';
import {reviewSamples} from '../../alarm-service/src/review-context.mjs';
import {MongoClient} from '../../alarm-service/node_modules/mongodb/lib/index.js';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const run=process.argv[2];if(!/^[a-z0-9-]{1,80}$/.test(run??''))throw Error('Run identifier required');
const out=resolve('test/results',run);await mkdir(out,{recursive:false,mode:0o700});
const bootstrap=await loadBootstrap('deploy/s100p/runtime/alarm-service-bootstrap.json');
const request=createConfigTransport(bootstrap);
const invoke=async body=>{
 const response=await fetch(new URL('/api/internal/alarm-review',bootstrap.control_url),{method:'POST',headers:{'x-service-token':bootstrap.service_token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
 const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result.error??{status:response.status}));return result;
};
const state=await request('service-states/alarm-service');
const config=(await request(`versions/${state.desiredVersion}/snapshot?service=alarm-service`))[0].config;
const client=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:5000});
const report={mode:'reference_only',input:'retained_original_target_crop_jpu_gles_letterbox_896x448',automatic_decisions:false,started_at:new Date().toISOString(),inventory:{},samples:[],limitations:['Historical crops do not restore missing behavior evidence.','Human confirmations are alarm-level labels, not independent image-level truth.','Unreviewed samples have no ground truth.']};
const save=()=>writeFile(out+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
const health=async()=>{try{return await(await fetch('http://127.0.0.1:8300/health',{signal:AbortSignal.timeout(5000)})).json()}catch{return {unavailable:true}}};
try{
 await client.connect();const db=client.db(config.database),alarms=db.collection('alarms');
 const rows=await alarms.find({}).sort({occurred_at:1,alarm_id:1}).limit(10000).toArray();
 report.inventory={total:rows.length,proof_complete:rows.filter(r=>reviewSamples(r).ok).length,human:rows.filter(r=>r.handling.reviewed_by_kind==='human').length};
 const vault=new EvidenceVault(db,{root:'/mnt/ainvr-ssd/ainvr-alarm-evidence/'+config.database,policy:config.evidence});
 report.before=await health();await save();
 const pick=a=>Array.from({length:Math.min(12,a.length)},(_,i)=>a[Math.floor(i*a.length/Math.min(12,a.length))]);
 const samples=[...pick(rows.filter(r=>r.handling.reviewed_by_kind==='human')),...pick(rows.filter(r=>r.handling.state==='unacknowledged'))];
 const deadline=Date.now()+10*60000;let consecutiveFailures=0;
 for(const row of samples){
  if(Date.now()>deadline||consecutiveFailures>=3){report.stopped='time_or_consecutive_failure_limit';break}
  const sample={alarm_id:row.alarm_id,occurred_at:row.occurred_at,human_result:row.handling.reviewed_by_kind==='human'?row.handling.disposition:null,proof:reviewSamples(row).reason??'complete'};
  const start=Date.now();
  try{
   const id=row.behavior_event_ids?.[0];const meta=await vault.metadata(id);
   if(meta.state!=='available'||!meta.evidence.variants.includes('original'))throw Error('original_crop_unavailable');
   if(meta.evidence.channel_id!==row.channel_id||meta.evidence.stream_session_id!==row.stream_session_id)throw Error('evidence_identity_mismatch');
   sample.dimensions=[meta.evidence.image_width,meta.evidence.image_height];const jpeg=await vault.image(id,'original');sample.image_sha256=createHash('sha256').update(jpeg).digest('hex');
   const label=row.analysis_evidence?.track?.class_name==='person'?'人':row.analysis_evidence?.track?.class_name;
   if(!label)throw Error('missing_label');
   const sourcePath=out+'/'+row.alarm_id+'-original.jpg',preparedPath=out+'/'+row.alarm_id+'-model.jpg';
   await writeFile(sourcePath,jpeg,{mode:0o600});
   await exec('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_image_probe',['retained',sourcePath,String(sample.dimensions[0]),String(sample.dimensions[1]),preparedPath],{timeout:15000,maxBuffer:65536});
   const prepared=await readFile(preparedPath);sample.model_input_sha256=createHash('sha256').update(prepared).digest('hex');
   const body={request_id:run+'-'+row.alarm_id.slice(0,16),image:{jpeg_base64:prepared.toString('base64'),fit:'strict'},alarm:{kind:label,description:`这是历史告警保留的目标特写。只判断图片中的指定目标是否确实是「${label}」，注意海报、屏幕和倒影。此测试不验证运动或越界行为。`}};
   sample.prompt=body.alarm;sample.result=await invoke(body,{timeoutMs:120000});
   if(!Number.isFinite(sample.result.real_score))throw Error('invalid_model_result');
   consecutiveFailures=0;
  }catch(e){sample.error=e.message;consecutiveFailures++}
  sample.elapsed_ms=Date.now()-start;report.samples.push(sample);await save();
  console.log(JSON.stringify({done:report.samples.length,score:sample.result?.real_score,error:sample.error,elapsed_ms:sample.elapsed_ms}));
  await new Promise(r=>setTimeout(r,1500));
 }
 report.after=await health();report.completed_at=new Date().toISOString();await save();
}finally{await client.close()}
