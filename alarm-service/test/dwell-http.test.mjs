import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/http.mjs';
import {DwellQuery} from '../src/dwell-query.mjs';

test('authenticated dwell route validates scope and returns arbitrary-range duration',async()=>{
  const row={_id:'v',channel_id:'c',zone_id:'z',zone_version:1,label_id:'p',started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T00:00:02.000Z',observed_ms:2000};
  const data={region_dwell_visits:{find:()=>({sort(){return this},limit(){return this},async toArray(){return [row];}}),findOne:async()=>({started_at:row.started_at})},alarm_consumer_checkpoints:{findOne:async()=>null}};
  const app=createApp({repository:{dwell:new DwellQuery({collection:n=>data[n]})},apiToken:'a'.repeat(32)});
  const payload={channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00.500Z',to:'2026-01-01T00:00:01.500Z',timezone:'Asia/Shanghai'};
  try{
    assert.equal((await app.inject({method:'POST',url:'/v1/flow/dwell',payload})).statusCode,401);
    const headers={authorization:'Bearer '+ 'a'.repeat(32)};
    const result=await app.inject({method:'POST',url:'/v1/flow/dwell',headers,payload});
    assert.equal(result.statusCode,200);assert.equal(result.json().observed_ms,1000);assert.equal(result.json().coverage,'unknown');assert.equal(result.json().retention.mode,'rolling');
    const invalid=await app.inject({method:'POST',url:'/v1/flow/dwell',headers,payload:{...payload,zone_id:undefined}});
    assert.equal(invalid.statusCode,422);
  }finally{await app.close();}
});
