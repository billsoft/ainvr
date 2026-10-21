import type {FastifyInstance,FastifyRequest} from 'fastify';
import {AlarmConfigError,type AlarmZoneStore} from '../store/alarmZones.js';
interface Options {
  /** Keep legacy reads for migration; writes belong to the atomic arming API. */
  readOnly?:boolean;
  store:AlarmZoneStore|null;
  principal:(req:FastifyRequest)=>Promise<string|null>;
  channelExists:(id:string)=>Promise<boolean>;
}
export async function alarmZoneRoutes(app:FastifyInstance,opts:Options){
  app.addHook('preHandler',async(req,reply)=>{
    if(!await opts.principal(req))return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    if(!opts.store)return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数库暂不可用'}});
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof AlarmConfigError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    return reply.code(503).send({error:{code:'configuration_unavailable',message:'参数保存未确认，请刷新状态后重试'}});
  });
  app.get('/alarms/zones',async(req,reply)=>{
    const query=req.query as Record<string,unknown>;
    if(Object.keys(query).some(k=>k!=='channel_id')||typeof query.channel_id!=='string')throw new AlarmConfigError('invalid_channel','请选择来源通道');
    return {items:await opts.store!.list(query.channel_id)};
  });
  app.post('/alarms/zones',async req=>{
    if(opts.readOnly)throw new AlarmConfigError('legacy_read_only','请在实时监看的布防弹窗中统一保存热区和选用',409);
    const body=req.body as {zone?:unknown;expected_version?:unknown}|undefined;
    const key=req.headers['idempotency-key'];
    if(!body||Object.keys(body).some(k=>!['zone','expected_version'].includes(k))||typeof key!=='string'||typeof body.expected_version!=='number')throw new AlarmConfigError('invalid_request','区域参数或操作编号无效');
    const id=(body.zone as {channel_id?:unknown}|null)?.channel_id;
    if(typeof id!=='string'||!await opts.channelExists(id))throw new AlarmConfigError('invalid_channel','来源通道不存在',409);
    const actor=await opts.principal(req);if(!actor)throw new AlarmConfigError('unauthorized','需要登录',401);
    return opts.store!.save(body.zone,body.expected_version,actor,key);
  });
}
