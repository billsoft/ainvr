import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {llmProxyRoutes} from '../routes/llmProxy.js';
afterEach(()=>vi.unstubAllGlobals());
it('recording evidence requires alarm identity and uses only configured recorder credentials',async()=>{
 const fetcher=vi.fn(async()=>new Response('{"identity":{}}'));vi.stubGlobal('fetch',fetcher);
 const app=Fastify();await app.register(llmProxyRoutes,{principal:async()=> 'admin',connection:async()=>null,internalPrincipal:async req=>req.headers['x-service-token']==='alarm-test',recordingConnection:async()=>({baseUrl:'http://127.0.0.1:8100',token:'recorder-test'})});
 try{
  const request={method:'POST' as const,url:'/internal/alarm-recording-evidence',payload:{channel_id:'c',url:'http://untrusted'}};
  expect((await app.inject(request)).statusCode).toBe(403);expect(fetcher).not.toHaveBeenCalled();
  expect((await app.inject({...request,headers:{'x-service-token':'alarm-test'}})).statusCode).toBe(200);
  const [url,options]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];expect(url.href).toBe('http://127.0.0.1:8100/v1/recordings/recover-evidence');expect(new Headers(options.headers).get('x-service-token')).toBe('recorder-test');
 }finally{await app.close();}
});
it('recording failure remains retryable and never leaks backend exceptions',async()=>{
 vi.stubGlobal('fetch',async()=>{throw Error('secret')});const app=Fastify();await app.register(llmProxyRoutes,{principal:async()=>null,connection:async()=>null,internalPrincipal:async()=>true,recordingConnection:async()=>({baseUrl:'http://127.0.0.1:8100',token:'test'})});
 try{const result=await app.inject({method:'POST',url:'/internal/alarm-recording-evidence',payload:{}});expect(result.statusCode).toBe(503);expect(result.body).not.toContain('secret');}finally{await app.close();}
});
