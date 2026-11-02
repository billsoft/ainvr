// One-off: clear derived search data (samples, shards, jobs) with the model pin untouched, and install a new search-service binary.
// usage: node search_reset_same_model.mjs --check|--apply <search-service-binary>
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateCollections,acquireDeploymentLock} from '/home/sunrise/ainvr/deploy-package/search_fresh_model_policy.mjs';
const root='/home/sunrise/ainvr';
const [mode,binary]=process.argv.slice(2);
if(!['--check','--apply'].includes(mode)||!binary)throw Error('usage');
const apply=mode==='--apply';
const run=(...a)=>execFileSync(a[0],a.slice(1),{encoding:'utf8',timeout:120000});
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const releaseLock=acquireDeploymentLock({
 open:p=>fs.openSync(p,'a',0o600),
 lock:fd=>execFileSync('flock',['-n','-E','75','3'],{stdio:['ignore','pipe','pipe',fd],timeout:5000}),
 close:fd=>fs.closeSync(fd),
});
let stopped=false;
try {
 const {parseEnv:parse}=await import('node:util');
 const env=parse(fs.readFileSync(root+'/deploy/s100p/runtime/backend.env','utf8'));
 const {PgConfigStore}=await import(root+'/srs-web-console/backend/dist/store/pgStore.js');
 const {MongoClient}=await import(root+'/alarm-service/node_modules/mongodb/lib/index.js');
 const pg=new PgConfigStore({poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT||5432),user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE},masterKeyPath:env.CONFIG_MASTER_KEY_PATH});
 const bootstrap=read(root+'/deploy/s100p/runtime/search-service-bootstrap.json');
 const response=await fetch(bootstrap.control_url+'/api/internal/search/runtime-config',{headers:{'x-service-token':bootstrap.service_token},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('runtime_unavailable');const runtime=await response.json();
 const mongo=new MongoClient(runtime.history_connection.uri,{serverSelectionTimeoutMS:5000});await mongo.connect();
 const db=mongo.db(runtime.history_connection.database);
 const collections=validateCollections((await db.listCollections({},{nameOnly:true}).toArray()).map(c=>c.name));
 const ssd='/mnt/ainvr-ssd';run('mountpoint','-q',ssd);
 const index=runtime.index_directory.resolved_path;
 if(!index||fs.realpathSync(index)!==index||!index.startsWith(ssd+'/ainvr/')||index===ssd+'/ainvr/')throw Error('unsafe_index_root');
 const owner=read(index+'/.owner.json');if(owner.kind!=='ainvr-search-index')throw Error('index_owner_mismatch');
 const shards=fs.readdirSync(index).filter(n=>!['.owner.json','.writer.lock'].includes(n));
 for(const n of shards){const p=path.join(index,n);if(!/^[a-f0-9-]{36}$/.test(n)||fs.lstatSync(p).isSymbolicLink()||!fs.statSync(p).isDirectory())throw Error('unsafe_index_shard');}
 const live=root+'/deploy/s100p/bin/ainvr_search_service';if(fs.lstatSync(live).isSymbolicLink())throw Error('unsafe_binary');
 const counts={};for(const c of collections)counts[c]=await db.collection(c).countDocuments();
 console.log(JSON.stringify({mode,collections:counts,shards:shards.length,binary}));
 if(apply){
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'Z');
  const backup=ssd+'/ainvr-rollback/search-service/'+stamp+'-rank';fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.copyFileSync(live,backup+'/ainvr_search_service');
  stopped=true;run('systemctl','stop','ainvr-ai','ainvr-search','ainvr-backend');
  for(const u of ['ainvr-ai','ainvr-search','ainvr-backend'])if(run('systemctl','show',u,'-p','MainPID','--value').trim()!=='0')throw Error('writer_still_running');
  const deleted={};for(const c of collections)deleted[c]=(await db.collection(c).deleteMany({})).deletedCount;
  for(const n of shards){const p=path.join(index,n);if(fs.realpathSync(p)!==p)throw Error('index_path_changed');fs.rmSync(p,{recursive:true});}
  await pg.pool.query('DELETE FROM search_jobs');await pg.pool.query('DELETE FROM search_index_shards');
  const temp=live+'.rank-'+process.pid;fs.copyFileSync(binary,temp);fs.chmodSync(temp,0o755);fs.renameSync(temp,live);
  run('systemctl','start','ainvr-backend');await new Promise(r=>setTimeout(r,8000));
  run('systemctl','start','ainvr-search');run('systemctl','start','ainvr-ai');stopped=false;
  console.log(JSON.stringify({phase:'started',deleted,backup}));
 }
 await mongo.close();await pg.pool.end();
} catch(e){
 console.error('FAILED',e.message);
 if(stopped){for(const u of ['ainvr-backend','ainvr-search','ainvr-ai']){try{run('systemctl','start',u);}catch{}}}
 process.exitCode=1;
} finally { releaseLock(); }
