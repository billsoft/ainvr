// ONE-OFF (2026-11-04): same package, new stored layout. The scene sample now carries 4 view vectors (whole frame + 3 short-edge
// squares), so the vector space changes while the package id does not, and search_fresh_model_cutover.mjs refuses source==target.
// This variant clears derived search data AND the model pin, installs both new binaries, and re-applies the sampling settings
// (object sampling off, constant 20 s scene cadence, 40,000 samples, 8 GiB). It is not a general tool: the settings below are
// the values chosen for that release. usage: node search_relayout_reset.mjs --check|--apply
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateCollections,acquireDeploymentLock,recoverFreshModelServices,waitForCondition} from './search_fresh_model_policy.mjs';
// Same package, new stored layout: a scene sample now carries 4 view vectors (whole frame + 3 short-edge squares), so the
// vector space (model_version) changes while the package id does not. The generic cutover refuses source==target, so this
// variant clears derived data and the pin, installs BOTH new binaries and re-applies the sampling settings.
const PKG='siglip2-base-full-int8';
const relayoutSettings=s=>{
 if(s?.model?.package_id!==PKG)throw Error('relayout_source_mismatch');
 const n=structuredClone(s);
 // Search is independent of detector boxes: no object (box) sampling; one constant whole-frame cadence.
 n.sampling.object=false;n.sampling.scene=true;
 n.sampling.scene_active_interval_ms=20000;n.sampling.scene_static_interval_ms=20000;
 // 4 views x 768 floats per sample: the 128M-float exact working set holds about 41,600 samples.
 n.limits.max_samples=40000;
 // One 1280-px scene JPEG is ~100-250 KB: the old 1 GiB cap would fill in hours at this cadence.
 n.limits.max_bytes=8*1024*1024*1024;
 return n;
};
const relayoutReady=(runtime,status,ai,version,requireSampling,oldPin)=>{
 const pin=runtime?.active_model_pin;const sampling=ai?.business?.search_sampling;
 return runtime?.desired_version===version&&pin?.package_id===PKG&&/^search-v1-[a-f0-9]{64}$/.test(pin?.model_version)&&
  pin.model_version!==oldPin.model_version&&status?.ready===true&&status.model_version===pin.model_version&&
  ai?.status==='ok'&&ai.business?.ready===true&&(!requireSampling||sampling?.ready===true)&&(!sampling?.ready||sampling.model_version===pin.model_version);
};
const root='/home/sunrise/ainvr';
const args=process.argv.slice(2);
if(args.length!==1||!['--check','--apply'].includes(args[0]))throw Error('use_check_or_apply');
const apply=args[0]==='--apply';
// Loading the nine-HBM Qwen3-VL-Embedding owner (hash + weights) takes longer than the legacy 120 s default.
const readyTimeoutMs=Math.min(900000,Math.max(120000,Number(process.env.AINVR_FRESH_READY_TIMEOUT_MS||120000)));
const transition={sourcePackage:PKG,targetPackage:PKG,targetDimensions:3072};
// Acquire the same lock as the transactional publisher before reading state.
const releaseLock=acquireDeploymentLock({
 open:p=>fs.openSync(p,'a',0o600),
 lock:fd=>execFileSync('flock',['-n','-E','75','3'],{stdio:['ignore','pipe','pipe',fd],timeout:5000}),
 close:fd=>fs.closeSync(fd),
});
try { await cutover(); } finally { releaseLock(); }

