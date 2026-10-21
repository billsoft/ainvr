import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmTriggerRoutes} from '../routes/alarmTriggerRoutes.js';
it('trigger save uses the server catalog of every bound channel and the session actor',async()=>{
  const save=vi.fn(async()=>({saved:true,trigger:{version:1},application:{state:'pending',desired_revision:'1'}}));
  const catalog=vi.fn(async(id:string)=>({channel_id:id,input_stream_id:'in-'+id,label_map_version:'l1',label_ids:['person'],geometry_revision:'g1',tracking_available:true}));
  const app=Fastify();
  await app.register(alarmTriggerRoutes,{store:{save,list:vi.fn(async()=>[])} as never,principal:async()=> 'operator',catalog,synchronization:{synchronize:async()=>{throw Error('secret')}} as never});
  try{
    const r=await app.inject({method:'POST',url:'/alarms/triggers',headers:{'idempotency-key':'op','x-ainvr-actor':'spoof'},payload:{trigger:{trigger_id:'t'},expected_version:0}});
    expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({saved:true,application:{state:'pending'}});expect(r.body).not.toContain('secret');
    const [input,version,actor,key,lookup]=save.mock.calls[0] as unknown as [unknown,number,string,string,(id:string)=>Promise<unknown>];
    expect([input,version,actor,key]).toEqual([{trigger_id:'t'},0,'operator','op']);
    expect(await lookup('yard')).toMatchObject({input_stream_id:'in-yard'});
    expect((await app.inject({method:'POST',url:'/alarms/triggers',payload:{}})).statusCode).toBe(422);
    expect((await app.inject({url:'/alarms/triggers'})).json()).toEqual({items:[]});
  }finally{await app.close();}
});
it('pause and archive do not need any source to be online',async()=>{
  const setState=vi.fn(async()=>({saved:true,trigger:{trigger_id:'t',state:'archived',version:4},application:{state:'pending',desired_revision:'8'}}));
  const catalog=vi.fn(async()=>{throw Error('camera offline')});const app=Fastify();
  await app.register(alarmTriggerRoutes,{store:{setState} as never,principal:async()=> 'operator',catalog,synchronization:{synchronize:async()=>{throw Error('unavailable')}} as never});
  try{
    const response=await app.inject({method:'POST',url:'/alarms/triggers/t/state',headers:{'idempotency-key':'arc'},payload:{state:'archived',expected_version:3}});
    expect(response.statusCode).toBe(200);expect(catalog).not.toHaveBeenCalled();
    expect(setState.mock.calls[0]).toEqual(['t','archived',3,'operator','arc']);
  }finally{await app.close();}
});
it('unauthenticated requests are refused before any store access',async()=>{
  const app=Fastify(),list=vi.fn();
  await app.register(alarmTriggerRoutes,{store:{list} as never,principal:async()=>null,catalog:vi.fn(),synchronization:null});
  try{expect((await app.inject({url:'/alarms/triggers'})).statusCode).toBe(401);expect(list).not.toHaveBeenCalled();}finally{await app.close();}
});
