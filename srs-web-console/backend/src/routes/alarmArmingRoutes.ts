import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AlarmArmingStore} from '../store/alarmArmingStore.js';
import type {AssignmentSource} from '../store/alarmTriggerDefinition.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import type {AlarmRuleSync} from '../services/alarmRuleSync.js';

interface Options{
  store:AlarmArmingStore|null;
  principal:(request:FastifyRequest)=>Promise<string|null>;
  catalog:(id:string)=>Promise<AssignmentSource|null>;
  sourceGeometry:(id:string)=>Promise<string|null>;
  synchronization:AlarmRuleSync|null;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
export async function alarmArmingRoutes(app:FastifyInstance,options:Options){
  const actors=new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async(req,reply)=>{
    const actor=await options.principal(req);
    if(!actor)return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    actors.set(req,actor);
    if(!options.store)return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数库暂不可用'}});
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof AlarmConfigError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    return reply.code(503).send({error:{code:'configuration_unavailable',message:'保存结果未确认，请保留草稿后重试'}});
  });
  const apply=async<T extends {application:unknown}>(result:T)=>{
    if(!options.synchronization)return result;
    try{return {...result,application:await options.synchronization.synchronize()};}catch{return result;}
  };
  function request(req:FastifyRequest,field:string,versionField:string){
    const body=req.body,key=req.headers['idempotency-key'];
    if(!object(body)||Object.keys(body).some(k=>k!==field&&k!==versionField)||!object(body[field])||
      !Number.isSafeInteger(body[versionField])||(body[versionField] as number)<0||!identifier(key))
      throw new AlarmConfigError('invalid_request','参数、版本或操作编号无效');
    return {input:body[field],version:body[versionField] as number,key,actor:actors.get(req)!};
  }
  function source(req:FastifyRequest){
    const id=(req.params as {id?:unknown}).id;
    if(!identifier(id))throw new AlarmConfigError('invalid_source','来源编号无效');
    return id;
  }
  app.get('/alarms/definitions',async()=>({items:await options.store!.listDefinitions()}));
  app.post('/alarms/definitions',async req=>{
    const r=request(req,'definition','expected_version');
    return apply(await options.store!.saveDefinition(r.input,r.version,r.actor,r.key,options.catalog));
  });
  app.get('/alarms/arming/:id',async req=>({arming:await options.store!.readArming(source(req))}));
  app.post('/alarms/arming/:id',async req=>{
    const r=request(req,'arming','expected_revision');
    if(r.input.source_id!==source(req))throw new AlarmConfigError('invalid_source','布防来源不一致');
    return apply(await options.store!.saveArming(r.input,r.version,r.actor,r.key,options.catalog,options.sourceGeometry));
  });
  app.post('/alarms/arming/synchronize',async()=>options.synchronization?
    options.synchronization.synchronize():{state:'unavailable',reason:'告警服务尚未配置'});
}
