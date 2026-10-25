import {expect,it,vi,afterEach} from 'vitest';import Fastify from 'fastify';import {alarmProxyRoutes} from '../routes/alarmProxy.js';import {hashPassword} from '../services/passwordHash.js';
afterEach(()=>vi.unstubAllGlobals());
const config={baseUrl:'http://127.0.0.1:29999',apiToken:'test-server-secret'.repeat(3),timeoutMs:1000};
it('purge requires current system password and never forwards the password',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"cleared":true,"deleted_count":3}',{status:200}));vi.stubGlobal('fetch',fetcher);let hash=await hashPassword('test-only-system-password');
 const app=Fastify();await app.register(alarmProxyRoutes,{principal:async()=> 'operator',connection:async()=>config,passwordHash:async()=>hash});
 const request={method:'POST' as const,url:'/alarms/purge',headers:{'idempotency-key':'purge-operation'}};
 try{
  expect((await app.inject({...request,payload:{scope:'all',password:'wrong'}})).statusCode).toBe(403);expect(fetcher).not.toHaveBeenCalled();
  expect((await app.inject({...request,payload:{scope:'all',password:'test-only-system-password'}})).statusCode).toBe(200);
  const [url,options]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];expect(url.pathname).toBe('/v1/events/purge');expect(JSON.parse(options.body as string)).toEqual({scope:'all'});expect(JSON.stringify(options)).not.toContain('test-only-system-password');expect(new Headers(options.headers).get('x-ainvr-actor')).toBe('operator');
  hash='';expect((await app.inject({...request,payload:{scope:'all',password:'test-only-system-password'}})).statusCode).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{await app.close()}
});
it('purge rejects logged out callers, throttles incorrect passwords, and fails closed on password store failure',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const hash=await hashPassword('test-password');
 for(const failure of ['unauthorized','storage','wrong']){
  const app=Fastify();await app.register(alarmProxyRoutes,{principal:async()=>failure==='unauthorized'?null:'operator',connection:async()=>config,passwordHash:async()=>{if(failure==='storage')throw Error('private-store-error');return hash}});
  try{const run=()=>app.inject({method:'POST',url:'/alarms/purge',headers:{'idempotency-key':'key'},payload:{scope:'all',password:'wrong'}});
   if(failure==='wrong'){for(let i=0;i<8;i++)expect((await run()).statusCode).toBe(403);expect((await run()).statusCode).toBe(429)}else{const result=await run();expect(result.statusCode).toBe(failure==='unauthorized'?401:503);expect(result.body).not.toContain('private-store-error')}
  }finally{await app.close()}
 }
 expect(fetcher).not.toHaveBeenCalled();
});
