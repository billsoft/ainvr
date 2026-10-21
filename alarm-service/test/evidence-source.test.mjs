import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceSource} from '../src/evidence-source.mjs';
test('private evidence transport uses only the configured local BFF and service identity',async t=>{
 const bootstrap={control_url:'http://127.0.0.1:8088',service_token:'alarm-config-test-'.repeat(3)},calls=[];
 const source=createEvidenceSource(bootstrap),id='a'.repeat(64);
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options});return String(url).includes('/image?')?new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}):new Response(JSON.stringify({state:'available'}));});
 assert.equal((await source.metadata(id)).state,'available');assert.deepEqual(await source.image(id,'original'),Buffer.from([255,216,255,217]));
 assert.equal(calls[0].url,`http://127.0.0.1:8088/api/internal/alarm-evidence/${id}`);
 assert.equal(calls[1].options.headers['x-service-token'],bootstrap.service_token);assert.equal(calls[1].options.redirect,'error');
 await assert.rejects(source.metadata('../elsewhere'));await assert.rejects(source.image(id,'url=http://elsewhere'));
 for(const patch of [{control_url:'http://remote.invalid:8088'},{control_url:'http://127.0.0.1:8088/wrong'},{service_token:'short'}])assert.throws(()=>createEvidenceSource({...bootstrap,...patch}));
});
