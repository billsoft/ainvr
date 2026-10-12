import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { osHelperConfigFromEnv, getSystemTime, setSystemTime, setNtpServers } from '../services/osHelperClient.js'

// 系统日期时间（2026-10-09）：板子没有时钟电池，离线现场靠这里手动校时或指定局域网对时服务器。
// 系统时间无效时授权会报时钟错误、业务暂停——这组接口在授权闸门放行名单里，否则改不了时间就死锁。
const SetTimeSchema = z.object({ epochMs: z.number().int() }).strict()
const NtpSchema = z.object({ servers: z.array(z.string().max(253)).max(5) }).strict()

// 系统助手明确拒绝（参数/时间范围不合法，400）透传原因；连不上、超时、内部错误一律 503，
// 且不把内部组件名、底层网络错误透给页面
function fail(reply: FastifyReply, e: unknown, action: string) {
  const err = e as { status?: number; helperMessage?: string }
  if (err?.status === 400 && err.helperMessage) {
    reply.code(400).send({ error: err.helperMessage })
    return
  }
  reply.code(503).send({ error: `${action}失败：系统助手暂不可用，请稍后重试` })
}

export async function systemTimeRoutes(app: FastifyInstance) {
  const config = osHelperConfigFromEnv()
  if (!config) {
    const unavailable = async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.code(503).send({ error: '系统助手未配置，无法读取或设置系统时间' })
    }
    app.get('/system-time', unavailable)
    app.put('/system-time', unavailable)
    app.put('/system-time/ntp-servers', unavailable)
    return
  }

  app.get('/system-time', async (_req, reply) => {
    try {
      return { code: 0, data: await getSystemTime(config) }
    } catch (e) {
      fail(reply, e, '读取系统时间')
    }
  })

  // 手动校时：系统助手设好时间后会自动重启录像与 AI
  app.put('/system-time', async (req, reply) => {
    const parsed = SetTimeSchema.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400).send({ error: '参数无效' })
      return
    }
    try {
      return { code: 0, data: await setSystemTime(config, parsed.data.epochMs) }
    } catch (e) {
      fail(reply, e, '设置系统时间')
    }
  })

  // 局域网对时服务器：空数组 = 恢复默认（公网对时）
  app.put('/system-time/ntp-servers', async (req, reply) => {
    const parsed = NtpSchema.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400).send({ error: '参数无效' })
      return
    }
    try {
      return { code: 0, data: await setNtpServers(config, parsed.data.servers) }
    } catch (e) {
      fail(reply, e, '设置时间服务器')
    }
  })
}
