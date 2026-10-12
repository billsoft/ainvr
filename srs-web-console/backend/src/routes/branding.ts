// OEM 品牌信息（免登录、免授权：登录页与授权页也要显示品牌），见 services/branding.ts
import type { FastifyInstance } from 'fastify';
import type { BrandingResult } from '../services/branding.js';

export async function brandingRoutes(fastify: FastifyInstance, opts: { load: () => BrandingResult }) {
  fastify.get('/branding', async (_req, reply) => {
    const { branding, source } = opts.load();
    reply.header('Cache-Control', 'no-cache');
    return reply.send({ code: 0, data: { ...branding, source } });
  });
}
