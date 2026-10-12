import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { osHelperConfigFromEnv, listInterfaces, getPendingChange, getFallback, scanWifi,
  testConnectivity, applyIpConfig, confirmChange, revertChange,
  wifiConnect, wifiDisconnect } from '../services/osHelperClient.js'

const IpMethodSchema = z.enum(['auto', 'manual', 'disabled', 'link-local'])
const IpFamilySchema = z.object({
  method: IpMethodSchema,
  address: z.string().max(45).optional(),
  netmask: z.string().max(15).optional(),
  gateway: z.string().max(45).optional(),
  dns: z.array(z.string().max(45)).max(6).optional(),
})
const ConfirmSchema = z.object({ id: z.string().min(1).max(64).optional() })
const IpConfigSchema = z.object({
  ipv4: IpFamilySchema,
  ipv6: IpFamilySchema,
  rollback_seconds: z.number().int().min(5).max(300).optional(),
})
const WifiConnectSchema = z.object({
  ssid: z.string().min(1).max(32),
  password: z.string().max(64).nullable().optional(),
  hidden: z.boolean().optional(),
})

/**
 * 网络管理路由 — 转发到 os-helper（宿主机系统操作服务）
 *
 * 网络配置是系统级操作（跟关机/重启一个级别），直接落到系统生效，
 * 不走配置中心的 PG 草稿→发布流程。安全回滚由 os-helper 端保证
 * （应用后 N 秒未确认自动还原）。
 */
const UNCONFIGURED_ROUTES: { method: 'GET' | 'PUT' | 'POST'; path: string }[] = [
  { method: 'GET', path: '/network/interfaces' },
  { method: 'GET', path: '/network/pending' },
  { method: 'GET', path: '/network/fallback' },
  { method: 'GET', path: '/network/interfaces/:iface/test' },
  { method: 'GET', path: '/network/wifi/:iface/scan' },
  { method: 'PUT', path: '/network/interfaces/:iface/config' },
  { method: 'POST', path: '/network/confirm' },
  { method: 'POST', path: '/network/revert' },
  { method: 'POST', path: '/network/wifi/:iface/connect' },
  { method: 'POST', path: '/network/wifi/:iface/disconnect' },
]

export async function networkRoutes(app: FastifyInstance) {
  const config = osHelperConfigFromEnv()

  // os-helper 未配置时，所有网络接口统一返回 503（不是只挂 /network/interfaces
  // 一条、其余落 404）——前端不管点开哪个操作，都应该看到一致的"未启用"提示，
  // 而不是有的接口给出清楚原因、有的接口像是路由压根不存在。
  if (!config) {
    for (const { method, path } of UNCONFIGURED_ROUTES) {
      app.route({
        method,
        url: path,
        handler: async (_req, reply) => {
          reply.code(503).send({ error: '系统助手未配置，网络管理不可用' })
        },
      })
    }
    return
  }

  // ---- 读操作 ----

  // 网卡列表
  app.get('/network/interfaces', async (req, reply) => {
    const all = (req.query as { all?: string }).all === 'true'
    try {
      const interfaces = await listInterfaces(config, all)
      return { code: 0, data: interfaces }
    } catch (e) {
      reply.code(503).send({ error: `获取网卡列表失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // 待确认的变更
  app.get('/network/pending', async (_req, reply) => {
    try {
      const pending = await getPendingChange(config)
      return { code: 0, data: pending }
    } catch (e) {
      reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 出厂兜底地址（没走 provisioning 的设备返回 data: null，不是错误）
  app.get('/network/fallback', async (_req, reply) => {
    try {
      const fallback = await getFallback(config)
      return { code: 0, data: fallback }
    } catch (e) {
      reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 连通性检测
  app.get('/network/interfaces/:iface/test', async (req, reply) => {
    const { iface } = req.params as { iface: string }
    try {
      const result = await testConnectivity(config, iface)
      return { code: 0, data: result }
    } catch (e) {
      reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // WiFi 扫描
  app.get('/network/wifi/:iface/scan', async (req, reply) => {
    const { iface } = req.params as { iface: string }
    const rescan = (req.query as { rescan?: string }).rescan !== 'false'
    try {
      const aps = await scanWifi(config, iface, rescan)
      return { code: 0, data: aps }
    } catch (e) {
      reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // ---- 写操作 ----

  // IP 配置（带安全回滚）
  app.put('/network/interfaces/:iface/config', async (req, reply) => {
    const { iface } = req.params as { iface: string }
    const parsed = IpConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400).send({ error: '参数无效', issues: parsed.error.issues })
      return
    }
    try {
      const result = await applyIpConfig(config, iface, parsed.data)
      reply.code(202).send({ code: 0, data: result })
    } catch (e) {
      reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 确认变更（取消回滚）。id 是前端看到的那次变更，os-helper 据此拒绝误确认另一次变更
  app.post('/network/confirm', async (req, reply) => {
    const parsed = ConfirmSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400).send({ error: '参数无效' })
      return
    }
    try {
      await confirmChange(config, parsed.data.id)
      return { code: 0 }
    } catch (e) {
      reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 手动回滚
  app.post('/network/revert', async (_req, reply) => {
    try {
      await revertChange(config)
      return { code: 0 }
    } catch (e) {
      reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // WiFi 连接
  app.post('/network/wifi/:iface/connect', async (req, reply) => {
    const { iface } = req.params as { iface: string }
    const parsed = WifiConnectSchema.safeParse(req.body)
    if (!parsed.success) {
      reply.code(400).send({ error: '参数无效' })
      return
    }
    try {
      await wifiConnect(config, iface, parsed.data.ssid, parsed.data.password ?? undefined, parsed.data.hidden)
      return { code: 0 }
    } catch (e) {
      reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // WiFi 断开
  app.post('/network/wifi/:iface/disconnect', async (req, reply) => {
    const { iface } = req.params as { iface: string }
    try {
      await wifiDisconnect(config, iface)
      return { code: 0 }
    } catch (e) {
      reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
