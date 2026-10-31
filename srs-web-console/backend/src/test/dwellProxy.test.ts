import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmProxyRoutes} from '../routes/alarmProxy.js';
afterEach(()=>vi.unstubAllGlobals());
it.each(['dwell','heat'])('authenticates and forwards %s queries through the existing service connection',async kind=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({observed_ms:1200,visits_started:1,coverage:'unknown'}),{headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',fetcher);
 const app=Fastify();
 await app.register(alarmProxyRoutes,{prefix:'/api',connection:async()=>({baseUrl:'http://127.0.0.1:29999',apiToken:'a'.repeat(32),timeoutMs:1000}),principal:async req=>req.headers['x-test-login']?'operator':null});
 const payload={channel_id:'processor',zone_id:'zone',from:'2026-10-30T00:00:01Z',to:'2026-10-30T01:00:08Z',bucket:'hour',timezone:'Asia/Shanghai'};
 try{
  expect((await app.inject({method:'POST',url:`/api/flow/${kind}`,payload})).statusCode).toBe(401);
  const result=await app.inject({method:'POST',url:`/api/flow/${kind}`,payload,headers:{'x-test-login':'1','x-ainvr-actor':'spoofed'}});
  expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({observed_ms:1200,coverage:'unknown'});
  const [url,options]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.pathname).toBe(`/v1/flow/${kind}`);expect(JSON.parse(String(options.body))).toEqual(payload);
  expect(new Headers(options.headers).get('x-ainvr-actor')).toBe('operator');
  expect((await app.inject({method:'POST',url:`/api/flow/${kind}?extra=1`,payload,headers:{'x-test-login':'1'}})).statusCode).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{await app.close()}
});
