import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmProxyRoutes} from '../routes/alarmProxy.js';
afterEach(()=>vi.unstubAllGlobals());
it('authenticates analytics, forwards body without operation key, and bounds analytics query separately',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"total":2}'));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>({baseUrl:'http://127.0.0.1:29999',apiToken:'test-token-'.repeat(5),timeoutMs:1000}),principal:async r=>r.headers['x-test-login']?'admin':null});
 const body={from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',timezone:'Asia/Shanghai',bucket:'hour'};const headers={'x-test-login':'1','x-ainvr-actor':'spoofed'};
 try{
  expect((await app.inject({method:'POST',url:'/alarms/events/analytics',payload:body})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/alarms/events/analytics',payload:body,headers})).json().total).toBe(2);
  const [url,options]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];expect(url.pathname).toBe('/v1/events/analytics');expect(JSON.parse(options.body as string)).toEqual(body);expect(new Headers(options.headers).get('x-ainvr-actor')).toBe('admin');
  const locations=Array.from({length:100},(_,i)=>({channel_id:'c'+i,zone_id:'z'+i}));
  const scope=JSON.stringify({...body,locations,trigger_id:'t'.repeat(256),primary_type:'p'.repeat(256)});expect(JSON.stringify(locations).length).toBeLessThanOrEqual(4096);expect(scope.length).toBeGreaterThan(4096);expect(scope.length).toBeLessThanOrEqual(8192);
  expect((await app.inject({url:'/alarms/events?'+new URLSearchParams({analytics:scope,status:'all'}),headers})).statusCode).toBe(200);
  expect((fetcher.mock.calls[1]![0] as unknown as URL).searchParams.get('analytics')).toBe(scope);
  expect((await app.inject({url:'/alarms/events?'+new URLSearchParams({analytics:'x'.repeat(8193)}),headers})).statusCode).toBe(400);
  expect((await app.inject({url:'/alarms/events?'+new URLSearchParams({locations:'x'.repeat(4097)}),headers})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/alarms/events/analytics?extra=1',payload:body,headers})).statusCode).toBe(400);
 }finally{await app.close()}
});
it('preserves capacity errors and sanitizes upstream failures',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"error":{"code":"analytics_capacity"}}',{status:422}));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>({baseUrl:'http://127.0.0.1:29999',apiToken:'test-token-'.repeat(5),timeoutMs:1000}),principal:async()=> 'admin'});
 try{
  const r=await app.inject({method:'POST',url:'/alarms/events/analytics',payload:{}});expect(r.statusCode).toBe(422);expect(r.json().error.code).toBe('analytics_capacity');
  fetcher.mockImplementationOnce(async()=>{throw Error('secret')});const e=await app.inject({method:'POST',url:'/alarms/events/analytics',payload:{}});expect(e.statusCode).toBe(502);expect(e.body).not.toContain('secret');
 }finally{await app.close()}
});
