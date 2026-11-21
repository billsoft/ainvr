import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AlarmArmingStore} from '../store/alarmArmingStore.js';
import type {AssignmentSource} from '../store/alarmTriggerDefinition.js';
import {AlarmConfigError} from '../store/alarmZones.js';
import type {AlarmRuleSync} from '../services/alarmRuleSync.js';

import type {ArmingSceneRuntime} from '../services/armingSceneRuntime.js';
interface Options{
  scenes?:ArmingSceneRuntime|null;
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
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof AlarmConfigError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if(req.method==='GET'&&req.routeOptions.url?.includes('/scenes'))
      return reply.code(503).send({error:{code:'scene_unavailable',message:'场景暂时无法读取，请稍后重试'}});
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
  function scenes(){if(!options.scenes)throw new AlarmConfigError('scene_unavailable','场景服务暂不可用',503);return options.scenes;}
  app.get('/alarms/arming/:id/scenes',async(req,reply)=>{
    reply.header('cache-control','no-store');
    const p=(req.query as any).processor_id;
    if(p!==undefined&&!identifier(p))throw new AlarmConfigError('invalid_source','处理器编号无效');
    return scenes().read(source(req),p);
  });
  app.post('/alarms/arming/:id/scenes/frame',async(req,reply)=>{
    reply.header('cache-control','no-store');
    if(!object(req.body)||!identifier(req.body.processor_id))
      throw new AlarmConfigError('invalid_source','需要唯一的处理器编号');
    const {processor_id,...selection}=req.body;
    if(!Object.keys(selection).length)return scenes().freeze(source(req),processor_id,actors.get(req)!);
    const parsed=presetSelection.safeParse(selection);
    if(!parsed.success)throw new AlarmConfigError('invalid_preset','预置位绑定参数无效',400);
    return scenes().freeze(source(req),processor_id,actors.get(req)!,parsed.data);
  });
  app.get('/alarms/arming/:id/scenes/frame/:frame',async(req,reply)=>{
    const {frame}=req.params as {frame:string};
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame))throw new AlarmConfigError('invalid_frame','冻结帧编号无效');
    return reply.header('cache-control','private, no-store').type('image/jpeg').send(await scenes().image(source(req),frame,actors.get(req)!));
  });
  app.get('/alarms/definitions',async()=>({items:await options.store!.listDefinitions()}));
  app.post('/alarms/definitions',async req=>{
    const r=request(req,'definition','expected_version');
    return apply(await options.store!.saveDefinition(r.input,r.version,r.actor,r.key,options.catalog));
  });
  app.get('/alarms/arming/:id',async req=>{
    const processorId=(req.query as {processor_id?:unknown}).processor_id;
    if(processorId!==undefined&&!identifier(processorId))throw new AlarmConfigError('invalid_source','处理器编号无效');
    return {arming:await options.store!.readArming(source(req),processorId as string|undefined)};
  });
  app.post('/alarms/arming/:id',async req=>{
    const r=request(req,'arming','expected_revision');
    if(r.input.source_id!==source(req))throw new AlarmConfigError('invalid_source','布防来源不一致');
    return apply(await options.store!.saveArming(r.input,r.version,r.actor,r.key,options.catalog,options.sourceGeometry));
  });
  app.post('/alarms/arming/synchronize',async()=>options.synchronization?
    options.synchronization.synchronize():{state:'unavailable',reason:'告警服务尚未配置'});
}
import {presetSelection} from '../services/presetHome.js';
