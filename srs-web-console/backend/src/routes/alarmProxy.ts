import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface AlarmConnection {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
}
export interface AlarmProxyOptions {
  /** Only the applied backend configuration, never an unpublished form draft. */
  connection: () => Promise<AlarmConnection | null>;
  /** Server-validated console principal. Never read the actor from client headers. */
  principal: (request: FastifyRequest) => Promise<string | null>;
}

const allowedHosts = new Set(['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal']);
export function endpoint(config: AlarmConnection, path: string): URL {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'http:' || !allowedHosts.has(base.hostname) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !base.port || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000 ||
      typeof config.apiToken !== 'string' || config.apiToken.length < 32) {
    throw new Error('Invalid alarm service connection');
  }
  return new URL(path, base);
}
export async function limitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > 2 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Named BFF API only. Producer input, health probes and credentials are never proxied. */
export async function alarmProxyRoutes(app: FastifyInstance, options: AlarmProxyOptions) {
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
  app.get('/alarms/events', forward(() => '/v1/events', ['status', 'channel_id', 'review', 'limit', 'cursor', 'from', 'to', 'zone_id', 'behavior']));
  app.get('/alarms/events/summary', forward(() => '/v1/events/summary'));
  app.get('/alarms/events/:id', forward(idPath()));
  app.get('/alarms/events/:id/logs', forward(idPath('/logs')));
  app.post('/alarms/events/:id/acknowledgements', forward(idPath('/acknowledgements'), [], true));
  app.post('/alarms/bulk-acknowledgements', forward(() => '/v1/bulk-acknowledgements', [], true));
  app.get('/alarms/rules', forward(() => '/v1/rules', ['channel_id']));
  app.post('/alarms/rules', async (req, reply) => {
    if (!await options.principal(req)) return reply.code(401).send({error:{code:'unauthorized',message:'需要登录'}});
    return reply.code(405).header('Allow','GET').send({error:{code:'configuration_authority',message:'请在告警分析中保存监控规则'}});
  });
  app.post('/alarms/dry-runs', forward(() => '/v1/dry-runs'));
}
