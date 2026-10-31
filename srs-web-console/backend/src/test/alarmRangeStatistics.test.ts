import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {alarmProxyRoutes} from '../routes/alarmProxy.js';

afterEach(()=>vi.unstubAllGlobals());
it('forwards authenticated scoped alarm statistics without an idempotency key',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({total:2,as_of:'2026-10-03T00:00:00Z',handling:{acknowledged:2},review:{skipped:2}})));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();
 await app.register(alarmProxyRoutes,{prefix:'/api',connection:async()=>({baseUrl:'http://127.0.0.1:29999',apiToken:'server-only-token-'.repeat(3),timeoutMs:1000}),principal:async req=>req.headers['x-test-login']?'operator':null});
 const body={from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',locations:[{channel_id:'a',zone_id:'x'},{channel_id:'b',zone_id:'y'}]};
 try{
  expect((await app.inject({method:'POST',url:'/api/alarms/events/statistics',payload:body})).statusCode).toBe(401);
  const response=await app.inject({method:'POST',url:'/api/alarms/events/statistics',headers:{'x-test-login':'1','x-ainvr-actor':'spoofed'},payload:body});
  expect(response.statusCode).toBe(200);expect(response.json().total).toBe(2);
  const [url,options]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.pathname).toBe('/v1/events/statistics');expect(JSON.parse(options.body as string)).toEqual(body);
  expect(new Headers(options.headers).get('x-ainvr-actor')).toBe('operator');
  expect((await app.inject({method:'POST',url:'/api/alarms/events/statistics?extra=1',headers:{'x-test-login':'1'},payload:body})).statusCode).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{await app.close()}
});


it('forwards the exact multi-location list selection as one query parameter',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"items":[],"next_cursor":null,"as_of":"now"}'));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();
 await app.register(alarmProxyRoutes,{prefix:'/api',connection:async()=>({baseUrl:'http://127.0.0.1:29999',apiToken:'server-only-token-'.repeat(3),timeoutMs:1000}),principal:async()=> 'operator'});
 const locations=JSON.stringify([{channel_id:'a',zone_id:'x'},{channel_id:'b',zone_id:'y'}]);
 const query=new URLSearchParams({status:'all',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',locations});
 try{
  const response=await app.inject({url:'/api/alarms/events?'+query});
  expect(response.statusCode).toBe(200);
  const url=fetcher.mock.calls[0]![0] as unknown as URL;
  expect(url.pathname).toBe('/v1/events');expect(url.searchParams.get('locations')).toBe(locations);
 }finally{await app.close()}
});
