// Add the dedicated inference caller without replacing existing configuration.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='/home/sunrise/ainvr';
const {PgConfigStore}=await import(pathToFileURL(root+'/srs-web-console/backend/dist/store/pgStore.js'));
const {CryptoStore}=await import(pathToFileURL(root+'/srs-web-console/backend/dist/store/crypto.js'));
const e=process.env;
const store=new PgConfigStore({poolConfig:{host:e.CONFIG_PG_HOST,port:Number(e.CONFIG_PG_PORT||5432),user:e.CONFIG_PG_USER,password:e.CONFIG_PG_PASSWORD,database:e.CONFIG_PG_DATABASE},masterKeyPath:e.CONFIG_MASTER_KEY_PATH});
const cipher=new CryptoStore(e.CONFIG_MASTER_KEY_PATH);
try{
 const current=await store.getDocument('llm-service','system','settings');
 if(!current)throw Error('Existing LLM settings required');
 if(current.config.api_keys.some(k=>k.name==='alarm-review')){console.log('Dedicated caller already configured');}
 else{
  const result=await store.publish('Enable dedicated asynchronous alarm reviewer','alarm-review-installer',{services:['llm-service'],prepare:async client=>{
   const {rows}=await client.query("SELECT config FROM config_documents WHERE service='llm-service' AND \"group\"='system' AND name='settings' FOR UPDATE");
   const settings=rows[0].config;if(settings.api_keys.some(k=>k.name==='alarm-review'))throw Error('Concurrent caller change');
   const keyPath='llm-service/alarm-review/inference';
   await client.query("INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version) VALUES ($1,$2,'aes-256-gcm',1)",[keyPath,cipher.encrypt(crypto.randomBytes(32).toString('hex'))]);
   settings.api_keys.push({name:'alarm-review',scope:'inference',key:'${secret:'+keyPath+'}'});
   await client.query('UPDATE config_documents SET config=$1 WHERE service=$2 AND "group"=$3 AND name=$4',[settings,'llm-service','system','settings']);
  }});console.log(JSON.stringify({version:result.version,caller:'alarm-review'}));
 }
}finally{await store.close();}
