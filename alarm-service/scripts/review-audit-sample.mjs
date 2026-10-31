#!/usr/bin/env node
// AINVR: read-only existing-alarm sampling and offline labeled evaluation.
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFile,open,realpath,stat} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const MAX_CAP=10000,MAX_SAMPLE=1000,MAX_BYTES=32*1024*1024,MAX_TIME_MS=10000;
const sha=value=>createHash('sha256').update(value).digest('hex');
const problem=message=>{throw Object.assign(Error(message),{auditSafe:true})};
export function utc(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))problem('Use an explicit UTC ISO instant ending Z');
 const stamp=Date.parse(value);if(!Number.isFinite(stamp)||new Date(stamp).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))problem('Invalid UTC instant');
 return new Date(stamp).toISOString();
}
export function options(input){
 const start=utc(input.start),end=utc(input.end),sampleSize=Number(input.sampleSize),cap=Number(input.cap);
 if(start>=end)problem('start must precede end');
 if(!Number.isInteger(cap)||cap<1||cap>MAX_CAP||!Number.isInteger(sampleSize)||sampleSize<1||sampleSize>MAX_SAMPLE||sampleSize>cap)problem('Require sampleSize 1..1000 <= cap 1..10000');
 const seed=input.seed??randomBytes(32).toString('hex');
 if(typeof seed!=='string'||!/^[a-f0-9]{64}$/.test(seed))problem('seed must be 32-byte lowercase hex');
 return {start,end,sampleSize,cap,seed};
}
export function aiFalsePositive(log){
 return log?.action==='ai_review'&&log.actor==='ai-review'&&
  (log.secondary?.outcome==='false_positive'||log.disposition==='false_positive'||/; false_positive$/.test(log.note??''));
}
export function candidateFilter(o){
 const original={action:'ai_review',actor:'ai-review',$or:[{'secondary.outcome':'false_positive'},{disposition:'false_positive'},{note:{$regex:'; false_positive$'}}]};
 return {occurred_at:{$gte:o.start,$lt:o.end},$or:[{logs:{$elemMatch:original}},{'handling.reviewed_by_kind':'ai','handling.disposition':'false_positive'}]};
}
export function manifest(rows,input,{startedAt=new Date().toISOString(),finishedAt=new Date().toISOString()}={}){
 const o=options(input);if(rows.length>o.cap)problem('population_cap_exceeded: narrow UTC interval or raise explicit cap; no truncated sample');
 const ids=new Set(),eligible=[],excluded=[];
 for(const row of rows){
  if(typeof row.alarm_id!=='string'||!row.alarm_id||ids.has(row.alarm_id))problem('Missing or duplicate alarm identity');ids.add(row.alarm_id);
  const audit=(row.logs??[]).filter(aiFalsePositive).at(-1);
  if(!audit){excluded.push({alarm_id:row.alarm_id,reason:'no_retained_ai_false_positive_audit'});continue}
  const proof={model_sha256:audit.model?.package_sha256??null,decision_basis:audit.decision_basis??null,secondary_version:audit.secondary?.version??null,authorization_id:audit.authorization_id??null,evidence_generation:audit.evidence_generation??null};
  eligible.push({alarm_id:row.alarm_id,occurred_at:row.occurred_at,version:row.version??null,ai_original_verdict:{disposition:'false_positive',audit,proof},
   current_handling:row.handling??null,human_override_linkage:{current_human_handling:row.handling?.reviewed_by_kind==='human'?row.handling:null,subsequent_audit_entries:(row.logs??[]).slice((row.logs??[]).indexOf(audit)+1)},
   details:{alarm_id:row.alarm_id,api_relative_path:`/alarms/events/${encodeURIComponent(row.alarm_id)}`,instructions:'Open existing authenticated Alarm Center detail by alarm ID; no invented browser deep link.'},
   review_metadata:{state:row.review?.state??null,decision_basis:row.review?.decision_basis??null,frame_scores:row.review?.frame_scores??[],secondary:row.review?.secondary??null,required_frame_ids:row.review?.required_frame_ids??[]}});
 }
 eligible.sort((a,b)=>a.alarm_id<b.alarm_id?-1:1);
 const populationIds=eligible.map(row=>row.alarm_id),N=eligible.length;
 const ranked=eligible.map(row=>({...row,selection_rank:createHmac('sha256',Buffer.from(o.seed,'hex')).update(row.alarm_id).digest('hex')})).sort((a,b)=>a.selection_rank.localeCompare(b.selection_rank)||a.alarm_id.localeCompare(b.alarm_id));
 const k=Math.min(o.sampleSize,N);
 const output={schema:'ainvr.review-audit-sample.v1',read_only:true,automatic_verdict:false,qualification:false,started_at:startedAt,finished_at:finishedAt,
  interval:{field:'occurred_at',start_inclusive:o.start,end_exclusive:o.end},selection:{algorithm:'hmac-sha256-lowest-k-v1',seed:o.seed,cap:o.cap,requested_sample_size:o.sampleSize,N,sample_size:k,inclusion_probability:N?k/N:null,population_ids_sha256:sha(JSON.stringify(populationIds)),candidate_count:rows.length,excluded_count:excluded.length,excluded},
  selected_ids:ranked.slice(0,k).map(row=>row.alarm_id),samples:ranked.slice(0,k),limitations:[
   'Uniform pseudorandom hash ranking within observed retained auditable AI false-positive alarms, not all alarms or all real people. Negligible hash ties use alarm ID ordering.',
   'Human-overridden original AI false positives remain eligible. Missing original audit is explicitly excluded; deleted/expired alarms or truncated audit history cannot be recovered.',
   'Interval uses alarm occurrence time, not AI decision time. Live reads are bounded but not an atomic historical snapshot.',
   'This selection is not a labeled accuracy estimate, representative dataset certification, model qualification, or authorization for automatic decisions.']};
 if(Buffer.byteLength(JSON.stringify(output))>MAX_BYTES)problem('manifest_too_large');return output;
}
export async function sampleCollection(collection,input){
 const o=options(input),startedAt=new Date().toISOString(),rows=[];let bytes=0;
 const cursor=collection.find(candidateFilter(o),{projection:{_id:0,alarm_id:1,occurred_at:1,version:1,handling:1,logs:1,'review.state':1,'review.decision_basis':1,'review.frame_scores':1,'review.secondary':1,'review.required_frame_ids':1},maxTimeMS:MAX_TIME_MS}).sort({alarm_id:1}).limit(o.cap+1).batchSize(100);
 try{for await(const row of cursor){rows.push(row);if(rows.length>o.cap)problem('population_cap_exceeded: no truncated sample');bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>MAX_BYTES)problem('population_bytes_exceeded: narrow interval')}}finally{await cursor.close()}
 return manifest(rows,o,{startedAt,finishedAt:new Date().toISOString()});
}
export function wilson(success,total){
 if(!Number.isInteger(success)||!Number.isInteger(total)||success<0||success>total)problem('Invalid binomial counts');
 if(!total)return null;const z=1.959963984540054,p=success/total,d=1+z*z/total,mid=(p+z*z/(2*total))/d,half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
 return {success,total,rate:p,lower:Math.max(0,mid-half),upper:Math.min(1,mid+half),confidence:.95,method:'Wilson score'};
}
export function evaluate(rows,{datasetId,labelProvenance,inputSha256=null}={}){
 if(!datasetId?.trim()||!labelProvenance?.trim())problem('dataset-id and label-provenance required');
 if(rows.length>10000)problem('evaluation_row_cap_exceeded');
 const ids=new Set(),profiles=new Map();
 for(const row of rows){
  if(typeof row.alarm_id!=='string'||!row.alarm_id||ids.has(row.alarm_id))problem('Missing or duplicate evaluation alarm identity');ids.add(row.alarm_id);
  if(!['handled','false_positive'].includes(row.predicted_disposition)||!['person','non_person','unclear',null,undefined].includes(row.gold))problem('Invalid prediction or gold label');
  if(!/^[a-f0-9]{64}$/.test(row.model_sha256??'')||typeof row.gate_version!=='string'||!row.gate_version.trim()||row.gate_version.length>256)problem('model_sha256 and gate_version proof required per row');
  const key=JSON.stringify([row.model_sha256,row.gate_version]);
  if(!profiles.has(key))profiles.set(key,{model_sha256:row.model_sha256,gate_version:row.gate_version,rows:0,labeled:0,unlabeled:0,unclear:0,confusion:{real_person_kept:0,real_person_dismissed:0,non_person_kept:0,non_person_dismissed:0}});
  const p=profiles.get(key);p.rows++;
  if(row.gold==null){p.unlabeled++;continue}if(row.gold==='unclear'){p.unclear++;continue}p.labeled++;
  const label=row.gold==='person'?'real_person':'non_person',decision=row.predicted_disposition==='false_positive'?'dismissed':'kept';p.confusion[`${label}_${decision}`]++;
 }
 const results=[...profiles.values()].map(p=>{
  const c=p.confusion,people=c.real_person_kept+c.real_person_dismissed,nonPeople=c.non_person_kept+c.non_person_dismissed,dismissed=c.real_person_dismissed+c.non_person_dismissed;
  return {...p,insufficient_labels:p.labeled<30||!people||!nonPeople,false_dismiss_among_labeled_real_people:wilson(c.real_person_dismissed,people),real_person_share_among_labeled_dismissals:wilson(c.real_person_dismissed,dismissed)};
 });
 return {schema:'ainvr.review-audit-evaluation.v1',read_only:true,inference:false,qualification:false,dataset:{id:datasetId,label_provenance:labelProvenance,input_sha256:inputSha256,representativeness_verified:false,independence_verified:false},rows:rows.length,insufficient_labels:!results.length||results.some(p=>p.insufficient_labels),profiles:results,limitations:[
  'Gold person/non_person labels must be independently adjudicated; unclear and missing labels are excluded from rates and reported separately.',
  'Wilson intervals assume independent Bernoulli observations; repeated tracks, cameras, correlated episodes, selective labeling and dataset shift violate this assumption.',
  'An AI-false-positive-only audit estimates labeled error within that cohort; it cannot estimate overall recall, specificity or deployment accuracy.',
  'Thirty labels and both classes are a minimal reporting warning threshold, not a statistical qualification criterion. Zero observed errors is not proof of zero risk.',
  'Version fields are supplied provenance, not independently attested model execution. No automatic verdict, certification, authorization or schedule is created.']};
}
export async function writeManifest(path,value){
 const target=resolve(path),parent=await realpath(dirname(target)),ssd=await realpath('/mnt/ainvr-ssd');
 if(!parent.startsWith(ssd+'/')||parent.includes('/.git/')||(await stat(ssd)).dev===(await stat('/mnt')).dev)problem('Output parent must already exist on mounted SSD outside repository');
 const repo=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
 if(parent===repo||parent.startsWith(repo+'/'))problem('Output cannot be inside tracked repository');
 const body=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(body)>MAX_BYTES)problem('manifest_too_large');
 const handle=await open(join(parent,target.split('/').at(-1)),'wx',0o600);
 try{await handle.writeFile(body);await handle.sync()}finally{await handle.close()}
}
function parseArgs(args){
 const mode=args.shift();if(!['sample','evaluate','--help'].includes(mode))problem('Use sample, evaluate or --help');
 const flags={};for(let i=0;i<args.length;i+=2){const name=args[i];if(!name.startsWith('--')||!args[i+1]||args[i+1].startsWith('--')||name in flags)problem('Expected unique --option value pairs');flags[name]=args[i+1]}
 const allowed=mode==='sample'?['--start','--end','--sample-size','--cap','--seed','--bootstrap','--output']:['--input','--dataset-id','--label-provenance','--output'];
 for(const name of Object.keys(flags))if(!allowed.includes(name))problem('Unknown option');return {mode,flags};
}
async function main(){
 const {mode,flags:f}=parseArgs(process.argv.slice(2));
 if(mode==='--help'){console.log('sample --start UTC --end UTC --sample-size N --cap N [--seed 64hex] [--bootstrap path] --output existing-SSD-parent/new.json\nevaluate --input labels.jsonl --dataset-id ID --label-provenance TEXT --output existing-SSD-parent/new.json');return}
 if(!f['--output'])problem('Explicit operator-selected --output required');
 let result;
 if(mode==='sample'){
  const o=options({start:f['--start'],end:f['--end'],sampleSize:f['--sample-size'],cap:f['--cap'],seed:f['--seed']});
  const {loadBootstrap,createConfigTransport}=await import('../src/config-center.mjs');
  const {MongoClient}=await import('mongodb');
  const req=createConfigTransport(await loadBootstrap(f['--bootstrap']??'/home/sunrise/ainvr/deploy/s100p/runtime/alarm-service-bootstrap.json'));
  const state=await req('service-states/alarm-service'),docs=await req(`versions/${state.desiredVersion}/snapshot?service=alarm-service`);
  if(!Array.isArray(docs)||docs.length!==1||!docs[0].config?.mongo_uri||!docs[0].config.database)problem('Invalid config snapshot');
  const config=docs[0].config,client=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:15000});
  try{await client.connect();result=await sampleCollection(client.db(config.database).collection('alarms'),o)}finally{await client.close()}
 }else{
  if(!f['--input'])problem('input required');const info=await stat(f['--input']);if(!info.isFile()||info.size>MAX_BYTES)problem('Input must be a bounded JSONL file');
  const input=await readFile(f['--input'],'utf8');const rows=input.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
  result=evaluate(rows,{datasetId:f['--dataset-id'],labelProvenance:f['--label-provenance'],inputSha256:sha(input)});
 }
 await writeManifest(f['--output'],result);
 console.log(JSON.stringify({output:resolve(f['--output']),sha256:sha(JSON.stringify(result,null,2)+'\n'),schema:result.schema,...(mode==='sample'?{N:result.selection.N,selected_ids:result.selected_ids}:{rows:result.rows,insufficient_labels:result.insufficient_labels})}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.auditSafe?error.message:'Audit command failed: invalid input, unavailable source, cap exceeded, or invalid/unavailable SSD output. No configuration or driver details are printed.');process.exitCode=1});
