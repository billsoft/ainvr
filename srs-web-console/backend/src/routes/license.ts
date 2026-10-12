// 授权管理 BFF 路由（挂在 /api 前缀下，页面路径 /api/license/*）。
// license-service 不可达时统一 503 + LICENSE_SERVICE_UNAVAILABLE，
// 前端据此显示「授权服务离线」而不是误报未授权。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LicenseClient } from '../license/licenseClient.js';
import type { LicenseGate } from '../license/licenseGate.js';
import { LicenseServiceError } from '../license/types.js';

const ActivateSchema = z.object({
  key: z.string().min(1, '注册密钥不能为空').max(8192),
});

async function sendUpstreamError(reply: FastifyReply, e: unknown) {
  if (e instanceof LicenseServiceError) {
    const status = e.upstreamStatus && e.upstreamStatus >= 400 && e.upstreamStatus < 500
      ? e.upstreamStatus
      : 503;
    return reply.status(status).send({ code: e.code, message: e.message });
  }
  reqLogWarn(e);
  return reply.status(500).send({
    code: 'LICENSE_INTERNAL_ERROR',
    message: '授权接口内部错误',
  });
}

function reqLogWarn(e: unknown) {
  // 路由层无 logger 依赖时退回 console，与后端现有风格一致。
  console.warn('[license] 路由异常:', e);
}

export interface LicenseRoutesOptions {
  client: LicenseClient;
  gate?: LicenseGate;
}

export async function licenseRoutes(
  app: FastifyInstance,
  opts: LicenseRoutesOptions,
) {
  const client = opts.client;
  app.post('/license/remove', async (req, reply) => {
    const parsed = z.object({ confirmation: z.literal('删除注册密钥') }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ code: 'LICENSE_CONFIRMATION_REQUIRED', message: '请完整输入：删除注册密钥' });
    try {
      const status = await client.remove(parsed.data.confirmation);
      await opts.gate?.afterRevocation();
      return reply.send({ ...status, business_allowed: false, business_block_reason: 'LICENSE_REQUIRED' });
    } catch (error) { return sendUpstreamError(reply, error); }
  });

  app.get('/license/machine-code', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const info = await client.getMachineCode();
      return reply.send(info);
    } catch (e) {
      return sendUpstreamError(reply, e);
    }
  });

  app.get('/license/status', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const force = req.query !== null && typeof req.query === 'object' &&
        (req.query as Record<string, unknown>).force === '1';
      const status = await client.getStatus(force);
      const decision = opts.gate?.decide();
      return reply.send({ ...status, business_allowed: decision ? !decision.block : false, business_block_reason: decision?.block ? decision.code : undefined });
    } catch (e) {
      return sendUpstreamError(reply, e);
    }
  });

  app.post('/license/preview', async (req, reply) => {
    const parsed = ActivateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ code: 'LICENSE_INVALID_KEY', message: '注册码格式无效' });
    try { return reply.send(await client.preview(parsed.data.key.trim())); }
    catch (error) { return sendUpstreamError(reply, error); }
  });

  app.post('/license/activate', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ActivateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: 'LICENSE_INVALID_KEY',
        message: parsed.error.issues[0]?.message ?? '请求参数不合法',
      });
    }
    try {
      const status = await client.activate(parsed.data.key.trim());
      client.invalidateCache();
      await opts.gate?.afterActivation();
      const decision = opts.gate?.decide();
      return reply.send({ ...status, business_allowed: decision ? !decision.block : false, business_block_reason: decision?.block ? decision.code : undefined });
    } catch (e) {
      return sendUpstreamError(reply, e);
    }
  });
}
