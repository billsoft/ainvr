import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {alarmProxyRoutes} from '../routes/alarmProxy.js';
const config = {baseUrl:'http://127.0.0.1:29999',apiToken:'server-only-test-token-'.repeat(3),timeoutMs:1000};
afterEach(() => {vi.unstubAllGlobals();});
it('named alarm proxy replaces spoofed actor and credentials, preserves idempotency, hides internal endpoints', async()=>{
  const fetcher=vi.fn(async()=>new Response('{"items":[]}',{status:200}));vi.stubGlobal('fetch',fetcher);
  const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>config,principal:async()=> 'console-administrator'});
  try {
    const response=await app.inject({method:'POST',url:'/alarms/events/e/acknowledgements',payload:{expected_handling_revision:0},headers:{authorization:'evil','x-ainvr-actor':'evil','idempotency-key':'test-key','x-console-token':'private-session'}});
    expect(response.statusCode).toBe(200);
    const [url,request]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
    expect(url.pathname).toBe('/v1/events/e/acknowledgements');
    const headers=new Headers(request.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${config.apiToken}`);
    expect(headers.get('x-ainvr-actor')).toBe('console-administrator');
    expect(headers.get('idempotency-key')).toBe('test-key');expect(headers.has('x-console-token')).toBe(false);
    expect((await app.inject({method:'POST',url:'/alarms/observations',payload:{}})).statusCode).toBe(404);
    expect((await app.inject('/alarms/events?target=http://evil')).statusCode).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await app.inject('/alarms/events?status=all&review=failed&limit=20')).statusCode).toBe(200);
    const filtered=fetcher.mock.calls[1][0] as unknown as URL;
    expect(filtered.searchParams.get('status')).toBe('all');expect(filtered.searchParams.get('review')).toBe('failed');
  }finally{await app.close();}
});
it('fails closed without principal or configuration, rejects untrusted destinations and sanitizes transport errors',async()=>{
  const fetcher=vi.fn(async()=>{throw Error('mongodb://user:secret');});vi.stubGlobal('fetch',fetcher);
  for(const [principal,connection,expected] of [[null,config,401],['admin',null,503],['admin',{...config,baseUrl:'http://external.invalid:80'},502],['admin',config,502]] as const){
    const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>connection,principal:async()=>principal});
    try{const r=await app.inject('/alarms/status');expect(r.statusCode).toBe(expected);expect(r.body).not.toContain('secret');}finally{await app.close();}
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('requires operation key before forwarding mutations; service auth failure does not invalidate console session',async()=>{
  const fetcher=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetcher);
  const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>config,principal:async()=> 'admin'});
  try{
    expect((await app.inject({method:'POST',url:'/alarms/rules',payload:{}})).statusCode).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await app.inject('/alarms/capabilities')).statusCode).toBe(502);
  }finally{await app.close();}
});

it('legacy direct rule mutations fail locally even with an operation key',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>config,principal:async()=> 'admin'});
 try{
  const response=await app.inject({method:'POST',url:'/alarms/rules',headers:{'idempotency-key':'op'},payload:{rule:{}}});
  expect(response.statusCode).toBe(405);expect(response.json().error.code).toBe('configuration_authority');expect(fetcher).not.toHaveBeenCalled();
 }finally{await app.close();}
});
it('statistics and behavior history forward the trigger filter and grouping',async()=>{
  const fetcher=vi.fn(async()=>new Response('{"items":[]}',{status:200}));vi.stubGlobal('fetch',fetcher);
  const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>config,principal:async()=> 'console-administrator'});
  try{
    expect((await app.inject('/alarms/behavior-statistics?from=a&to=b&bucket=hour&trigger_id=t1&group_by=trigger')).statusCode).toBe(200);
    expect((await app.inject('/alarms/behavior-events?from=a&to=b&trigger_id=t1')).statusCode).toBe(200);
    for(const call of fetcher.mock.calls)expect((call[0] as unknown as URL).searchParams.get('trigger_id')).toBe('t1');
    expect((fetcher.mock.calls[0]![0] as unknown as URL).searchParams.get('group_by')).toBe('trigger');
  }finally{await app.close();}
});

it('pending summary is authenticated, unfiltered and independent of page size',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"pending":202,"as_of":"2026-10-20T00:00:00Z"}'));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();await app.register(alarmProxyRoutes,{connection:async()=>config,principal:async req=>req.headers['x-test-login']?'admin':null});
 try{
  expect((await app.inject('/alarms/events/summary')).statusCode).toBe(401);
  const response=await app.inject({url:'/alarms/events/summary',headers:{'x-test-login':'1'}});
  expect(response.json().pending).toBe(202);
  expect((fetcher.mock.calls[0]![0] as unknown as URL).pathname).toBe('/v1/events/summary');
  expect((await app.inject({url:'/alarms/events/summary?limit=50',headers:{'x-test-login':'1'}})).statusCode).toBe(400);
 }finally{await app.close();}
});
