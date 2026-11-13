import test from 'node:test';
import assert from 'node:assert/strict';
import {createFaceWatchlistTransport} from '../src/face-watchlist-transport.mjs';
import {createVehicleTransport} from '../src/vehicle-transport.mjs';
import {candidate,acknowledged} from './face-watchlist-fixture.mjs';
const bootstrap={control_url:'http://127.0.0.1:8088',service_token:'test-internal-only-'.repeat(3)};
test('reuses bounded BFF service-token client and posts only original ACK references',async t=>{
 const calls=[],c=candidate();t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url:String(url),options});return Response.json(options.method==='POST'?acknowledged(c):{items:[c]});});
 const transport=createFaceWatchlistTransport(bootstrap);await transport.poll(20);await transport.ack(c);
 assert.equal(calls[0].url,'http://127.0.0.1:8088/api/internal/faces/watchlist-outbox?limit=20');
 assert.equal(calls[1].url,'http://127.0.0.1:8088/api/internal/faces/watchlist-outbox/ack');
 assert.equal(calls[0].options.headers['x-service-token'],bootstrap.service_token);assert.equal(calls[1].options.redirect,'error');
 assert.deepEqual(JSON.parse(calls[1].options.body),{record_id:c.record_id,event_id:c.event_id});
 assert.throws(()=>transport.poll(51));assert.throws(()=>createFaceWatchlistTransport({...bootstrap,control_url:'http://external.invalid:8088'}));
 const vehicle=createVehicleTransport(bootstrap);await vehicle({id:'v'},Buffer.from('jpeg'));await vehicle.watchlist(3);
 assert.equal(calls[2].url,'http://127.0.0.1:8088/api/internal/vehicle-recognize');assert.equal(calls[3].url,'http://127.0.0.1:8088/api/internal/vehicle-watchlist/3');
});
test('transport refuses oversized responses, redirects/errors and cancelled work',async t=>{
 const transport=createFaceWatchlistTransport(bootstrap);
 t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(512*1024+1)));
 await assert.rejects(()=>transport.poll(20),/too_large/);
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'forbidden'}},{status:403}));
 await assert.rejects(()=>transport.poll(20),e=>e.code==='forbidden'&&e.status===403);
 t.mock.method(globalThis,'fetch',async(_url,options)=>{assert.equal(options.redirect,'error');options.signal.throwIfAborted();return Response.json({items:[]});});
 const abort=new AbortController();abort.abort();await assert.rejects(()=>transport.poll(20,abort.signal));
});
