// First-install only. No plaintext inference credentials are written to disk.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='/home/sunrise/ainvr';
const {PgConfigStore}=await import(pathToFileURL(root+'/srs-web-console/backend/dist/store/pgStore.js'));
const {CryptoStore}=await import(pathToFileURL(root+'/srs-web-console/backend/dist/store/crypto.js'));
const e=process.env;
if(!fs.existsSync(e.CONFIG_MASTER_KEY_PATH))throw Error('Existing master key required');
const store=new PgConfigStore({poolConfig:{host:e.CONFIG_PG_HOST,port:Number(e.CONFIG_PG_PORT||5432),user:e.CONFIG_PG_USER,password:e.CONFIG_PG_PASSWORD,database:e.CONFIG_PG_DATABASE},masterKeyPath:e.CONFIG_MASTER_KEY_PATH});
const cipher=new CryptoStore(e.CONFIG_MASTER_KEY_PATH);
try{
 if(await store.getDocument('llm-service','system','settings'))throw Error('Existing LLM settings: reconcile before installation');
 const secrets=[['llm-service/install/admin',crypto.randomBytes(32).toString('hex')],['llm-service/install/console-try',crypto.randomBytes(32).toString('hex')]];
 const settings={enabled:false,listen:{host:'127.0.0.1',port:8300},admin_key:'${secret:llm-service/install/admin}',api_keys:[{name:'console-try',scope:'inference',key:'${secret:llm-service/install/console-try}'}],model:{package_id:'qwen3vl-4b-review-v3',load_policy:'resident',ion_reserve_mb:512},tasks:{'alarm-review-zh-v1':{calibration_temperature:1,aspect_policy:'reject'}},scheduling:{queue_size:8,queue_timeout_s:30,exec_timeout_s:30,submit_time_share_cap_percent:40,prefill_profile:'s256'},logging:{record_requests:false}};
 const v=await store.publish('Install LLM control plane; inference disabled pending safe memory admission','llm-installer',{services:['llm-service'],prepare:async c=>{
   if((await c.query("SELECT 1 FROM config_documents WHERE service='llm-service' FOR UPDATE")).rowCount)throw Error('Concurrent LLM configuration');
   for(const [path,value] of secrets)await c.query("INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version) VALUES ($1,$2,'aes-256-gcm',1)",[path,cipher.encrypt(value)]);
   await c.query('INSERT INTO config_documents(service,"group",name,config) VALUES ($1,$2,$3,$4)',['llm-service','system','settings',settings]);
 }});
 console.log(JSON.stringify({version:v.version,enabled:false}));
}finally{await store.close();}
