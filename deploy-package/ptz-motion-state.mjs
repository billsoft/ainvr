// Read-only release probe. Never calls init(), evaluates frames, or prints secrets.
import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
let store,mongo;
try{
 const env=parseEnv(await readFile(path.join(root,'deploy/s100p/runtime/backend.env'),'utf8'));
 if(!path.isAbsolute(env.CONFIG_MASTER_KEY_PATH??'')||(await stat(env.CONFIG_MASTER_KEY_PATH)).size<32)throw Error('master_key_missing');
 const {PgConfigStore}=await import(pathToFileURL(path.join(root,'srs-web-console/backend/dist/store/pgStore.js')).href);
 store=new PgConfigStore({masterKeyPath:env.CONFIG_MASTER_KEY_PATH,poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT??5432),user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,options:'-c default_transaction_read_only=on'}});
 const state=await store.getServiceState('alarm-service');
 if(!Number.isSafeInteger(state?.appliedVersion))throw Error('applied_configuration_missing');
 const docs=(await store.getVersionSnapshotForService(state.appliedVersion,'alarm-service')).filter(d=>d.group==='system'&&d.name==='settings');
 if(docs.length!==1)throw Error('applied_configuration_ambiguous');
 const config=structuredClone(docs[0].config);
 for(const key of ['mongo_uri','api_token']){
  const value=config[key],match=typeof value==='string'&&/^\$\{secret:([^}]+)\}$/.exec(value);
  if(match){if(!match[1].startsWith('alarm-service/'))throw Error('foreign_secret');config[key]=await store.getSecret(match[1]);}
 }
 if(!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||typeof config.api_token!=='string')throw Error('invalid_local_service');
 const require=createRequire(path.join(root,'alarm-service/package.json'));
 const {MongoClient}=require('mongodb');
 mongo=new MongoClient(config.mongo_uri,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:5000,maxPoolSize:1});
 await mongo.connect();const db=mongo.db(config.database);
 const active=await db.collection('alarm_rule_snapshot').findOne({_id:'active'});
 const pending=await db.collection('alarm_consumer_checkpoints').find({pending:{$ne:null}},{projection:{channel_id:1,producer_id:1,pending:1}}).limit(5001).toArray();
 if(pending.length>5000)throw Error('pending_probe_limit');
 // Conservative first-upgrade guard: even an unclassified legacy channel must
 // be drained by its original engine, never silently discarded by this tool.
 const {validatePendingPermit}=await import(pathToFileURL(path.join(root,'alarm-service/src/motion-admission.mjs')).href);
 let legacyPending=0;
 for(const doc of pending){try{validatePendingPermit(doc.pending,doc.channel_id,doc.producer_id);}catch{legacyPending++;}}
 const scopes=active?.motion_admission?.scopes??[];
 const ordered=[...scopes].sort((a,b)=>a.input_stream_id.localeCompare(b.input_stream_id)||a.channel_id.localeCompare(b.channel_id));
 const expectedDigest=hash(ordered);
 const hasTable=(await store.pool.query("SELECT to_regclass('ptz_motion_scopes') IS NOT NULL AS present")).rows[0].present;
 const revision=(await store.pool.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton')).rows[0]?.revision;
 const registered=hasTable?(await store.pool.query('SELECT source_id,processor_id,guard_epoch,execution_digest,snapshot_revision::text,installed FROM ptz_motion_scopes')).rows:[];
 const hasInstallations=(await store.pool.query("SELECT to_regclass('ptz_motion_guard_installations') IS NOT NULL AS present")).rows[0].present;
 const guards=(await store.pool.query('SELECT resource_key,source_ids FROM ptz_view_guards WHERE blocked OR restored_at IS NOT NULL')).rows;
 const installations=hasInstallations?(await store.pool.query('SELECT resource_key,source_digest,snapshot_revision::text,installed FROM ptz_motion_guard_installations')).rows:[];
 const completeGuards=guards.length>0&&guards.every(g=>installations.some(i=>i.resource_key===g.resource_key&&i.source_digest===hash([...g.source_ids].sort())&&i.snapshot_revision===revision&&i.installed));
 const installed=completeGuards&&scopes.every(s=>registered.some(r=>r.source_id===s.input_stream_id&&r.processor_id===s.channel_id&&r.guard_epoch===s.guard_epoch&&r.execution_digest===s.execution_digest&&r.installed&&r.snapshot_revision===revision));
 let http=null,healthy=false;
 try{
  const base=`http://${config.host==='::1'?'[::1]':config.host}:${config.port}`;
  const health=await fetch(base+'/readyz',{redirect:'error',signal:AbortSignal.timeout(3000)});healthy=health.ok&&(await health.json()).ready===true;
  const response=await fetch(base+'/v1/configuration/rules',{redirect:'error',headers:{authorization:`Bearer ${config.api_token}`},signal:AbortSignal.timeout(3000)});
  if(response.ok)http=await response.json();
 }catch{}
 const protocolReady=healthy&&active?.motion_admission?.protocol===1&&http?.motion_admission?.protocol===1&&http.motion_admission.scopes_digest===expectedDigest&&http.revision===revision&&active.revision===revision&&installed;
 console.log(JSON.stringify({appliedVersion:state.appliedVersion,configurationDigest:hash(docs[0].config),pending:pending.length,legacyPending,authorizedPending:pending.length-legacyPending,legacyPolicy:'all-channels-conservative',healthy,protocolReady,scopeCount:scopes.length,scopesDigest:expectedDigest,revision,mongoRevision:active?.revision??null,installed}));
}catch{console.error('Motion release state probe failed; no credentials disclosed');process.exitCode=1;}
finally{await mongo?.close();await store?.close();}
