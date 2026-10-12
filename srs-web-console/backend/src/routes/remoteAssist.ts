import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { osHelperConfigFromEnv, getRemoteAssistStatus, listRemoteAssistEvents, setRemoteAssistEnabled,
  updateRemoteAssistServer, testRemoteAssist } from '../services/osHelperClient.js'
import type { PasswordCache } from '../services/passwordCache.js'
import { verifyPassword } from '../services/passwordHash.js'
import { LoginAttempts } from '../services/consoleSessions.js'
import { clientIdentity } from '../services/proxyIdentity.js'

/**
 * 远程协助路由 — 转发到 os-helper（宿主机上管理隧道进程）。
 *
 * 与网络管理同属系统级操作，直接生效、不走配置中心 PG 流程，也不依赖授权：
 * 授权出故障时恰恰最需要远程协助。修改中转服务器等同于决定"设备交给谁维护"，
 * 必须再次验证管理员密码；开关只需已登录。控制台只有一个管理员身份，操作人记为 admin。
 */
const ACTOR = 'admin'
const HostSchema = z.string().trim().min(1).max(253)
const ServerSchema = z.object({
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  password: z.string().max(256).optional(),
})

export interface RemoteAssistRouteOptions {
  passwordCache?: PasswordCache
}

const UNCONFIGURED: { method: 'GET' | 'PUT' | 'POST'; url: string }[] = [
  { method: 'GET', url: '/remote-assist' },
  { method: 'GET', url: '/remote-assist/events' },
  { method: 'POST', url: '/remote-assist/enable' },
  { method: 'POST', url: '/remote-assist/disable' },
  { method: 'POST', url: '/remote-assist/test' },
  { method: 'PUT', url: '/remote-assist/server' },
]

/** 只透传宿主机给出的中文业务错误；连接失败、内部错误等一律换成固定中文提示。 */
function failure(e: unknown, fallback: string) {
  const { status, helperMessage } = (e ?? {}) as { status?: unknown; helperMessage?: unknown }
  if (typeof status === 'number' && typeof helperMessage === 'string' && /[一-鿿]/.test(helperMessage))
    return { status, error: helperMessage }
  return { status: 503, error: fallback }
}

export function registerRemoteAssistRoutes(app: FastifyInstance, opts: RemoteAssistRouteOptions) {
  const config = osHelperConfigFromEnv()
  if (!config) {
    for (const route of UNCONFIGURED) {
      app.route({ ...route, handler: async (_req, reply) => {
        reply.code(503).send({ error: '系统助手未配置，远程协助不可用' })
      } })
    }
    return
  }
  const attempts = new LoginAttempts()

  app.get('/remote-assist', async (_req, reply) => {
    try {
      return { code: 0, data: await getRemoteAssistStatus(config) }
    } catch {
      reply.code(503).send({ error: '暂时无法读取远程协助状态，请稍后重试' })
    }
  })

  app.get('/remote-assist/events', async (req, reply) => {
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50))
    try {
      return { code: 0, data: await listRemoteAssistEvents(config, limit) }
    } catch {
      reply.code(503).send({ error: '暂时无法读取远程协助记录，请稍后重试' })
    }
  })

  for (const enabled of [true, false]) {
    app.post(`/remote-assist/${enabled ? 'enable' : 'disable'}`, async (_req, reply) => {
      try {
        await setRemoteAssistEnabled(config, enabled, ACTOR)
        return { code: 0 }
      } catch (e) {
        const { status, error } = failure(e, enabled ? '远程协助开启失败，请稍后重试' : '远程协助关闭失败，请稍后重试')
        reply.code(status).send({ error })
      }
    })
  }

  app.post('/remote-assist/test', async (_req, reply) => {
    try {
      return { code: 0, data: await testRemoteAssist(config) }
    } catch (e) {
      const { status, error } = failure(e, '暂时无法检测连通性，请稍后重试')
      reply.code(status).send({ error })
    }
  })

  app.put('/remote-assist/server', async (req, reply) => {
    const parsed = ServerSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '中转服务器地址或端口无效' })
    const hash = await opts.passwordCache?.get()
    if (hash) {
      const ip = clientIdentity(req).ip
      if (!attempts.enter(ip)) return reply.header('Retry-After', '60').code(429).send({ error: '验证过于频繁，请一分钟后重试' })
      let verified = false
      try { verified = !!parsed.data.password && await verifyPassword(parsed.data.password, hash) }
      finally { attempts.leave(ip, verified) }
      if (!verified) return reply.code(403).send({ error: '管理员密码不正确' })
    }
    try {
      const server = await updateRemoteAssistServer(config, parsed.data.host, parsed.data.port, ACTOR)
      return { code: 0, data: server }
    } catch (e) {
      const { status, error } = failure(e, '中转服务器保存失败，请稍后重试')
      reply.code(status).send({ error })
    }
  })
}
