import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {llmProxyRoutes} from '../routes/llmProxy.js';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {buildTestApp} from './buildTestApp.js';
it('only alarm service bypasses console login for the exact review POST',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-auth-'));
 const prev=process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE;process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE='test-alarm-review';
 const app=await buildTestApp({dataDir:dir});
 try{
 await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'test-local-password'}});
 const request={method:'POST' as const,url:'/api/internal/alarm-review',payload:{}};
 expect((await app.inject(request)).statusCode).toBe(401);
 expect((await app.inject({...request,headers:{'x-service-token':'wrong'}})).statusCode).toBe(401);
 const headers={'x-service-token':'test-alarm-review'};
 expect((await app.inject({...request,headers})).statusCode).not.toBe(401);
 expect((await app.inject({url:request.url,headers})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/api/internal/another',headers,payload:{}})).statusCode).toBe(401);
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});if(prev===undefined)delete process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE;else process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE=prev;}
});

it('alarm review rejects text-only or unlabelled evidence before contacting the model',async()=>{
 const app=Fastify();
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({schema:'ainvr.alarm_review.v1'}));
 await app.register(llmProxyRoutes,{prefix:'/api',principal:async()=>null,internalPrincipal:async()=>true,
  connection:async()=>null,reviewConnection:async()=>({baseUrl:'http://127.0.0.1:8300',admin:'test',inference:'test'})});
 try{
  for(const payload of [{alarm:{kind:'人',description:'坐标证明已经进入'}},{image:{jpeg_base64:'/9j/2Q==',fit:'strict'}}]){
   const response=await app.inject({method:'POST',url:'/api/internal/alarm-review',payload});
   expect(response.statusCode).toBe(422);expect(response.json().error.code).toBe('invalid_alarm_evidence');
  }
  expect(fetcher).not.toHaveBeenCalled();
  const valid=await app.inject({method:'POST',url:'/api/internal/alarm-review',payload:{image:{jpeg_base64:'/9j/2Q==',fit:'strict'},alarm:{kind:'人',description:'仅核对目标类别'}}});
  expect(valid.statusCode).toBe(200);expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{await app.close();fetcher.mockRestore();}
});
