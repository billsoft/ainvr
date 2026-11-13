import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FacesError, facesId, facesVersion, facesReferenceQuerySchema } from '../services/facesContract.js';
import type { FacesService } from '../services/facesService.js';

export interface FacesRoutesOptions { service: FacesService; principal: (request: FastifyRequest) => Promise<string | null> }
export async function facesRoutes(app: FastifyInstance, options: FacesRoutesOptions) {
  const actors = new WeakMap<FastifyRequest, string>();
  const actor = (request: FastifyRequest) => actors.get(request)!;
  app.addHook('preHandler', async (request, reply) => {
    const who = await options.principal(request);
    if (!who) return reply.code(401).send({ error: { code: 'unauthorized', message: '需要登录' } });
    // The existing console has one management identity, not an RBAC system.
    // Optional passwordless console-local is not a face-data permission grant.
    if (who !== 'console-administrator') return reply.code(403).send({ error: { code: 'faces_management_required', message: '请使用已登录的控制台管理会话访问人脸数据' } });
    actors.set(request, who); reply.header('Cache-Control', 'private, no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(422).send({ error: { code: 'invalid_faces_request', message: '人脸参数无效或超出范围，请检查名称、期限、成员与通道。' } });
    if (error instanceof FacesError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.current === undefined ? {} : { current: error.current }) } });
    if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: { code: 'faces_request_too_large', message: '请求过大，请缩小照片或成员数量' } });
    return reply.code(503).send({ error: { code: 'faces_unavailable', message: '人脸服务暂不可用，未确认保存；请保留输入并重试。' } });
  });
  const id = (request: FastifyRequest) => facesId.parse((request.params as { id: string }).id);
  const memberId = (request: FastifyRequest) => facesId.parse((request.params as { memberId: string }).memberId);
  const version = (request: FastifyRequest) => facesVersion.parse(z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).parse((request.params as { version: string }).version));
  const recordId = (request: FastifyRequest) => facesReferenceQuerySchema.parse(request.query).record_id;
  const key = (request: FastifyRequest) => facesId.parse(request.headers['idempotency-key']);
  const service = options.service;
  app.get('/faces/status', () => service.status());
  app.get('/faces/channels', async request => ({ items: await service.channels(actor(request)) }));
  app.get('/faces/libraries', () => service.list());
  app.get('/faces/libraries/:id', request => service.get(id(request)));
  app.put('/faces/libraries/:id', { bodyLimit: 600 * 1024 }, request => service.save(id(request), request.body, actor(request), key(request)));
  app.post('/faces/libraries/:id/delete', { bodyLimit: 2048 }, request => service.delete(id(request), request.body, actor(request), key(request)));
  app.post('/faces/libraries/:id/members/:memberId/photo', { bodyLimit: 6 * 1024 * 1024 }, request => service.enroll(id(request), memberId(request), request.body, actor(request)));
  app.get('/faces/libraries/:id/members/:memberId/photo', async (request, reply) => reply.header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(await service.memberImage(id(request), memberId(request), actor(request))));
  app.get('/faces/libraries/:id/versions/:version/members/:memberId/reference', request => service.memberReference(id(request), version(request), memberId(request), recordId(request), actor(request)));
  app.get('/faces/libraries/:id/versions/:version/members/:memberId/photo', async (request, reply) => reply.header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(await service.historicalMemberImage(id(request), version(request), memberId(request), recordId(request), actor(request))));
  app.post('/faces/history/query', { bodyLimit: 16384 }, request => service.history(request.body, actor(request)));
  app.get('/faces/records/:id', request => service.record(id(request), actor(request)));
  app.get('/faces/records/:id/photo', async (request, reply) => reply.header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(await service.recordImage(id(request), actor(request))));
  app.post('/faces/search', { bodyLimit: 6 * 1024 * 1024 }, request => service.search(request.body, actor(request)));
  app.post('/faces/search/:id/cancel', { bodyLimit: 1024 }, request => service.cancel(id(request), actor(request)));
}
