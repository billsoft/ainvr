import type {FastifyInstance,FastifyRequest} from 'fastify';
/** Migration is transactional. On failure keep unrelated services available, but
 * never publish a partial or legacy snapshot. The running alarm service keeps its
 * previously applied revision; operators must repair the conflict before retrying. */
export async function prepareAlarmConfiguration(app:FastifyInstance,migrate:()=>Promise<unknown>,principal:(req:FastifyRequest)=>Promise<string|null>){
 let ready=true;
 try{await migrate();}catch{ready=false;app.log.error('告警配置迁移失败：已关闭配置读写与规则同步，告警服务保留上次已应用规则。请检查迁移冲突后重启控制台。');}
 if(!ready)app.addHook('preHandler',async(req,reply)=>{
  const path=req.url.split('?')[0]!;
  if(!/\/alarms\/(definitions|arming|triggers|sources|zones)(?:\/|$)/.test(path))return;
  if(!await principal(req))return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
  return reply.code(503).send({error:{code:'alarm_migration_failed',message:'告警配置升级未完成，配置修改与同步已暂停。现有已应用规则不变，请处理迁移冲突。'}});
 });
 return ready;
}
