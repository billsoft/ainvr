import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Channel } from '../types/channel.js';
import { PtzError, PtzStore } from '../store/ptzStore.js';
import { ptzCameraKey } from '../services/ptzSources.js';
import { PtzManager } from '../services/ptzManager.js';
const channelId = z.string().uuid();
const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const native = z.string().min(1).max(256);
const session = z.string().uuid();
const vector = z
  .object({
    pan: z.number().finite().min(-1).max(1),
    tilt: z.number().finite().min(-1).max(1),
    zoom: z.number().finite().min(-1).max(1),
  })
  .strict();
interface Options {
  manager: PtzManager | null;
  store: PtzStore | null;
  principal: (r: FastifyRequest) => Promise<string | null>;
  channels: () => Promise<Channel[]>;
}
export async function ptzRoutes(app: FastifyInstance, opts: Options) {
  const actors = new WeakMap<FastifyRequest, string>();
  app.addHook('preHandler', async (req, reply) => {
    const actor = await opts.principal(req);
    if (!actor) return reply.code(401).send({ error: '需要登录' });
    actors.set(req, actor);
    if (!opts.store || !opts.manager)
      return reply.code(503).send({ error: '云台控制参数库尚未就绪' });
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) return reply.code(400).send({ error: '云台操作参数无效' });
    const error = e as any;
    const code =
      e instanceof PtzError
        ? e.code
        : typeof error.code === 'string' && /^ptz_[a-z_]+$/.test(error.code)
          ? error.code
          : 'ptz_unavailable';
    return reply.code(e instanceof PtzError ? e.statusCode : 503).send({ error: code });
  });
  const id = (r: FastifyRequest) => channelId.parse((r.params as any).id);
  const actor = (r: FastifyRequest) => actors.get(r)!;
  app.post('/ptz/camera-configurations', async (req) => {
    const selector = z.discriminatedUnion('protocol', [
      z
        .object({
          protocol: z.literal('onvif'),
          deviceId: z.string().uuid(),
          videoSource: z.string().min(1).max(256),
        })
        .strict(),
      z
        .object({
          protocol: z.literal('gb28181'),
          deviceId: z.string().regex(/^\d{20}$/),
          channelId: z.string().regex(/^\d{20}$/),
        })
        .strict(),
    ]);
    const b = z
      .object({ sources: z.array(selector).min(1).max(100) })
      .strict()
      .parse(req.body);
    const items = [];
    for (const source of b.sources) {
      const known =
        source.protocol === 'onvif'
          ? await opts.store!.pool.query('SELECT 1 FROM onvif_devices WHERE device_id=$1', [
              source.deviceId,
            ])
          : await opts.store!.pool.query(
              'SELECT 1 FROM gb28181_catalog WHERE device_id=$1 AND channel_id=$2',
              [source.deviceId, source.channelId],
            );
      if (!known.rows.length) throw new PtzError('ptz_channel_not_found', 404);
      const key =
        source.protocol === 'onvif'
          ? `onvif:${source.deviceId}/${source.videoSource}`
          : `gb28181:${source.deviceId}/${source.channelId}`;
      items.push({ key, ...(await opts.store!.camera(key, key)) });
    }
    return { items };
  });
  app.get('/ptz/catalog', () => opts.manager!.catalog());
  app.get('/ptz/protection', () => opts.manager!.protection());
  app.get('/ptz/settings', () => opts.store!.settings());
  app.put('/ptz/settings', async (req) => {
    const b = z
      .object({ settings: z.unknown(), expectedRevision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    const result = await opts.store!.saveSettings(b.settings, b.expectedRevision, actor(req));
    let state = 'applied';
    try {
      await opts.manager!.invalidate();
    } catch {
      state = 'stop_unconfirmed';
    }
    return { ...result, application: { state } };
  });
  async function camera(r: FastifyRequest) {
    const root = (await opts.channels()).find((c) => c.id === id(r));
    if (!root) throw new PtzError('ptz_channel_not_found', 404);
    let identity: string;
    if (root.onvif) identity = JSON.stringify(root.onvif);
    else {
      const { rows } = await opts.store!.pool.query(
        'SELECT binding_id,device_id,channel_id FROM gb28181_bindings WHERE input_id=$1',
        [root.id],
      );
      if (rows.length !== 1) throw new PtzError('ptz_not_supported', 422);
      const b = rows[0];
      identity = JSON.stringify([b.binding_id, b.device_id, b.channel_id]);
    }
    return { root, ...ptzCameraKey(root, identity) };
  }
  app.get('/channels/:id/ptz/camera-settings', async (req) => {
    const c = await camera(req);
    return opts.store!.camera(c.key, c.identity);
  });
  app.put('/channels/:id/ptz/camera-settings', async (req) => {
    const c = await camera(req);
    const b = z
      .object({ settings: z.unknown(), expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(req.body);
    const result = await opts.store!.saveCamera(
      c.key,
      c.identity,
      b.settings,
      b.expectedRevision,
      actor(req),
    );
    return { ...result, application: await opts.manager!.invalidateCamera(c.key) };
  });
  app.get('/channels/:id/ptz', (req) => opts.manager!.inspect(id(req)));
  app.post('/channels/:id/ptz/control-session', (req) => {
    const b = z
      .object({ identity: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    return opts.manager!.acquire(id(req), actor(req), b.identity);
  });
  app.put('/channels/:id/ptz/control-session/:sessionId', (req) => {
    const b = z
      .object({ sequence: seq, vector, keepAlive: z.boolean().optional() })
      .strict()
      .parse(req.body);
    return opts.manager!.command(
      id(req),
      session.parse((req.params as any).sessionId),
      actor(req),
      b.sequence,
      b.vector,
      undefined,
      b.keepAlive,
    );
  });
  app.post('/channels/:id/ptz/stop', (req) => {
    const b = z.object({ sessionId: session.nullable() }).strict().parse(req.body);
    return b.sessionId
      ? opts.manager!.stop(id(req), b.sessionId, actor(req))
      : opts.manager!.emergencyStop(id(req), actor(req));
  });
  app.get('/channels/:id/ptz/presets', (req) => opts.manager!.presets(id(req)));
  app.post('/channels/:id/ptz/presets', (req) => {
    const b = z
      .object({
        id: native.optional(),
        name: z.string().trim().min(1).max(100),
        shortcut: z.number().int().min(1).max(9).nullable(),
      })
      .strict()
      .parse(req.body);
    return opts.manager!.savePreset(id(req), actor(req), b);
  });
  app.delete('/channels/:id/ptz/presets/:presetId', (req) =>
    opts.manager!.removePreset(id(req), actor(req), native.parse((req.params as any).presetId)),
  );
  app.post('/channels/:id/ptz/presets/:presetId/goto', (req) => {
    const b = z.object({ sessionId: session, sequence: seq }).strict().parse(req.body);
    return opts.manager!.command(
      id(req),
      b.sessionId,
      actor(req),
      b.sequence,
      { pan: 0, tilt: 0, zoom: 0 },
      native.parse((req.params as any).presetId),
    );
  });
  app.post('/channels/:id/ptz/restore-view', (req) => {
    const b = z
      .object({
        expectedRevision: z.number().int().positive(),
        mode: z.enum(['position', 'rearmed']),
      })
      .strict()
      .parse(req.body);
    return opts.manager!.restoreView(id(req), actor(req), b.expectedRevision, b.mode);
  });
  app.addHook('onClose', async () => {
    await opts.manager?.close();
  });
}
