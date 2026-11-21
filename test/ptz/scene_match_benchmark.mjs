// Invoke only the deployed loopback matcher. No camera, model creation or config writes.
import {access,readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {gradeSceneRegion} from './scene_region_oracle.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
import {PgConfigStore} from '../../srs-web-console/backend/dist/store/pgStore.js';
import {projectScene} from '../../srs-web-console/backend/dist/services/sceneProjection.js';

const dir=path.resolve(process.argv[2]);
const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
const {width,height,maxVertexErrorPx}=manifest;
if(width!==512||height!==384||manifest.cases.length>30)throw Error('Invalid benchmark budget');
process.loadEnvFile('deploy/s100p/runtime/backend.env');
const env=process.env;
await access(env.CONFIG_MASTER_KEY_PATH);
const pg=new PgConfigStore({poolConfig:{host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT||5432),
 user:env.CONFIG_PG_USER,password:env.CONFIG_PG_PASSWORD,database:env.CONFIG_PG_DATABASE,
 options:'-c default_transaction_read_only=on',max:1},masterKeyPath:env.CONFIG_MASTER_KEY_PATH});
let key;
try{key=await pg.getSecret('ai-service/server.api_key');}finally{await pg.pool.end();}
if(!key||key.length<32)throw Error('Native service credential unavailable');
const log=await open(path.join(dir,'observations.jsonl'),'wx',0o644);
const record=async(row)=>{await log.writeFile(JSON.stringify(row)+'\n');await log.sync();};
const deadline=Date.now()+360000;
let requests=0,next=0;
async function bytes(name){
 if(!/^[0-9a-f]{64}\.jpg$/.test(name))throw Error('Invalid fixture name');
 const raw=await readFile(path.join(dir,'fixtures',name));
 if(createHash('sha256').update(raw).digest('hex')!==name.slice(0,64))throw Error('Fixture hash mismatch');
 return raw.toString('base64');
}

try{
 for(const c of manifest.cases){
  const body=JSON.stringify({frame0:await bytes(c.reference),frame1:await bytes(c.current)});
  for(let attempt=1;attempt<=2;attempt++){
   await sleep(Math.max(0,next-Date.now()));
   if(requests>=35||Date.now()+17000>deadline)throw Error('Run budget reached');
   const started=Date.now();requests++;
   const response=await fetch('http://127.0.0.1:8000/internal/ptz/scene-match',{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json','x-service-token':key},body,signal:AbortSignal.timeout(17000)});
   const raw=await response.json();
   const ms=Date.now()-started,at=new Date(started).toISOString();
   next=Date.now()+(response.status===429?12000:6000);
   if(!response.ok){
    await record({name:c.name,category:c.category,attempt,at,ms,http:response.status,code:raw.error?.code});
    console.log(c.name,'HTTP',response.status);
    if(response.status===429)continue;
    if(response.status===401||response.status===403||response.status>=500)throw Error('Service unavailable; stop run');
    break;
   }
   if(!['ainvr.scene-match.v1','ainvr.scene-match.v2'].includes(raw.schema)||raw.backend!=='neuflow-bpu'||typeof raw.matched!=='boolean')throw Error('Unexpected native contract');
   const regions=c.regions.map(r=>gradeSceneRegion(r,raw,projectScene,width,height,maxVertexErrorPx));
   await record({name:c.name,category:c.category,at,ms,attempt,http:200,match:raw,regions});
   console.log(c.name,'global='+raw.matched,regions.map(r=>r.name+'='+r.outcome).join(' '));
   break;
  }
 }
}finally{await log.close();}
