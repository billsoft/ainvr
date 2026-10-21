// AINVR. Provision only this new service. Requires a verified private PG backup.
// Inherit existing backend PG configuration in memory; never pass credentials in argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const ROOT='/home/sunrise/ainvr';
const random=()=>crypto.randomBytes(32).toString('hex');
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tokenRef=value=>/^\$\{secret:(alarm-service\/[^}]+)\}$/.exec(value)?.[1];
const privateFile=(file,data,uid,gid)=>{
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.chownSync(file,uid,gid);
};
const mongoCommand=script=>{
 const result=spawnSync('docker',['exec','-i','ainvr-mongo','mongosh','--quiet','--norc','--file','/dev/stdin'],{input:script,encoding:'utf8',timeout:15000});
 // Child output can contain source/credentials; never forward or persist it.
 if(result.status!==0)throw new Error('Dedicated database setup failed');
};
const authScript=`const fs=require('fs');const admin=db.getSiblingDB('admin');if(!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD||fs.readFileSync(process.env.MONGO_INITDB_ROOT_PASSWORD_FILE,'utf8').trim()))quit(11);const target=db.getSiblingDB('ainvr_alarm');`;
async function main(){
 if(process.getuid()!==0)throw Error('Board root required');
 const [candidate,uidText,gidText]=process.argv.slice(2),uid=Number(uidText),gid=Number(gidText);
 if(!candidate?.startsWith('/mnt/ainvr-ssd/ainvr-alarm-web-')||!Number.isInteger(uid)||uid<1||!Number.isInteger(gid)||gid<1)throw Error('Verified board candidate and service ownership required');
 const built=JSON.parse(fs.readFileSync(path.join(candidate,'status.json'),'utf8'));
 if(built.phase!=='passed'||built.current_source_changes.length)throw Error('Web candidate not verified');
 const backup=JSON.parse(fs.readFileSync(ROOT+'/test/results/alarm-migration-backup-20261019.json','utf8'));
 if(backup.phase!=='passed'||!backup.existing_row_counts_unchanged||Date.now()/1000-backup.updated_at>3600||digest(backup.backup_directory+'/configuration-before-alarm.dump')!==backup.backup_sha256)throw Error('Recent verified migration backup required');
 for(const migration of backup.migrations)if(digest(ROOT+'/srs-web-console/backend/src/store/migrations/'+migration.name)!==migration.sha256)throw Error('Migration changed after restore verification');
 const {PgConfigStore}=await import(pathToFileURL(candidate+'/source/srs-web-console/backend/dist/store/pgStore.js').href);
 const {alarmSettingsSchema}=await import(pathToFileURL(candidate+'/source/srs-web-console/backend/dist/store/alarmConfigAdapter.js').href);
 const {MongoClient}=await import(pathToFileURL(ROOT+'/alarm-service/node_modules/mongodb/lib/index.js').href);
 const store=new PgConfigStore({poolConfig:{host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT)||5432,user:process.env.CONFIG_PG_USER,password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE},masterKeyPath:process.env.CONFIG_MASTER_KEY_PATH});
 let createdMongo=false,committed=false;
 try{
  await store.init();
  const runtime=ROOT+'/deploy/s100p/runtime';
  const bootstrapFile=runtime+'/alarm-service-bootstrap.json',backendFile=runtime+'/alarm-service-backend.env';
  let serviceToken;
  if(fs.existsSync(bootstrapFile)){
   const value=JSON.parse(fs.readFileSync(bootstrapFile,'utf8'));
   if(value.control_url!=='http://127.0.0.1:3001/'||!/^[a-f0-9]{64}$/.test(value.service_token))throw Error('Existing bootstrap is not owned by this provisioner');
   serviceToken=value.service_token;
  }else{
   if(fs.existsSync(backendFile))throw Error('Incomplete existing bootstrap requires reconciliation');
   serviceToken=random();privateFile(bootstrapFile,JSON.stringify({control_url:'http://127.0.0.1:3001/',service_token:serviceToken,poll_ms:5000})+'\n',uid,gid);
  }
  const backendEnv='CONFIG_SERVICE_TOKEN_ALARM_SERVICE='+serviceToken+'\nALARM_SERVICE_HOST=127.0.0.1\n';
  if(fs.existsSync(backendFile)){
   if(fs.readFileSync(backendFile,'utf8')!==backendEnv)throw Error('Existing backend bootstrap differs');
  }else privateFile(backendFile,backendEnv,0,0);
  const previous=await store.getDocument('alarm-service','system','settings');
  let config,mongoUri;
  if(previous){
   if(previous.description!=='AINVR independent alarm bootstrap 20261019')throw Error('Existing alarm settings are not owned by this provisioner');
   config=previous.config;const ref=tokenRef(config.mongo_uri);if(!ref)throw Error('Existing database reference invalid');
   mongoUri=await store.getSecret(ref);if(!mongoUri)throw Error('Existing database credential unavailable');
  }else{
   const databasePassword=random(),apiToken=random(),producerToken=random();
   mongoUri='mongodb://ainvr_alarm_service:'+databasePassword+'@127.0.0.1:27017/ainvr_alarm?authSource=ainvr_alarm';
   config={host:'127.0.0.1',port:8200,database:'ainvr_alarm',mongo_uri:mongoUri,api_token:apiToken,producer_token:producerToken,evidence:{enabled:true,retention_days:30,max_bytes:2*1024**3}};
   alarmSettingsSchema.parse(config);
  }
  const test=new MongoClient(mongoUri,{serverSelectionTimeoutMS:3000});let connected=false;
  try{await test.connect();await test.db('ainvr_alarm').command({ping:1});connected=true;}catch{}finally{await test.close().catch(()=>{});}
  if(!connected){
   if(previous)throw Error('Previously configured database must be repaired without changing its password');
   const password=new URL(mongoUri).password;
   mongoCommand(authScript+'if(target.getUser("ainvr_alarm_service"))quit(12);target.createUser({user:"ainvr_alarm_service",pwd:'+JSON.stringify(password)+',roles:[{role:"readWrite",db:"ainvr_alarm"}]});');
   createdMongo=true;
   const verify=new MongoClient(mongoUri,{serverSelectionTimeoutMS:3000});try{await verify.connect();await verify.db('ainvr_alarm').command({ping:1});}finally{await verify.close();}
  }
  let version;
  if(previous){version=(await store.getServiceState('alarm-service'))?.desiredVersion;if(!version)throw Error('Existing bootstrap lacks a published version');committed=true;}
  else{
   const published=await store.publish('初始化独立告警服务（不改变其他服务配置）','alarm-deployment',{
    services:['alarm-service'],prepare:async client=>{
     const existing=await client.query('SELECT id FROM config_documents WHERE service=$1 AND "group"=$2 AND name=$3 FOR UPDATE',['alarm-service','system','settings']);
     if(existing.rowCount)throw Error('Concurrent alarm configuration change');
     const sanitized={...config};
     for(const key of ['mongo_uri','api_token','producer_token']){
      const ref='alarm-service/'+key+'/'+crypto.randomUUID();
      await client.query('INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version) VALUES($1,$2,$3,1)',[ref,store.encryptSecret(config[key]),'aes-256-gcm']);
      sanitized[key]='${secret:'+ref+'}';
     }
     await client.query('INSERT INTO config_documents(service,"group",name,config,description) VALUES($1,$2,$3,$4,$5)',['alarm-service','system','settings',JSON.stringify(sanitized),'AINVR independent alarm bootstrap 20261019']);
    }
   });version=published.version;committed=true;
  }
  const state=await store.getServiceState('alarm-service');
  if(state?.desiredVersion!==version)throw Error('Published configuration not confirmed');
  process.stdout.write(JSON.stringify({provisioned:true,desired_version:version,bootstrap:bootstrapFile,backend_environment:backendFile,dedicated_database:'ainvr_alarm',existing_passwords_changed:false,other_services_republished:false})+'\n');
 }catch(error){
  if(createdMongo&&!committed){try{mongoCommand(authScript+'target.dropUser("ainvr_alarm_service");');}catch{}}
  throw error;
 }finally{await store.close();}
}
main().catch(()=>{process.stderr.write('Alarm provisioning failed; private state retained for reconciliation. No credentials are logged.\n');process.exitCode=1;});
