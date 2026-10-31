import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {verifyPassword} from '../services/passwordHash.js';
import {LoginAttempts} from '../services/consoleSessions.js';
import {clientIdentity} from '../services/proxyIdentity.js';
import {endpoint, limitedJson, type InternalServiceConnection} from '../services/internalServiceHttp.js';
export {endpoint, limitedJson} from '../services/internalServiceHttp.js';

export type AlarmConnection = InternalServiceConnection;
export interface AlarmProxyOptions {
  passwordHash?:()=>Promise<string>;
  /** Only the applied backend configuration, never an unpublished form draft. */
  connection: () => Promise<AlarmConnection | null>;
  /** Server-validated console principal. Never read the actor from client headers. */
  principal: (request: FastifyRequest) => Promise<string | null>;
}

/** Named BFF API only. Producer input, health probes and credentials are never proxied. */
export async function alarmProxyRoutes(app: FastifyInstance, options: AlarmProxyOptions) {
  const passwordAttempts=new LoginAttempts();
  const forward = (path: (req: FastifyRequest) => string, queryKeys: string[] = [], mutation = false) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = await options.principal(req);
      if (!actor) return reply.code(401).send({error: {code: 'unauthorized', message: '需要登录'}});
      if (typeof actor !== 'string' || actor.length > 256 || /[\r\n]/.test(actor))
        return reply.code(503).send({error: {code: 'invalid_principal', message: '无法确定操作身份'}});
      const query = req.query as Record<string, unknown>;
      if (Object.keys(query).some(k => !queryKeys.includes(k)) ||
          Object.values(query).some(v => typeof v !== 'string' || v.length > 4096))
        return reply.code(400).send({error: {code: 'invalid_query', message: '查询参数无效'}});
      const key = req.headers['idempotency-key'];
      if (mutation && (typeof key !== 'string' || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(key)))
        return reply.code(400).send({error: {code: 'idempotency_key_required', message: '缺少操作编号'}});
      try {
        const config = await options.connection();
        if (!config) return reply.code(503).send({error: {code: 'alarm_not_configured', message: '告警服务尚未配置'}});
        const target = endpoint(config, path(req));
        for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v as string);
        const headers: Record<string, string> = {authorization: `Bearer ${config.apiToken}`, accept: 'application/json'};
        if (req.method === 'POST') {
          headers['content-type'] = 'application/json';
          headers['x-ainvr-actor'] = actor;
          if (typeof key === 'string') headers['idempotency-key'] = key;
        }
        const upstream = await fetch(target, {method: req.method, headers, redirect: 'error',
          body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
          signal: AbortSignal.timeout(config.timeoutMs)});
        const body = await limitedJson(upstream);
        // Upstream authentication errors are service configuration failures, not a console logout.
        if (upstream.status === 401 || upstream.status === 403) throw new Error('Service authentication failed');
        return reply.code(upstream.status).send(body);
      } catch {
        return reply.code(502).send({error: {code: 'alarm_unavailable', message: '告警服务暂不可用；操作可能已完成，请刷新状态', retryable: true}});
      }
    };
  const idPath = (suffix = '') => (req: FastifyRequest) =>
    `/v1/events/${encodeURIComponent((req.params as {id: string}).id)}${suffix}`;
  app.get('/alarms/capabilities', forward(() => '/v1/capabilities'));
  app.get('/alarms/status', forward(() => '/v1/status'));
  app.get('/alarms/behavior-statistics', forward(() => '/v1/behavior-statistics', ['from','to','channel_id','zone_id','label_id','event_type','bucket','timezone','rule_id','trigger_id','group_by']));
  app.get('/alarms/behavior-events', forward(() => '/v1/behavior-events', ['from','to','channel_id','zone_id','label_id','event_type','limit','cursor','rule_id','trigger_id']));
  app.get('/alarms/behavior-events/:id', forward(req => `/v1/behavior-events/${encodeURIComponent((req.params as {id:string}).id)}`));
  app.get('/alarms/events', forward(() => '/v1/events', ['status', 'channel_id', 'review', 'disposition', 'limit', 'cursor', 'from', 'to', 'zone_id', 'behavior', 'locations']));
  app.get('/alarms/events/summary', forward(() => '/v1/events/summary'));
  app.post('/alarms/events/statistics', forward(() => '/v1/events/statistics'));
  app.post('/flow/dwell', forward(() => '/v1/flow/dwell'));
  app.post('/flow/heat', forward(() => '/v1/flow/heat'));
  app.get('/alarms/events/:id', forward(idPath()));
  app.get('/alarms/events/:id/logs', forward(idPath('/logs')));
  app.post('/alarms/events/:id/acknowledgements', forward(idPath('/acknowledgements'), [], true));
  app.post('/alarms/bulk-acknowledgements', forward(() => '/v1/bulk-acknowledgements', [], true));
  app.post('/alarms/purge',async(req,reply)=>{
    if(!await options.principal(req))return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    const body=req.body as {password?:unknown;scope?:unknown}|null;
    if(!body||Object.keys(body).some(k=>!['password','scope'].includes(k))||body.scope!=='all'||typeof body.password!=='string'||!body.password.length||body.password.length>100)
      return reply.code(400).send({error:{code:'invalid_request',message:'请输入系统密码，并确认清空所有告警'}});
    let hash:string|undefined;
    try{hash=await options.passwordHash?.()}catch{return reply.code(503).send({error:{code:'password_unavailable',message:'系统密码验证暂不可用'}})}
    if(!hash)return reply.code(409).send({error:{code:'password_required',message:'请先在系统配置中设置系统密码，才能清空告警'}});
    const ip=clientIdentity(req).ip;
    if(!passwordAttempts.enter(ip))return reply.header('Retry-After','60').code(429).send({error:{code:'rate_limited',message:'密码验证过于频繁，请一分钟后重试'}});
    let verified=false;
    try{verified=await verifyPassword(body.password,hash)&&await options.passwordHash?.()===hash}catch{verified=false}
    finally{passwordAttempts.leave(ip,verified)}
    if(!verified)return reply.code(403).send({error:{code:'invalid_password',message:'系统密码不正确'}});
    // Never forward, persist or audit the password. The service sees only the scope.
    req.body={scope:'all'};
    return forward(()=>'/v1/events/purge',[],true)(req,reply);
  });
  app.get('/alarms/rules', forward(() => '/v1/rules', ['channel_id']));
  app.post('/alarms/rules', async (req, reply) => {
    if (!await options.principal(req)) return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    return reply.code(405).header('Allow','GET').send({error:{code:'configuration_authority',message:'请在告警分析中保存监控规则'}});
  });
  app.post('/alarms/dry-runs', forward(() => '/v1/dry-runs'));
}
