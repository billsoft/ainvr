// 通道 CRUD 路由
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChannelService } from '../services/channelService.js';
import { UpstreamProtocol, DownstreamProtocol } from '../types/channel.js';

// Zod Schemas —— 同时导出给 status.ts 的导入/导出接口复用，不要另开一套
// 更宽松的规则（审计发现：导入接口此前用的是自己临时拼的 schema，
// 字段格式约束比这里的 CRUD 接口宽松，能导入 CRUD 接口本会拒绝的脏数据）。
export const UpstreamProtocolSchema = z.enum(['rtmp', 'srt', 'webrtc', 'rtsp'] as const) satisfies z.ZodType<UpstreamProtocol>;
export const DownstreamProtocolSchema = z.enum(['flv', 'hls', 'webrtc', 'rtmp', 'srt'] as const) satisfies z.ZodType<DownstreamProtocol>;
// 与前端 channelForm.ts::STREAM_RE 保持一致，避免两边校验规则不一致导致后端拒绝前端认为合法的值
export const AppNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional();

const CreateChannelSchema = z.object({
  name: z.string().min(1).max(100),
  upstreamProtocol: UpstreamProtocolSchema,
  streamName: AppNameSchema,
  downstreamProtocols: z.array(DownstreamProtocolSchema).min(1).max(5),
  app: AppNameSchema,
  primaryProtocol: DownstreamProtocolSchema.optional(),
  remark: z.string().max(500).optional(),
  rtspUrl: z.string().url().optional(),
  rtspTransport: z.enum(['tcp', 'udp']).optional(),
  inputUsername: z.string().max(128).optional(),
  inputPassword: z.string().max(256).optional(),
  inputEnabled: z.boolean().optional(),
  inputAudioMode: z.enum(['off', 'auto']).optional(),
});

const UpdateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  upstreamProtocol: UpstreamProtocolSchema.optional(),
  streamName: AppNameSchema,
  downstreamProtocols: z.array(DownstreamProtocolSchema).min(1).max(5).optional(),
  app: AppNameSchema,
  primaryProtocol: DownstreamProtocolSchema.optional(),
  remark: z.string().max(500).optional(),
  rtspUrl: z.string().url().optional(),
  rtspTransport: z.enum(['tcp', 'udp']).optional(),
  inputUsername: z.string().max(128).optional(),
  inputPassword: z.string().max(256).optional(),
  inputEnabled: z.boolean().optional(),
  inputAudioMode: z.enum(['off', 'auto']).optional(),
});

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export interface ChannelRoutesOptions {
  channelService: ChannelService;
  inputReady?: (protocol: UpstreamProtocol) => Promise<boolean>;
}

export async function channelRoutes(fastify: FastifyInstance, opts: ChannelRoutesOptions) {
  const { channelService } = opts;

  // 提取请求 host（用于 URL 生成，兼容 proxy 和直连）
  function getRequestHost(req: FastifyRequest): string {
    const forwarded = req.headers['x-forwarded-host'];
    if (forwarded && typeof forwarded === 'string') return forwarded;
    return req.headers.host || 'localhost';
  }

  // GET /api/channels - 列表（带状态 + urls，供列表行复制/创建成功弹窗使用，读取一次 settings 覆盖）
  fastify.get('/channels', async (req, reply) => {
    const host = getRequestHost(req);
    const channels = await channelService.listChannelsWithUrls(host);
    reply.send({ code: 0, data: channels });
  });

  // POST /api/channels - 创建
  fastify.post('/channels', async (req, reply) => {
    const parse = CreateChannelSchema.safeParse(req.body);
    if (!parse.success) {
      reply.status(400).send({
        code: 400,
        error: '参数错误',
        details: parse.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      if (opts.inputReady && !await opts.inputReady(parse.data.upstreamProtocol))
        return reply.code(503).send({ error: '该协议接入服务尚未就绪，请查看流媒体配置' });
      const host = getRequestHost(req);
      const channel = await channelService.createChannel(parse.data);
      const urls = await channelService.getStreamUrls(channel, host);
      reply.status(201).send({
        code: 0,
        data: { ...channel, urls },
      });
    } catch (e: any) {
      if (e?.code === 'STREAM_NAME_DUPLICATE') {
        reply.status(409).send({
          code: 409,
          error: e.message,
        });
        return;
      }
      throw e;
    }
  });

  // GET /api/channels/:id - 详情（含状态 + URL）
  fastify.get('/channels/:id', async (req, reply) => {
    const paramParse = IdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      reply.status(400).send({ code: 400, error: '无效的通道 ID' });
      return;
    }

    const channel = await channelService.getChannel(paramParse.data.id);
    if (!channel) {
      reply.status(404).send({ code: 404, error: '通道不存在' });
      return;
    }

    const host = getRequestHost(req);
    const urls = await channelService.getStreamUrls(channel, host);
    reply.send({ code: 0, data: { ...channel, urls } });
  });

  // PUT /api/channels/:id - 更新
  fastify.put('/channels/:id', async (req, reply) => {
    const paramParse = IdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      reply.status(400).send({ code: 400, error: '无效的通道 ID' });
      return;
    }

    const bodyParse = UpdateChannelSchema.safeParse(req.body);
    if (!bodyParse.success) {
      reply.status(400).send({
        code: 400,
        error: '参数错误',
        details: bodyParse.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      if (bodyParse.data.upstreamProtocol && opts.inputReady) {
        const old = await channelService.getChannel(paramParse.data.id);
        if (old?.upstreamProtocol !== bodyParse.data.upstreamProtocol && !await opts.inputReady(bodyParse.data.upstreamProtocol))
          return reply.code(503).send({ error: '该协议接入服务尚未就绪，请查看流媒体配置' });
      }
      const host = getRequestHost(req);
      const channel = await channelService.updateChannel(paramParse.data.id, bodyParse.data);
      const urls = await channelService.getStreamUrls(channel, host);
      reply.send({ code: 0, data: { ...channel, urls } });
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') {
        reply.status(404).send({ code: 404, error: '通道不存在' });
        return;
      }
      if (e?.code === 'CONFLICT') return reply.status(409).send({ code: 409, error: e.message });
      if (e?.code === 'STREAM_NAME_DUPLICATE') {
        reply.status(409).send({ code: 409, error: e.message });
        return;
      }
      throw e;
    }
  });

  // DELETE /api/channels/:id - 删除
  fastify.delete('/channels/:id', async (req, reply) => {
    const paramParse = IdParamSchema.safeParse(req.params);
    if (!paramParse.success) {
      reply.status(400).send({ code: 400, error: '无效的通道 ID' });
      return;
    }

    const deleted = await channelService.deleteChannel(paramParse.data.id);
    if (!deleted) {
      reply.status(404).send({ code: 404, error: '通道不存在' });
      return;
    }
    reply.status(204).send();
  });
}
