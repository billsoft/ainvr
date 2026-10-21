import Fastify from 'fastify';
import {it,expect,vi} from 'vitest';
import {alarmTriggerRoutes} from '../routes/alarmTriggerRoutes.js';
it('迁移后旧客户端不能重启旧规则，读取仍可追溯',async()=>{
 const save=vi.fn(),setState=vi.fn(),list=vi.fn(async()=>[]);
 const app=Fastify();
 await app.register(alarmTriggerRoutes,{readOnly:true,store:{save,setState,list} as never,
  principal:async()=>'operator',catalog:async()=>null,synchronization:null});
 try{
  for(const url of ['/alarms/triggers','/alarms/triggers/t/state','/alarms/triggers/synchronize']){
   const response=await app.inject({method:'POST',url,payload:{}});
   expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('configuration_moved');
  }
  expect(save).not.toHaveBeenCalled();expect(setState).not.toHaveBeenCalled();
  expect((await app.inject({url:'/alarms/triggers'})).statusCode).toBe(200);
 }finally{await app.close();}
});
