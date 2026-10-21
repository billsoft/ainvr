import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AlarmTriggerStore,TriggerSourceCatalog} from '../store/alarmTriggers.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import type {AlarmRuleSync} from '../services/alarmRuleSync.js';
interface Options {
  readOnly?:boolean;
  store:AlarmTriggerStore|null;
  principal:(request:FastifyRequest)=>Promise<string|null>;
  catalog:(channelId:string)=>Promise<TriggerSourceCatalog|null>;
  synchronization:AlarmRuleSync|null;
}
export async function alarmTriggerRoutes(app:FastifyInstance,options:Options){
  app.addHook('preHandler',async(req,reply)=>{
    if(!await options.principal(req))return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    if(!options.store)return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数库暂不可用'}});
    if(options.readOnly&&req.method!=='GET')return reply.code(409).send({error:{code:'configuration_moved',message:'触发器管理已更新，请刷新页面使用新版布防。'}});
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof AlarmConfigError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数操作未确认，请保留草稿后重试'}});
  });
  // A failed apply must not turn a durable save into an ambiguous HTTP failure.
  const apply=async<T extends {application:unknown}>(result:T)=>{
    if(!options.synchronization)return result;
    try{return {...result,application:await options.synchronization.synchronize()};}catch{return result;}
  };
  app.get('/alarms/sources/:id',async req=>{
    const catalog=await options.catalog((req.params as {id:string}).id);
    if(!catalog)throw new AlarmConfigError('source_unavailable','来源、标签或最近结果尚未确认，请检查 AI 通道状态',409);
    return catalog;
  });
  app.get('/alarms/triggers',async()=>({items:await options.store!.list()}));
  app.post('/alarms/triggers',async req=>{
    const body=req.body as {trigger?:{trigger_id?:unknown};expected_version?:unknown}|null;
    const key=req.headers['idempotency-key'];
    if(!body||Object.keys(body).some(k=>!['trigger','expected_version'].includes(k))||typeof body.expected_version!=='number'||!body.trigger||typeof body.trigger!=='object'||typeof key!=='string')
      throw new AlarmConfigError('invalid_request','触发器参数或操作编号无效');
    const actor=await options.principal(req);if(!actor)throw new AlarmConfigError('unauthorized','需要登录',401);
    return apply(await options.store!.save(body.trigger,body.expected_version,actor,key,options.catalog));
  });
  app.post('/alarms/triggers/:id/state',async req=>{
    const body=req.body as {state?:unknown;expected_version?:unknown}|null;
    const key=req.headers['idempotency-key'];
    if(!body||Object.keys(body).some(k=>!['state','expected_version'].includes(k))||typeof body.expected_version!=='number'||typeof key!=='string')throw new AlarmConfigError('invalid_request','状态变更参数无效');
    const actor=await options.principal(req);if(!actor)throw new AlarmConfigError('unauthorized','需要登录',401);
    return apply(await options.store!.setState((req.params as {id:string}).id,body.state,body.expected_version,actor,key));
  });
  app.post('/alarms/triggers/synchronize',async()=>options.synchronization?
    options.synchronization.synchronize():{state:'unavailable',reason:'告警服务尚未配置'});
}
