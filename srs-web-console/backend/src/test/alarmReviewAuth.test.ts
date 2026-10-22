import {it,expect} from 'vitest';
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
