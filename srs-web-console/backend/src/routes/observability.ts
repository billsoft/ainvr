import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PgConfigStore } from '../store/pgStore.js';
import { restartHelperConfigFromEnv, triggerShutdown, getShutdownStatus } from '../services/restartHelperClient.js';
import { operationalLog } from '../services/operationalLog.js';

const Settings = z.object({ fileMiB:z.number().int().min(1).max(50), files:z.number().int().min(1).max(5),
  historyHours:z.number().int().min(1).max(168), level:z.enum(['DEBUG','INFO','WARN','ERROR']),
  repeatSeconds:z.number().int().min(10).max(300) }).strict();
const Query = z.object({ source:z.enum(['host','frontend','backend','srs','postgres','mongodb','ai-service','recorder','alarm-service','llm-service','gb28181','gb-media','helper']).optional(),
  level:z.enum(['DEBUG','INFO','WARN','ERROR']).optional(), q:z.string().max(200).optional(),
  cursor:z.string().max(16000).regex(/^[A-Za-z0-9_=-]+$/).optional(),
  start:z.coerce.number().int().min(0).optional(), end:z.coerce.number().int().min(0).optional(),
  limit:z.coerce.number().int().min(1).max(500).optional() }).strict();

export async function observabilityRoutes(app: FastifyInstance, opts: { pgStore: PgConfigStore | null }) {
  const config = restartHelperConfigFromEnv();
  let applied = '', syncing = false, saving = false, applyError: string | null = null;
  async function host(path: string, body?: unknown) {
    if (!config) throw new Error('宿主机采集助手未配置');
    const response = await fetch(`${config.baseUrl}/observe/${path}`, {
      method: body ? 'POST':'GET', signal: AbortSignal.timeout(5000),
      headers:{ Authorization:`Bearer ${config.token}`, ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    if (!response.ok) throw new Error(`采集助手返回 ${response.status}`);
    return await response.json() as Record<string,unknown>;
  }
  async function sync() {
    if (!opts.pgStore || syncing || saving) return;
    syncing = true;
    try {
      const doc = await opts.pgStore.getDocument('backend','observability','settings');
      if (doc) {
        const setting = Settings.parse(doc.config), value = JSON.stringify(setting);
        if (value !== applied) { await host('settings',setting); applied=value; }
      }
      applyError = null;
    } catch {
      applyError='日志策略尚未应用，后台将重试；采集保持上次有效配置';
      operationalLog('WARN','observability',applyError);
    } finally { syncing=false; }
  }
  const timer=setInterval(() => void sync(),10000); timer.unref();
  app.addHook('onClose',async () => clearInterval(timer));
  void sync();
  for (const endpoint of ['summary','history','logs'] as const) {
    app.get(`/observability/${endpoint}`, async (req,reply) => {
      try {
        let query='';
        if (endpoint==='logs') {
          const parsed=Query.parse(req.query);
          query=new URLSearchParams(Object.entries(parsed).map(([k,v]):[string,string]=>[k,String(v)])).toString();
        } else if (endpoint==='history') {
          const parsed=z.object({hours:z.coerce.number().int().min(1).max(168).default(1)}).parse(req.query);
          query=`hours=${parsed.hours}`;
        }
        const data=await host(endpoint+(query?'?'+query:''));
        return {code:0,data:{...data,applyError}};
      } catch(e) {
        return reply.code(e instanceof z.ZodError?400:503).send({error:e instanceof z.ZodError?'查询参数无效':'宿主机采集暂不可用，请稍后重试'});
      }
    });
  }
  app.put('/observability/settings',async(req,reply)=>{
    const parsed=Settings.safeParse(req.body);
    if(!parsed.success) return reply.code(400).send({error:'日志配置超出允许范围'});
    if(!opts.pgStore) return reply.code(503).send({error:'配置数据库不可用，未保存'});
    if(syncing || saving) return reply.code(409).send({error:'配置正在应用，请稍后重试'});
    saving=true;
    try {
      await opts.pgStore.upsertDocument({service:'backend',group:'observability',name:'settings',
        config:parsed.data,description:'日志归档与资源历史策略（自动应用）'},'console');
      applied='';
      try { await host('settings',parsed.data); applied=JSON.stringify(parsed.data); applyError=null; }
      catch { applyError='已保存但尚未应用，后台将自动重试'; return reply.code(503).send({error:applyError}); }
      return {code:0,data:{applied:true}};
    } catch { return reply.code(503).send({error:'日志策略保存失败，请检查配置数据库'}); }
    finally {saving=false;}
  });
  // Frontend runtime exceptions: no arbitrary console payloads, request bodies or URLs.
  const browserError=z.object({message:z.string().min(1).max(1000),module:z.string().max(80).default('browser')}).strict();
  app.post('/observability/browser-error',async(req,reply)=>{
    const parsed=browserError.safeParse(req.body);
    if(!parsed.success) return reply.code(400).send({error:'参数无效'});
    operationalLog('ERROR',parsed.data.module,parsed.data.message,'browser');
    return {code:0};
  });
  // 安全关机：触发宿主机按顺序停服务并断电。
  // 不可逆操作，前端有二次确认（输入"关机"二字）。这里只转发给重启助手，
  // 助手那边已有 source-IP + token 双重鉴权。
  app.post('/observability/shutdown',async(req,reply)=>{
    if(!config) return reply.code(503).send({error:'宿主机助手未配置，无法执行关机'});
    try {
      const result = await triggerShutdown(config);
      if(!result.ok) return reply.code(500).send({error:result.error,step:result.step});
      return {code:0,data:{stepsCompleted:result.step}};
    } catch(e) {
      return reply.code(500).send({error:`关机请求失败: ${e instanceof Error?e.message:String(e)}`});
    }
  });

  // 关机进度：中途失败（已中止并恢复服务）时页面据此提示，而不是一直显示"正在关机"
  app.get('/observability/shutdown/status',async(_req,reply)=>{
    if(!config) return reply.code(503).send({error:'宿主机助手未配置'});
    try {
      return {code:0,data:await getShutdownStatus(config)};
    } catch(e) {
      return reply.code(503).send({error:e instanceof Error?e.message:String(e)});
    }
  });
}
