// Single bounded candidate probe per reservation. No network inference or camera control.
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const pg=createRequire(path.resolve('srs-web-console/backend/package.json'))('pg');
const run=promisify(execFile);
const [out,mode]=process.argv.slice(2);
if(mode && mode!=='--timing')throw Error('Unknown replay option');
const pinned=path.resolve(out,'pinned');
const hashes=JSON.parse(await readFile(path.join(pinned,'sha256.json'),'utf8'));
const hash=async(file)=>createHash('sha256').update(await readFile(file)).digest('hex');
for(const [name,want] of Object.entries(hashes)){
 if(await hash(path.join(pinned,name))!==want)throw Error('Changed pinned file '+name);
}
if(path.resolve(fileURLToPath(import.meta.url))!==path.join(pinned,'replay.mjs'))throw Error('Run the pinned runner');
const probe=path.join(pinned,'candidate-probe');
const {projectScene}=await import(pathToFileURL(path.join(pinned,'projection.mjs')));
const {gradeSceneRegion}=await import(pathToFileURL(path.join(pinned,'grade.mjs')));
const suites=['live','subcell','original','independent'].map(n=>path.join(pinned,n));
process.loadEnvFile('deploy/s100p/runtime/backend.env');
const e=process.env;
const db=new pg.Client({host:e.CONFIG_PG_HOST,port:Number(e.CONFIG_PG_PORT||5432),user:e.CONFIG_PG_USER,
 password:e.CONFIG_PG_PASSWORD,database:e.CONFIG_PG_DATABASE,options:'-c default_transaction_read_only=on',
 application_name:'scene-candidate-offline-replay',statement_timeout:3000});
const deadline=Date.now()+15*60000;
const key="hashtextextended('arming-scene-hardware',0)";
const cases=[];
for(const dir of suites){
 const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
 for(const c of manifest.cases)if(!mode||c.name==='translate8')cases.push({dir,m:manifest,c});
}
if(!cases.length||cases.length>45)throw Error('Expected 1–45 fixture pairs');
await db.connect();
const log=await open(path.join(out,mode?'timing.jsonl':'observations.jsonl'),'wx');
try{
 for(const {dir,m,c} of cases){
  const files=[];
  for(const name of [c.reference,c.current]){
   if(!/^[0-9a-f]{64}\.jpg$/.test(name))throw Error('Invalid fixture');
   const f=path.resolve(dir,'fixtures',name);
   if(createHash('sha256').update(await readFile(f)).digest('hex')!==name.slice(0,64))throw Error('Fixture hash mismatch');
   files.push(f);
  }
  let waits=0;
  while(true){
   if(Date.now()+18000>deadline)throw Error('Suite wall clock budget exhausted');
   const {rows:[lock]}=await db.query('select pg_try_advisory_lock('+key+') as held');
   if(lock.held)break;
   waits++;
   await sleep(3000);
  }
  let match,ms;
  try{
   const started=Date.now();
   if(await hash(probe)!==hashes['candidate-probe'])throw Error('Pinned probe hash changed');
   const {stdout}=await run(probe,[path.resolve('ai-service'),...files,mode?'--scene-timing':'--scene'],
       {timeout:mode?30000:17500,killSignal:'SIGKILL',maxBuffer:262144});
   if(mode){
    const timing=stdout.split('\n').filter(l=>l.startsWith('{"iteration"')).map(l=>JSON.parse(l));
    const result=stdout.split('\n').find(l=>l.startsWith('{"timingEvidence"'));
    if(timing.length!==4||!result)throw Error('Missing native timings');
    await log.writeFile(JSON.stringify({name:c.name,waits,timing,match:JSON.parse(result).timingEvidence})+'\n');
    await log.sync();console.log(JSON.stringify(timing));continue;
   }
   ms=Date.now()-started;
   const line=stdout.split('\n').find(line=>line.startsWith('{"backend":'));
   if(!line)throw Error('Candidate produced no native JSON');
   match=JSON.parse(line);
   if(match.schema!=='ainvr.scene-match.v2'||match.backend!=='neuflow-bpu'||
      (match.matched&&match.localEvidence?.length!==12288))throw Error('Native evidence contract mismatch');
  }finally{await db.query('select pg_advisory_unlock('+key+')');}
  const regions=c.regions.map(z=>gradeSceneRegion(z,match,projectScene,m.width,m.height,m.maxVertexErrorPx));
  await log.writeFile(JSON.stringify({name:c.name,category:c.category,dir,at:new Date().toISOString(),ms,waits,match,regions})+'\n');
  await log.sync();
  console.log(c.name,ms+'ms',regions.map(r=>r.outcome).join(' '));
  await sleep(6000);
 }
}finally{await log.close();await db.end();}
