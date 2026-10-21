import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildTestApp} from './buildTestApp.js';
it('root authentication grants the alarm service only exact GET evidence-source routes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ainvr-alarm-source-auth-'));
 const prior=process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE;
 const token='isolated-alarm-service-token-'.repeat(2);process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE=token;
 const app=await buildTestApp({dataDir:dir,srsApiHost:'127.0.0.1:19859'});
 try{
  await app.inject({method:'PUT',url:'/api/settings/password',payload:{password:'isolated-test-password'}});
  const path=`/api/internal/alarm-evidence/${'a'.repeat(64)}`,headers={'x-service-token':token};
  // It reaches the handler, which reports missing isolated alarm configuration.
  expect((await app.inject({url:path,headers})).statusCode).toBe(503);
  expect((await app.inject({url:path,headers:{'x-service-token':'another-service'}})).statusCode).toBe(401);
  expect((await app.inject({url:'/api/alarms/events',headers})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:path,headers})).statusCode).toBe(401);
  expect((await app.inject({url:path+'?url=http://external.invalid',headers})).statusCode).toBe(422);
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'isolated-test-password'}});
  expect((await app.inject({url:path,headers:{'x-console-token':login.json().data.token}})).statusCode).toBe(403);
 }finally{
  await app.close();await rm(dir,{recursive:true,force:true});
  if(prior===undefined)delete process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE;else process.env.CONFIG_SERVICE_TOKEN_ALARM_SERVICE=prior;
 }
});
