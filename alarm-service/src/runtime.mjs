// Copyright AINVR. Independent service lifecycle; never starts or stops the AI service.
import {ReviewContext} from './review-context.mjs';
import {ReviewWorker} from './review-worker.mjs';
import {readFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from './repository.mjs';
import {ObservationConsumer} from './ingestion.mjs';
import {createApp} from './http.mjs';
import {ObservationPump} from './observation-pump.mjs';
import {EvidenceVault,validateEvidencePolicy} from './evidence-vault.mjs';
import {resolve} from 'node:path';

export function validateConfig(value) {
  const keys=['schema_version','version','operation_id','host','port','mongo_uri','database','api_token','producer_token','evidence','review'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Invalid service configuration');
  if(value.schema_version!=='1.0'||!Number.isSafeInteger(value.version)||value.version<1)throw Error('Invalid configuration version');
  if(typeof value.operation_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value.operation_id))throw Error('Invalid configuration operation');
  if(!['127.0.0.1','::1'].includes(value.host))throw Error('Service must bind loopback');
  if(!Number.isInteger(value.port)||value.port<1024||value.port>65535)throw Error('Explicit unprivileged service port required');
  if(typeof value.mongo_uri!=='string'||!/^mongodb(?:\+srv)?:\/\//.test(value.mongo_uri))throw Error('Mongo connection required');
  if(typeof value.database!=='string'||!/^[a-zA-Z0-9_-]{1,63}$/.test(value.database)||['admin','config','local'].includes(value.database))throw Error('Dedicated alarm database required');
  for(const key of ['api_token','producer_token'])if(typeof value[key]!=='string'||value[key].length<32||value[key].length>512)throw Error('Service credentials required');
  if(value.api_token===value.producer_token)throw Error('Separate producer credentials required');
  if(value.review){const v=value.review;for(const [k,min,max] of [['max_attempts',1,5],['timeout_s',10,440],['retry_delay_s',1,300],['retention_days',1,365],['max_bytes',134217728,1099511627776]])if(!Number.isSafeInteger(v[k])||v[k]<min||v[k]>max)throw Error('Invalid review settings');if(Object.keys(v).length!==5)throw Error('Unknown review setting');}
  return Object.freeze({...value,...(value.evidence!==undefined?{evidence:validateEvidencePolicy(value.evidence)}:{})});
}

export async function loadConfig(path) {
  const info=await stat(path);
  if(!info.isFile()||info.size>65536)throw Error('Invalid configuration file');
  if(process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('Configuration file must be private');
  try{return validateConfig(JSON.parse(await readFile(path,'utf8')));}
  catch{throw Error('Invalid service configuration');} // Never echo credentials or parsed input.
}

export async function startService(input,{evidenceSource,reviewInvoke}={}) {
  const config=validateConfig(input),instanceId=randomUUID(),startedAt=new Date().toISOString();
  const client=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:10000,maxPoolSize:8});
  let app,heartbeat,pump,vault,review,context,closing=false,healthy=false,checkedAt=null;
  const counters={received:0,persisted:0,replayed:0,failed:0};
  let lastInputAt=null,lastPersistedAt=null;
  const cpuStart=process.cpuUsage();
  try{
    await client.connect();
    const db=client.db(config.database),repository=new AlarmRepository(db);
    await repository.initialize();
    if(config.evidence){
      if(config.evidence.enabled&&!evidenceSource)throw Error('Evidence source transport required');
      const base=process.env.AINVR_ALARM_EVIDENCE_ROOT??'/mnt/ainvr-ssd/ainvr-alarm-evidence';
      if(!base.startsWith('/mnt/ainvr-ssd/')||resolve(base)!==base)throw Error('SSD evidence root required');
      vault=new EvidenceVault(db,{root:resolve(base,config.database),policy:config.evidence,source:evidenceSource});
      await vault.initialize();repository.evidenceVault=vault;
    }
    if(reviewInvoke){context=new ReviewContext(repository,process.env.AINVR_REVIEW_FRAME_ROOT??'/mnt/ainvr-ssd/ainvr-review-frames');context.policy=config.review;await context.initialize();repository.reviewContext=context;review=new ReviewWorker(repository,{invoke:reviewInvoke,context,policy:config.review});await review.initialize();}
    const health=db.collection('alarm_service_health');
    await health.createIndex({expires_at:1},{expireAfterSeconds:0});
    const probe=async()=>{
      try{
        await health.updateOne({_id:instanceId},{$set:{checked_at:new Date(),expires_at:new Date(Date.now()+86400000)}},{upsert:true});
        healthy=true;
      }catch{healthy=false;}
      checkedAt=new Date().toISOString();
      return healthy&&!closing;
    };
    if(!await probe())throw Error('Alarm storage not writable');
    const consumer=new ObservationConsumer(repository);
    const observedConsumer={consume:async envelope=>{
      counters.received++;lastInputAt=new Date().toISOString();
      try{
        const result=await consumer.consume(envelope);
        if(result.durable){counters.persisted++;lastPersistedAt=new Date().toISOString();}
        if(result.outcome==='already_consumed')counters.replayed++;
        return result;
      }catch(error){counters.failed++;throw error;}
    }};
    if(process.env.AINVR_OBSERVATION_SPOOL_ROOT)pump=new ObservationPump(process.env.AINVR_OBSERVATION_SPOOL_ROOT,observedConsumer,repository);
    app=createApp({repository,apiToken:config.api_token,producerToken:config.producer_token,consumer:observedConsumer,
      readiness:async()=>!closing&&healthy&&checkedAt!==null&&Date.now()-Date.parse(checkedAt)<15000});
    // Authenticated internal status; config acknowledgment names the actual live instance.
    app.get('/v1/status',async()=>({schema_version:'1.0',service_name:'alarm-service',instance_id:instanceId,
      sampled_at:new Date().toISOString(),started_at:startedAt,counter_epoch:instanceId,
      status:closing?'stopping':healthy?'ready':'degraded',
      config:{applied_version:config.version,operation_id:config.operation_id,applied_at:startedAt},
      rule_configuration:await repository.ruleSnapshots.status(),
      storage:{writable:healthy,checked_at:checkedAt},
      process:{pid:process.pid,rss_bytes:process.memoryUsage().rss,cpu_microseconds:process.cpuUsage(cpuStart)},
      input:{...counters,last_received_at:lastInputAt,last_persisted_at:lastPersistedAt,lag_ms:null,
        lag_reason:'Producer watermark not connected'},
      observation_journal:pump?structuredClone(pump.status):{state:'disabled'},
      evidence_vault:vault?await vault.status():{enabled:false,state:'not_configured'},
      review:review?await review.status():{available:false},notifications:{available:false}}));
    await app.listen({host:config.host,port:config.port});
    pump?.run();vault?.run();context?.run();review?.run();
    heartbeat=setInterval(()=>{void probe();},5000);heartbeat.unref();
    return {app,instanceId,close:async()=>{
      if(closing)return;closing=true;clearInterval(heartbeat);
      try{await pump?.close();await review?.close();await context?.close();await vault?.close();await app.close();}finally{await client.close();}
    }};
  }catch(error){clearInterval(heartbeat);await pump?.close();await review?.close();await context?.close();await vault?.close();if(app)await app.close();await client.close();throw error;}
}
