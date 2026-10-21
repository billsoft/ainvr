import {it,expect} from 'vitest';
import Fastify from 'fastify';
import {prepareAlarmConfiguration} from '../services/alarmConfigurationStartup.js';
it('migration failure blocks configuration and sync but leaves other routes and historical alarm reads available',async()=>{
 const app=Fastify();let handled=0;
 expect(await prepareAlarmConfiguration(app,async()=>{throw Error('private identity conflict')},async req=>req.headers.authorization?'operator':null)).toBe(false);
 for(const path of ['/api/alarms/definitions','/api/alarms/arming/cam','/api/alarms/triggers/synchronize','/api/alarms/zones'])app.all(path,async()=>{handled++;return {ok:true}});
 app.get('/api/channels',async()=>({ok:true}));app.get('/api/alarms/events',async()=>({ok:true}));
 try{
  for(const url of ['/api/alarms/definitions','/api/alarms/arming/cam','/api/alarms/triggers/synchronize','/api/alarms/zones']){
   expect((await app.inject({url})).statusCode).toBe(401);
   const response=await app.inject({url,headers:{authorization:'session'}});expect(response.statusCode).toBe(503);expect(response.body).not.toContain('private identity');
  }
  expect(handled).toBe(0);expect((await app.inject('/api/channels')).statusCode).toBe(200);expect((await app.inject('/api/alarms/events')).statusCode).toBe(200);
 }finally{await app.close()}
});
it('successful migration permits normal routes',async()=>{
 const app=Fastify();expect(await prepareAlarmConfiguration(app,async()=>({converted:0}),async()=>null)).toBe(true);
 app.get('/api/alarms/definitions',async()=>({ok:true}));try{expect((await app.inject('/api/alarms/definitions')).statusCode).toBe(200)}finally{await app.close()}
});
