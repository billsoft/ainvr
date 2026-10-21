import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmZoneRoutes} from '../routes/alarmZoneRoutes.js';
it('旧区域接口只保留读取，不能绕过统一布防事务修改区域',async()=>{
 const save=vi.fn(),list=vi.fn(async()=>[{zone_id:'legacy'}]);
 const app=Fastify();await app.register(alarmZoneRoutes,{readOnly:true,store:{save,list} as any,principal:async()=>'admin',channelExists:async()=>true});
 try{
  expect((await app.inject('/alarms/zones?channel_id=c')).json()).toEqual({items:[{zone_id:'legacy'}]});
  const response=await app.inject({method:'POST',url:'/alarms/zones',headers:{'idempotency-key':'test'},payload:{zone:{channel_id:'c'},expected_version:0}});
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('legacy_read_only');
  expect(save).not.toHaveBeenCalled();
 }finally{await app.close();}
});
it('zone API derives actor on server and rejects missing source or session',async()=>{
  const save=vi.fn().mockResolvedValue({saved:true,monitoring_enabled:false});let authorized=true,exists=true;
  const app=Fastify();await app.register(alarmZoneRoutes,{store:{save,list:async()=>[]} as any,principal:async()=>authorized?'admin':null,channelExists:async()=>exists});
  const request={method:'POST' as const,url:'/alarms/zones',headers:{'idempotency-key':'test','x-ainvr-actor':'spoof'},payload:{zone:{channel_id:'c'},expected_version:0}};
  try{
    expect((await app.inject(request)).statusCode).toBe(200);expect(save.mock.calls[0][2]).toBe('admin');
    exists=false;expect((await app.inject(request)).statusCode).toBe(409);expect(save).toHaveBeenCalledOnce();
    authorized=false;expect((await app.inject(request)).statusCode).toBe(401);
  }finally{await app.close();}
});
