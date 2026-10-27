import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {PtzStore,PtzError,ptzCameraDraftSchema} from '../store/ptzStore.js';
import type {PtzManager} from '../services/ptzManager.js';
import { OnvifStore, OnvifError, deviceSchema, onvifSettingsSchema } from '../store/onvifStore.js';
import { OnvifManager, onvifBindingSchema } from '../services/onvifManager.js';
const id = z.string().uuid();
export async function onvifRoutes(
  app: FastifyInstance,
  opts: {
    store: OnvifStore | null;
    ptzStore?:PtzStore|null;ptzManager?:PtzManager|null;
    manager: OnvifManager | null;
    principal: (r: FastifyRequest) => Promise<string | null>;
  },
) {
  const actors = new WeakMap<FastifyRequest, string>();
  app.addHook('preHandler', async (req, reply) => {
    const actor = await opts.principal(req);
    if (!actor) return reply.code(401).send({ error: '需要登录' });
    actors.set(req, actor);
    if (!opts.store || !opts.manager)
      return reply.code(503).send({ error: 'ONVIF 参数库尚未就绪' });
  });
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof z.ZodError) return reply.code(400).send({ error: 'ONVIF 请求参数无效' });
    if(e instanceof PtzError)return reply.code(e.statusCode).send({error:e.code});
    if (e instanceof OnvifError) return reply.code(e.statusCode).send({ error: e.code });
    if ((e as any).code === 'CONFLICT') return reply.code(409).send({ error: 'version_conflict' });
    return reply.code(503).send({ error: 'onvif_unavailable' });
  });
  app.get('/onvif/settings', () => opts.store!.settings());
  app.put('/onvif/settings', async (req) => {
    const b = z
      .object({
        settings: onvifSettingsSchema,
        expectedRevision: z.number().int().min(1),
        token: z.string().min(32).max(512).optional(),
      })
      .strict()
      .parse(req.body);
    const result = await opts.store!.saveSettings(
      b.settings,
      b.expectedRevision,
      b.token,
      actors.get(req)!,
    );
    void opts.manager!.synchronize();
    return result;
  });
  app.get('/onvif/status', () => opts.manager!.status());
  app.get('/onvif/devices', async () => ({ items: await opts.store!.devices() }));
  app.get('/onvif/devices/:id', (req) =>
    opts.store!.publicDevice(id.parse((req.params as any).id)),
  );
  app.post('/onvif/devices', (req) =>
    opts.store!.saveDevice(deviceSchema.parse(req.body), actors.get(req)!),
  );
  app.post('/onvif/devices/:id/probe', (req) =>
    opts.manager!.probe(id.parse((req.params as any).id)),
  );
  app.post('/onvif/discover', (req) =>
    opts.manager!.discover(
      z
        .object({ interface: z.string().min(1).max(32) })
        .strict()
        .parse(req.body).interface,
    ),
  );
  app.post('/onvif/channel-config', async (req) => {
    const protocol = z.enum(['flv', 'hls', 'webrtc', 'rtmp', 'srt']);
    const b = z
      .object({
        binding: onvifBindingSchema,
        ptz:ptzCameraDraftSchema.optional(),
        inputId: id.optional(),
        expectedGeneration: z.string().uuid().optional(),
        config: z
          .object({
            name: z.string().trim().min(1).max(100),
            remark: z.string().max(500).optional(),
            downstreamProtocols: z.array(protocol).min(1).max(5),
            primaryProtocol: protocol,
            inputEnabled: z.boolean(),
          })
          .strict(),
      })
      .strict()
      .parse(req.body);
    if (
      new Set(b.config.downstreamProtocols).size !== b.config.downstreamProtocols.length ||
      !b.config.downstreamProtocols.includes(b.config.primaryProtocol)
    )
      throw new OnvifError('invalid_playback_protocols');
    const save=()=>opts.manager!.saveChannel(b.binding,b.config,b.inputId,b.expectedGeneration);
    if(!b.ptz)return save();
    if(!opts.ptzStore)throw new OnvifError('ptz_configuration_unavailable',503);
    const key=`onvif:${b.binding.deviceId}/${b.binding.videoSource}`;
    const saved=await opts.ptzStore.withCamera(key,key,b.ptz,actors.get(req)!,save);
    const application=await opts.ptzManager?.invalidateCamera(key);
    return {...saved.result,ptzApplication:saved.ptzApplication,application};
  });
}
