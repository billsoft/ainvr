// Read-only deployed health and consumer freshness, with no credential output.
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {createConfigTransport,loadBootstrap} from '../alarm-service/src/config-center.mjs';
const require=createRequire(new URL('../alarm-service/package.json',import.meta.url)),{MongoClient}=require('mongodb');
const control=createConfigTransport(await loadBootstrap('/home/sunrise/ainvr/deploy/s100p/runtime/alarm-service-bootstrap.json'));
const state=await control('service-states/alarm-service');
const [doc]=await control(`versions/${state.appliedVersion??state.desiredVersion}/snapshot?service=alarm-service`),c=doc.config;
const response=await fetch(`http://127.0.0.1:${c.port}/v1/status`,{headers:{authorization:`Bearer ${c.api_token}`},signal:AbortSignal.timeout(10000)});
if(!response.ok)throw Error('Alarm status unavailable');const status=await response.json();
const client=new MongoClient(c.mongo_uri,{serverSelectionTimeoutMS:5000});
try{
 await client.connect();const rows=await client.db(c.database).collection('alarm_consumer_checkpoints').find({}, {projection:{_id:0,channel_id:1,last_consumed_at:1,last_issues:1,'checkpoint.region_heat.last_frame_at':1,'pending.offset':1},timeoutMS:5000}).limit(30).toArray();
 const result={at:new Date().toISOString(),input:status.input,checkpoints:rows,ready:response.ok};
 await writeFile(new URL('./results/stats-upgrade-20261030/live-check.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await client.close()}
