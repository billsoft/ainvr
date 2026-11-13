import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FacesCaptureSource } from '../services/facesArchiveProducer.js';
import { FacesError, facesId } from '../services/facesContract.js';
import { facesCaptureSchema, type FacesRuntime } from '../services/facesRuntime.js';

export interface FacesIngestOptions {
  runtime: FacesRuntime;
  internalPrincipal: (request: FastifyRequest) => Promise<boolean>;
  // Main injects the authoritative current source/model/channel mapping.
  authorizeCapture: (capture: z.infer<typeof facesCaptureSchema>) => Promise<{ retentionDays: number } | null>;
  captureSources?: () => Promise<FacesCaptureSource[]>;
  recordImage?: (id: string) => Promise<Buffer>;
}
export async function facesIngestRoutes(app: FastifyInstance, options: FacesIngestOptions) {
  app.get('/internal/faces/records/:id/photo', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: { code: 'forbidden', message: '仅允许已授权的告警服务' } });
    try {
      const id = facesId.parse((request.params as { id: string }).id);
      if (!options.recordImage) throw Error('evidence_unavailable');
      return reply.header('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(await options.recordImage(id));
    } catch (error) { return reply.code(error instanceof FacesError ? error.statusCode : error instanceof z.ZodError ? 422 : 503).send({ error: { code: error instanceof FacesError ? error.code : 'faces_evidence_unavailable', message: '人脸证据暂不可用或已过期' } }); }
  });
  app.get('/internal/faces/watchlist-outbox', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: { code: 'forbidden', message: '仅允许已授权的告警服务' } });
    try {
      const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse(request.query);
      return await options.runtime.watchlistOutbox(query.limit);
    } catch (error) { return reply.code(error instanceof z.ZodError ? 422 : 503).send({ error: { code: 'faces_outbox_unavailable', message: '待投递状态尚未确认，请保留重试' } }); }
  });
  app.post('/internal/faces/watchlist-outbox/ack', { bodyLimit: 2048 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: { code: 'forbidden', message: '仅允许已授权的告警服务' } });
    try { return await options.runtime.acknowledgeWatchlist(request.body); }
    catch (error) { return reply.code(error instanceof FacesError ? error.statusCode : error instanceof z.ZodError ? 422 : 503).send({ error: { code: error instanceof FacesError ? error.code : 'faces_outbox_ack_unconfirmed', message: '候选确认未完成，请保留原引用重试' } }); }
  });
  app.get('/internal/faces/capture-sources', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: { code: 'forbidden', message: '仅允许已授权的采集服务' } });
    try {
      if (!options.captureSources) throw Error();
      const status = await options.runtime.status();
      return { schema: 'ainvr.face-capture-sources.v1', items: await options.captureSources(), extractor: status,
        limits: { jpeg_bytes: 4 * 1024 * 1024, max_in_flight: 1 }, semantics: 'original_target_crop_only' };
    } catch { return reply.code(503).send({ error: { code: 'faces_sources_unavailable', message: '采集来源暂不可用，不能据此确认未启用' } }); }
  });
  app.post('/internal/faces/captures', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: { code: 'forbidden', message: '仅允许已授权的采集服务' } });
    try {
      const input = facesCaptureSchema.parse(request.body), grant = await options.authorizeCapture(input);
      if (!grant) throw new FacesError('faces_capture_not_authorized', '此通道的人脸采集尚未授权或未启用', 403);
      return await options.runtime.capture(input, grant.retentionDays);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(422).send({ error: { code: 'invalid_capture', message: '抓拍身份或图片参数无效' } });
      if (error instanceof FacesError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(503).send({ error: { code: 'faces_capture_unavailable', message: '人脸采集暂不可用，未确认持久化' } });
    }
  });
}
