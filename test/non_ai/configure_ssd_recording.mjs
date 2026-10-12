// AINVR authorized SSD recording setup through the existing configuration publisher.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const root='/home/sunrise/ainvr';const req=createRequire(root+'/srs-web-console/backend/package.json');
const env=req('node:util').parseEnv(await readFile(root+'/deploy/s100p/runtime/backend.env','utf8'));
const {PgConfigStore}=await import(root+'/srs-web-console/backend/dist/store/pgStore.js');
const {PublishOrchestrator}=await import(root+'/srs-web-console/backend/dist/store/publishOrchestrator.js');
const {PullModeAdapter}=await import(root+'/srs-web-console/backend/dist/store/adapter.js');
const store=new PgConfigStore({poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT),user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE},masterKeyPath:env.CONFIG_MASTER_KEY_PATH});
try {
 const old=await store.getDocument('recorder','system','settings');
 console.log(JSON.stringify({existing:!!old,keys:Object.keys(old?.config??{}),storage:old?.config.storage?.kind,quota:old?.config.quota}));
 if(!process.argv.includes('--apply'))process.exitCode=0;
 else {
  await writeFile(root+'/deploy/s100p/runtime/recorder-before-ssd.json',JSON.stringify(old),{mode:0o600,flag:'wx'});
  const adapter=new PullModeAdapter('recorder');const pub=new PublishOrchestrator(store,[adapter]);
  const result=await pub.publish('AINVR SSD recording directory and gate camera schedule','ainvr-ssd-setup',{services:['recorder'],prepare:async client=>{
   await client.query('LOCK TABLE config_documents IN SHARE ROW EXCLUSIVE MODE');
   const q=await client.query('SELECT config FROM config_documents WHERE service=$1 AND "group"=$2 AND name=$3',['recorder','system','settings']);
   const config=q.rows[0]?.config??{};
   config.storage={...(config.storage??{}),kind:'local',localPath:'/mnt/ainvr-ssd/recordings'};
   config.quota=config.quota??{mode:'percent',percent:90,onFull:'overwrite',minRetentionDays:null};
   config.channelSchedules={...(config.channelSchedules??{}),'2baec0a3-9941-47dc-b1bd-d3d284488097':{enabled:true,hours:Array.from({length:24},(_,i)=>i)}};
   delete config.enabledChannelIds;
   const doc={service:'recorder',group:'system',name:'settings',config};
   const validation=await adapter.validate([doc]);if(!validation.ok)throw new Error('Recorder validation failed');
   await client.query('INSERT INTO config_documents(service,"group",name,config) VALUES($1,$2,$3,$4) ON CONFLICT(service,"group",name) DO UPDATE SET config=EXCLUDED.config,updated_at=now()',['recorder','system','settings',JSON.stringify(config)]);
  }});
  console.log(JSON.stringify({version:result.version.version,status:result.overallStatus,results:result.results}));
 }
}finally{await store.pool.end();}
