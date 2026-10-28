import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { searchQuerySchema, searchRangeSchema, searchPageSchema, searchDetailSchema, searchCoverageSchema, sameSearchScope,
  type SearchScope, type SearchWorker, type SearchPage } from '../services/searchContract.js';
import { PersistentSearchError } from '../services/persistentSearchWorker.js';
interface Options {
  principal: (request: FastifyRequest) => Promise<string | null>;
  channels: (actor: string) => Promise<{ id: string; name: string }[]>;
  worker?: SearchWorker;
}
const params = z.object({ id: z.string().uuid(), resultId: z.string().uuid().optional(), frameId: z.string().uuid().optional() }).strict();
class SearchRouteError extends Error {
  constructor(public code: string, public statusCode: number, message: string) { super(message); }
}
function upstream<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Error('invalid_search_worker_response');
  return parsed.data;
}
const denied = () => new SearchRouteError('search_scope_denied', 403, '部分通道已不可用或无权访问，请重新选择');
export async function searchRoutes(app: FastifyInstance, options: Options) {
  const actors = new WeakMap<FastifyRequest, string>();
  const actor = (r: FastifyRequest) => actors.get(r)!;
  const worker = () => {
    if (!options.worker) throw new SearchRouteError('search_not_ready', 503, '搜索模型与索引尚未就绪，当前不能搜索录像');
    return options.worker;
  };
  async function authorize(scope: SearchScope, who: string) {
    const allowed = new Set((await options.channels(who)).map(c => c.id));
    if (scope.channel_ids.some(id => !allowed.has(id))) throw denied();
    return allowed;
  }
  // Validate the worker's projection too: no out-of-scope candidates, playback
  // identities or silently broadened time range may cross the BFF boundary.
  async function checkedPage(value: unknown, who: string, expected?: SearchScope): Promise<SearchPage> {
    const page = upstream(searchPageSchema, value);
    const allowed = await authorize(page.scope, who);
    if (expected && !sameSearchScope(expected, page.scope))
      throw Error('worker_scope_changed');
    const from = Date.parse(page.scope.from), to = Date.parse(page.scope.to);
    if (new Set(page.items.map(i => i.id)).size !== page.items.length) throw Error('duplicate_search_result');
    for (const row of page.items) {
      const match = row.frames.find(f => f.role === 'match')!;
      if (!page.scope.channel_ids.includes(row.channel_id) || Date.parse(row.ended_at) < from
        || Date.parse(row.started_at) >= to || Date.parse(match.captured_at) < from || Date.parse(match.captured_at) >= to)
        throw Error('worker_result_out_of_scope');
      if (row.recording.channel_id && !allowed.has(row.recording.channel_id)) throw denied();
    }
    return page;
  }
  async function detail(request: FastifyRequest) {
    const p = params.parse(request.params);
    const result = await worker().result(p.id, p.resultId!, actor(request));
    if (!result) throw new SearchRouteError('search_result_missing', 404, '搜索结果已过期或不可访问，请重新搜索');
    const envelope = upstream(searchDetailSchema, result);
    if (envelope.search_id !== p.id || envelope.item.id !== p.resultId) throw Error('worker_identity_mismatch');
    await checkedPage({ search_id: p.id, scope: envelope.scope, model_version: 'detail', coverage: 'unknown', items: [envelope.item], next_cursor: null }, actor(request));
    return { p, envelope };
  }
  app.addHook('preHandler', async (request, reply) => {
    const who = await options.principal(request);
    if (!who) return reply.code(401).send({ error: { code: 'unauthorized', message: '需要登录' } });
    actors.set(request, who); reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: { code: 'invalid_search', message: error.issues[0]?.message ?? '搜索条件无效' } });
    if (error instanceof SearchRouteError)
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof PersistentSearchError)
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if ((error as { statusCode?: number }).statusCode === 413)
      return reply.code(413).send({ error: { code: 'search_request_too_large', message: '搜索请求过大' } });
    return reply.code(503).send({ error: { code: 'search_unavailable', message: '搜索服务暂不可用，请稍后重试' } });
  });
  app.get('/search/status', async () => options.worker?.status() ?? { ready: false, reason: 'model_pending', model_version: null });
  app.get('/search/channels', async r => ({ items: await options.channels(actor(r)) }));
  app.post('/search/text', { bodyLimit: 16 * 1024 }, async request => {
    const input = searchQuerySchema.parse(request.body);
    await authorize(input.scope, actor(request));
    if (!(await worker().status()).ready) throw new SearchRouteError('search_not_ready', 503, '搜索模型与索引尚未就绪，当前不能搜索录像');
    const page = await checkedPage(await worker().query(input, actor(request)), actor(request), input.scope);
    if (page.search_id !== input.request_id) throw Error('worker_request_identity_changed');
    return page;
  });
  app.post('/search/coverage', { bodyLimit: 16 * 1024 }, async request => {
    const scope = searchRangeSchema.parse(request.body);
    await authorize(scope, actor(request));
    const coverage = upstream(searchCoverageSchema, await worker().coverage(scope, actor(request)));
    if (!sameSearchScope(scope, coverage.scope)) throw Error('worker_scope_changed');
    await authorize(coverage.scope, actor(request));
    return coverage;
  });
  app.get('/search/:id', async request => {
    const p = params.parse(request.params);
    const q = z.object({ cursor: z.string().min(1).max(512).optional() }).strict().parse(request.query);
    const page = await worker().page(p.id, q.cursor, actor(request));
    if (!page) throw new SearchRouteError('search_expired', 404, '搜索已过期，请重新搜索');
    const checked = await checkedPage(page, actor(request));
    if (checked.search_id !== p.id) throw Error('worker_identity_mismatch');
    return checked;
  });
  app.get('/search/:id/results/:resultId', async request => (await detail(request)).envelope.item);
  app.get('/search/:id/results/:resultId/images/:frameId', async (request, reply) => {
    const { p, envelope } = await detail(request);
    if (!envelope.item.frames.some(f => f.id === p.frameId))
      throw new SearchRouteError('search_frame_missing', 404, '图片未保存或已过期');
    const image = await worker().image(p.id, p.resultId!, p.frameId!, actor(request));
    if (!image) throw new SearchRouteError('search_frame_missing', 404, '图片未保存或已过期');
    if (image.length < 4 || image.length > 8 * 1024 ** 2 || image[0] !== 255 || image[1] !== 216 || image.at(-2) !== 255 || image.at(-1) !== 217)
      throw Error('invalid_search_image');
    return reply.header('x-content-type-options', 'nosniff').type('image/jpeg').send(image);
  });
  app.post('/search/:id/results/:resultId/feedback', { bodyLimit: 1024 }, async request => {
    const body = z.object({ relevant: z.boolean() }).strict().parse(request.body);
    const { p } = await detail(request);
    await worker().feedback(p.id, p.resultId!, body.relevant, actor(request));
    return { relevant: body.relevant };
  });
  app.post('/search/:id/cancel', async request => {
    const p = params.parse(request.params);
    // Worker must authorize ownership even when the query is already cancelled.
    await worker().cancel(p.id, actor(request));
    return { cancelled: true };
  });
}
