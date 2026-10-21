import Fastify from 'fastify';
import {it,expect,vi} from 'vitest';
import {alarmArmingRoutes} from '../routes/alarmArmingRoutes.js';
import {AlarmConfigError} from '../store/alarmZones.js';

const result={saved:true,sourceId:'camera',revision:1,application:{state:'pending',desired_revision:'1'}};
function options(){
  return {
    store:{listDefinitions:vi.fn(async()=>[]),readArming:vi.fn(async()=>null),
      saveDefinition:vi.fn(async()=>result),saveArming:vi.fn(async()=>result)},
    principal:vi.fn(async():Promise<string|null>=>'operator'),
    catalog:vi.fn(async()=>null),sourceGeometry:vi.fn(async()=>'g'),
    synchronization:{synchronize:vi.fn(async()=>{throw Error('internal credentials');})},
  };
}
it('拒绝未登录操作，不能伪造审计身份',async()=>{
  const o=options();o.principal.mockResolvedValue(null);
  const app=Fastify();await app.register(alarmArmingRoutes,o as never);
  try{
    expect((await app.inject({url:'/alarms/definitions'})).statusCode).toBe(401);
    expect(o.store.listDefinitions).not.toHaveBeenCalled();
  }finally{await app.close();}
});
it('定义保存无通道，服务离线仍返回已保存及待应用',async()=>{
  const o=options(),app=Fastify();await app.register(alarmArmingRoutes,o as never);
  try{
    const response=await app.inject({method:'POST',url:'/alarms/definitions',
      headers:{'idempotency-key':'op','x-ainvr-actor':'spoof'},
      payload:{definition:{trigger_id:'t'},expected_version:0}});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual(result);
    expect(response.body).not.toContain('credentials');
    expect(o.store.saveDefinition.mock.calls[0]).toEqual([{trigger_id:'t'},0,'operator','op',o.catalog]);
  }finally{await app.close();}
});
it('布防身份来自路径且严格校验请求，传入服务端来源校验',async()=>{
  const o=options(),app=Fastify();await app.register(alarmArmingRoutes,o as never);
  try{
    const input={source_id:'camera',geometry_revision:'g',zones:[],assignments:[]};
    const send=(payload:unknown)=>app.inject({method:'POST',url:'/alarms/arming/camera',
      headers:{'idempotency-key':'op'},payload:payload as object});
    expect((await send({arming:{...input,source_id:'other'},expected_revision:0})).statusCode).toBe(422);
    expect((await send({arming:input,expected_revision:0,actor:'spoof'})).statusCode).toBe(422);
    expect(o.store.saveArming).not.toHaveBeenCalled();
    expect((await send({arming:input,expected_revision:0})).statusCode).toBe(200);
    expect(o.store.saveArming.mock.calls[0]).toEqual([input,0,'operator','op',o.catalog,o.sourceGeometry]);
    expect((await app.inject({url:'/alarms/arming/camera'})).json()).toEqual({arming:null});
  }finally{await app.close();}
});
it('冲突与不可用状态不伪装为保存成功',async()=>{
  const o=options();o.store.saveArming.mockRejectedValue(new AlarmConfigError('version_conflict','布防已变化',409));
  const app=Fastify();await app.register(alarmArmingRoutes,o as never);
  try{
    expect((await app.inject({method:'POST',url:'/alarms/arming/camera',headers:{'idempotency-key':'op'},
      payload:{arming:{source_id:'camera'},expected_revision:1}})).statusCode).toBe(409);
    expect(o.synchronization.synchronize).not.toHaveBeenCalled();
  }finally{await app.close();}
});
