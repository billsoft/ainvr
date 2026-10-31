// Read-only, serial sample of the deployed BFF handler and real PG/Mongo data.
// No listener, configuration write, synthetic counter or production data mutation.
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {loadBootstrap,createConfigTransport} from '../alarm-service/src/config-center.mjs';
import {flowRoutes} from '../srs-web-console/backend/dist/routes/flowRoutes.js';
import {AlarmArmingStore} from '../srs-web-console/backend/dist/store/alarmArmingStore.js';
const require=createRequire(new URL('../srs-web-console/backend/package.json',import.meta.url));
const Fastify=require('fastify'),{Pool}=require('pg');
process.loadEnvFile('/home/sunrise/ainvr/deploy/s100p/runtime/backend.env');
const pool=new Pool({host:process.env.CONFIG_PG_HOST,port:Number(process.env.CONFIG_PG_PORT),user:process.env.CONFIG_PG_USER,
  password:process.env.CONFIG_PG_PASSWORD,database:process.env.CONFIG_PG_DATABASE,max:2,options:'-c default_transaction_read_only=on'});
const app=Fastify();
try{
  const bootstrap=await loadBootstrap('/home/sunrise/ainvr/deploy/s100p/runtime/alarm-service-bootstrap.json');
  const control=createConfigTransport(bootstrap),state=await control('service-states/alarm-service');
  const docs=await control(`versions/${state.appliedVersion??state.desiredVersion}/snapshot?service=alarm-service`),config=docs[0].config;
  const store=new AlarmArmingStore(pool),counter=(await store.listCounters()).find(c=>c.bindings.length);
  if(!counter)throw Error('No existing counter with a binding');
  await app.register(flowRoutes,{store,principal:async()=> 'local-readonly-benchmark',catalog:async()=>null,synchronization:null,
    connection:async()=>({baseUrl:`http://127.0.0.1:${config.port}`,apiToken:config.api_token,timeoutMs:15000})});
  const status=async()=>{const r=await fetch(`http://127.0.0.1:${config.port}/v1/status`,{headers:{authorization:`Bearer ${config.api_token}`},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Status unavailable');return r.json()};
  const health=async()=>{const r=await fetch('http://127.0.0.1:8100/v1/recorder/health',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Recorder health unavailable');const h=await r.json();return {ok:h.ok,storageHealthy:h.storageHealthy,droppedMsLastHour:h.droppedMsLastHour,writeDegradedChannels:h.writeDegradedChannels}};
  const before=await status(),recorderBefore=await health(),started=Date.now(),to=new Date().toISOString(),results=[];
  for(const days of [1,7,28]){
    const from=new Date(Date.parse(to)-days*86400000).toISOString(),samples=[],bytes=[];
    for(let i=0;i<20;i++){
      const begin=performance.now();const response=await app.inject({method:'POST',url:'/flow/query',payload:{counter_ids:[counter.counter_id],from,to,bucket:'hour',timezone:'Asia/Shanghai'}});
      if(response.statusCode!==200)throw Error(`Read-only ${days}-day query returned ${response.statusCode}`);
      samples.push(performance.now()-begin);bytes.push(Buffer.byteLength(response.body));
    }
    samples.sort((a,b)=>a-b);
    const rounded=n=>Math.round(n*10)/10;
    results.push({days,n:20,p50_ms:rounded(samples[9]),sample_p95_ms:rounded(samples[18]),max_ms:rounded(samples[19]),max_body_bytes:Math.max(...bytes)});
  }
  const after=await status(),recorderAfter=await health();
  const result={sampled_at:new Date().toISOString(),elapsed_ms:Date.now()-started,
    scope:'Deployed flow route, read-only PG store, live alarm-service/Mongo HTTP; one actual counter, 20 serial samples per range. Excludes public nginx and console auth, not a 50-counter or long-duration load test.',
    results,alarm:{rss_before:before.process.rss_bytes,rss_after:after.process.rss_bytes,input_before:before.input,input_after:after.input},
    recorder:{before:recorderBefore,after:recorderAfter},protected_pids:Object.fromEntries(['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-llm','ainvr-search'].map(name=>[name,execFileSync('systemctl',['show',name,'-p','MainPID','--value']).toString().trim()]))};
  await writeFile(new URL('./results/stats-analytics-20261030/flow-benchmark.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await app.close();await pool.end();}
