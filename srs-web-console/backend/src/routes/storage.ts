import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { osHelperConfigFromEnv, storageRequest } from '../services/osHelperClient.js'

export async function storageRoutes(app: FastifyInstance) {
  const config = osHelperConfigFromEnv()
  app.get('/storage/volumes', async (_req, reply) => {
    if (!config) return reply.code(503).send({ error: '系统存储服务未配置' })
    try { return await storageRequest(config, '/storage/volumes') }
    catch { return reply.code(503).send({ error: '磁盘信息暂不可用，请稍后刷新' }) }
  })
  app.get('/storage/directories', async (req, reply) => {
    const query = z.object({ volume: z.string().min(1).max(128), path: z.string().max(1024).default('') }).strict().safeParse(req.query)
    if (!query.success) return reply.code(400).send({ error: '目录参数无效' })
    if (!config) return reply.code(503).send({ error: '系统存储服务未配置' })
    try { return await storageRequest(config, `/storage/directories?volume=${encodeURIComponent(query.data.volume)}&path=${encodeURIComponent(query.data.path)}`) }
    catch { return reply.code(503).send({ error: '目录不可读取，请确认磁盘在线且目录不是快捷链接' }) }
  })
}