async function cutover() {
// No secrets are written to reports.
const {parseEnv:parse}=await import('node:util');
const env=parse(fs.readFileSync(root+'/deploy/s100p/runtime/backend.env','utf8'));
const {PgConfigStore}=await import(root+'/srs-web-console/backend/dist/store/pgStore.js');
const {searchSettingsSchema}=await import(root+'/srs-web-console/backend/dist/store/searchConfigAdapter.js');
const {MongoClient}=await import(root+'/alarm-service/node_modules/mongodb/lib/index.js');
const pg=new PgConfigStore({poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT||5432),user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE},masterKeyPath:env.CONFIG_MASTER_KEY_PATH});
const run=(...args)=>execFileSync(args[0],args.slice(1),{encoding:'utf8',timeout:120000});
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const get=async (url,headers={},remaining=2000)=>{
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(Math.max(1,Math.min(2000,Math.ceil(remaining))))});
 if(!response.ok)throw Error('readiness_http_unavailable');return response.json();
};
const active=unit=>execFileSync('systemctl',['is-active','--quiet',unit],{stdio:'ignore',timeout:2000});
let mongo,stopped=false,cleared=false,report,reportPath;
try {
 const bootstrap=read(root+'/deploy/s100p/runtime/search-service-bootstrap.json');
 const response=await fetch(bootstrap.control_url+'/api/internal/search/runtime-config',{headers:{'x-service-token':bootstrap.service_token},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('runtime_unavailable');const runtime=await response.json();
 const doc=(await pg.pool.query(`SELECT config FROM config_documents WHERE service='search-service' AND "group"='system' AND name='settings'`)).rows[0]?.config;
 const pin=(await pg.pool.query('SELECT active_model FROM search_runtime_state WHERE singleton')).rows[0]?.active_model;
 mongo=new MongoClient(runtime.history_connection.uri,{serverSelectionTimeoutMS:5000});await mongo.connect();const db=mongo.db(runtime.history_connection.database);
 const collections=validateCollections((await db.listCollections({},{nameOnly:true}).toArray()).map(c=>c.name));
 const models=await db.collection('search_samples').distinct('model');
 if(pin?.package_id!==PKG||!/^search-v1-[a-f0-9]{64}$/.test(pin.model_version))throw Error('relayout_pin_mismatch');
 const next=searchSettingsSchema.parse(relayoutSettings(doc));
 // Vision loading is demand-driven. Require it after cutover if it was in use;
 // an idle installation must not need to fabricate traffic to become healthy.
 const requireSampling=(await get('http://127.0.0.1:8000/health')).business?.search_sampling?.ready===true;
 if(runtime.active_model_pin?.model_version!==pin.model_version)throw Error('runtime_pin_changed');
 const index=runtime.index_directory.resolved_path;
 const ssd='/mnt/ainvr-ssd';run('mountpoint','-q',ssd);
 if(!index||fs.realpathSync(index)!==index||!index.startsWith(ssd+'/ainvr/')||index===ssd+'/ainvr/')throw Error('unsafe_index_root');
 const owner=read(index+'/.owner.json');
 if(owner.kind!=='ainvr-search-index'||owner.volume_id!==doc.index_storage.volume_id)throw Error('index_owner_mismatch');
 const shards=fs.readdirSync(index).filter(n=>!['.owner.json','.writer.lock'].includes(n));
 for(const name of shards){
  const p=path.join(index,name);
  if(!/^[a-f0-9-]{36}$/.test(name)||fs.lstatSync(p).isSymbolicLink()||!fs.statSync(p).isDirectory())throw Error('unsafe_index_shard');
  const files=fs.readdirSync(p);if(files.some(f=>!/^\d+\.(manifest\.json|records\.f32le)$/.test(f)||fs.lstatSync(path.join(p,f)).isSymbolicLink()))throw Error('unknown_index_file');
  const manifests=files.filter(f=>f.endsWith('.manifest.json'));if(!manifests.length)throw Error('index_manifest_missing');
  for(const f of manifests){const m=read(path.join(p,f));if(m.model_version!==pin.model_version||m.dimensions!==768)throw Error('unexpected_index_space');}
 }
 // Candidate executables default to the validated caches; an operator may name another build under out/ with
 // AINVR_FRESH_AI_BINARY / AINVR_FRESH_SEARCH_BINARY (relative to the repository root).
 const candidate=(variable,fallback)=>{const rel=process.env[variable]??fallback;const full=path.resolve(root,rel);if(!full.startsWith(root+'/out/'))throw Error('unsafe_candidate_binary');return path.relative(root,full);};
 const binaries=[['ai-service','ainvr-ai',candidate('AINVR_FRESH_AI_BINARY','out/build/qwen-ai/ainvr_s100p_control_service'),'ainvr_ai_service'],['search-service','ainvr-search',candidate('AINVR_FRESH_SEARCH_BINARY','out/build/qwen-search/ainvr_search_service'),'ainvr_search_service']].map(([service,unit,source,name])=>({service,unit,source:root+'/'+source,live:root+'/deploy/s100p/bin/'+name,name}));
 for(const b of binaries){if(fs.lstatSync(b.live).isSymbolicLink())throw Error('unsafe_binary');b.sha=hash(b.source);b.old=hash(b.live);}
 const oldCount=await db.collection('search_samples').countDocuments();
 console.log(JSON.stringify({mode:apply?'apply':'check',...transition,oldSamples:oldCount,collections,indexShards:shards.length,newPackage:next.model.package_id,sampling:next.sampling,limits:next.limits}));
 if(apply){
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'Z')+'-'+Date.now();
  for(const b of binaries){b.backup=ssd+'/ainvr-rollback/'+b.service+'/'+stamp;fs.mkdirSync(b.backup,{recursive:true,mode:0o700});fs.copyFileSync(b.live,b.backup+'/'+b.name);if(hash(b.backup+'/'+b.name)!==b.old)throw Error('backup_mismatch');fs.writeFileSync(b.backup+'/backup.json',JSON.stringify({phase:'prepared',createdAt:Date.now()/1000}));}
  reportPath=binaries[1].backup+'/fresh-model.json';
  report={phase:'prepared',...transition,oldPin:pin,newPackage:next.model.package_id,oldSamples:oldCount,deleted:{},oldSettings:doc,binaries};
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
  stopped=true;run('systemctl','stop','ainvr-ai','ainvr-search','ainvr-backend');
  for(const unit of ['ainvr-ai','ainvr-search','ainvr-backend'])if(run('systemctl','show',unit,'-p','MainPID','--value').trim()!=='0')throw Error('writer_still_running');
  const version=await pg.publish(`Whole-frame multi-view search layout (4 x 768); authorized removal of single-vector derived search data`,'maintenance',{services:['search-service'],prepare:async client=>{
   const current=(await client.query(`SELECT config FROM config_documents WHERE service='search-service' AND "group"='system' AND name='settings' FOR UPDATE`)).rows[0]?.config;
   const currentPin=(await client.query('SELECT active_model FROM search_runtime_state WHERE singleton FOR UPDATE')).rows[0]?.active_model;
   if(JSON.stringify(current)!==JSON.stringify(doc)||JSON.stringify(currentPin)!==JSON.stringify(pin))throw Error('concurrent_configuration_change');
   if(validateCollections((await db.listCollections({},{nameOnly:true}).toArray()).map(c=>c.name)).join('|')!==collections.join('|'))throw Error('collections_changed');
   // All writers are stopped before clearing any derived state. Preserve collection indexes.
   cleared=true;report.phase='clearing';fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
   for(const name of collections)report.deleted[name]=(await db.collection(name).deleteMany({})).deletedCount;
   for(const name of shards){const p=path.join(index,name);if(fs.realpathSync(p)!==p)throw Error('index_path_changed');fs.rmSync(p,{recursive:true});}
   await client.query('DELETE FROM search_jobs');await client.query('DELETE FROM search_index_shards');await client.query('DELETE FROM search_runtime_state');
   await client.query(`UPDATE config_documents SET config=$1,updated_at=now() WHERE service='search-service' AND "group"='system' AND name='settings'`,[JSON.stringify(next)]);
  }});
  report.version=version.version;report.phase='configured';fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const b of binaries){if(hash(b.source)!==b.sha||hash(b.live)!==b.old)throw Error('binary_changed');const temp=b.live+'.fresh-model-'+process.pid;fs.copyFileSync(b.source,temp);fs.chmodSync(temp,0o755);fs.renameSync(temp,b.live);}
  run('systemctl','start','ainvr-backend');
  await waitForCondition(async remaining=>{active('ainvr-backend');return (await get('http://127.0.0.1:3001/api/health',{},remaining)).data?.status==='ok';});
  run('systemctl','start','ainvr-search');run('systemctl','start','ainvr-ai');
  await waitForCondition(async remaining=>{
   for(const unit of ['ainvr-backend','ainvr-search','ainvr-ai'])active(unit);
   const current=await get(bootstrap.control_url+'/api/internal/search/runtime-config',{'x-service-token':bootstrap.service_token},remaining);
   const key=current.settings?.callers?.find(c=>c.scope==='console')?.key;
   if(!key)return false;
   const [status,ai]=await Promise.all([get('http://127.0.0.1:8400/v1/status',{'x-service-token':key},remaining),get('http://127.0.0.1:8000/health',{},remaining)]);
   return relayoutReady(current,status,ai,version.version,requireSampling,pin);
  },{timeoutMs:readyTimeoutMs});
  report.phase='ready';fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const b of binaries)fs.writeFileSync(b.backup+'/backup.json',JSON.stringify({phase:'applied',createdAt:Date.now()/1000}));
  // Reuse the shared service buckets, timestamp ordering and transaction invalidation.
  // The cutover itself is complete and verified here: a retention-cleanup failure must never stop the services again.
  stopped=false;
  try{run('python3','-c','import sys; sys.path.insert(0,sys.argv[1]); from deploy_ptz_release import prune; [prune(service) for service in sys.argv[2:]]',root+'/deploy-package',...binaries.map(b=>b.service));}catch(error){console.error(JSON.stringify({warning:'backup_retention_prune_failed',detail:String(error.message).split('\n')[0]}));}
  console.log(JSON.stringify({version:version.version,phase:'ready',report:reportPath,deleted:report.deleted}));
 }
} catch(error){
 // No silent rollback across erased data/model identity. Keep search off on failure.
 const recoveryFailures=stopped?recoverFreshModelServices(run):[];
 if(reportPath){
  report.phase='failed';report.cleared=cleared;report.recoveryFailures=recoveryFailures;
  try {fs.writeFileSync(reportPath,JSON.stringify(report,null,2));} catch {console.error('fresh_model_failure_report_unavailable');}
 }
 if(recoveryFailures.length)console.error('fresh_model_recovery_failed',recoveryFailures.join(','));
 console.error('fresh_model_cutover_failed',String(error.message).replace(/mongodb[^\s]*/g,'[redacted]'));process.exitCode=1;
} finally {await mongo?.close();await pg.close();}
}
