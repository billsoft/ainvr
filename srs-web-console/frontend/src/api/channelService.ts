import type { Channel, ChannelWithStatus } from '@/types/channel'
import { mockChannels } from '@/mock/channels'
import { createHttpChannelService } from './httpChannelService'

/** 创建/编辑通道的输入（不含 id 与服务端生成的字段） */
export interface ChannelCreateInput {
  name: string
  description?: string
  upstream: Channel['upstream']
  downstream: Channel['downstream']
}

/** 通道服务接口 —— Phase 1-3 用 mock 实现，Phase 4 切换 BFF HTTP 实现 */
export interface ChannelService {
  list(query?: { search?: string }): Promise<ChannelWithStatus[]>
  get(id: string): Promise<ChannelWithStatus | null>
  create(input: ChannelCreateInput): Promise<ChannelWithStatus>
  update(id: string, patch: Partial<ChannelCreateInput>): Promise<ChannelWithStatus>
  remove(id: string): Promise<void>
  /** 强制断开推流（Phase 4 对接 SRS /api/v1/clients/{id} DELETE） */
  kick(id: string): Promise<void>
}

// ... (mock 实现保持不变，用于测试)

const delay = (ms = 80) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 内存版 mock 实现：CRUD 语义与未来 BFF 完全一致，组件层无感切换
 * 用于单元测试 / Storybook / 离线开发
 */
export function createMockChannelService(
  seed: ChannelWithStatus[] = [],
): ChannelService {
  let seq = 0
  const store = new Map<string, ChannelWithStatus>()
  for (const ch of seed) {
    seq = Math.max(seq, Number(ch.id.replace(/^ch-/, '')) || 0)
    store.set(ch.id, structuredClone(ch))
  }

  const nextId = () => `ch-${String(seq + 1).padStart(3, '0')}`
  const offlineStatus = (id: string) => ({
    channelId: id,
    online: false,
    viewerCount: 0,
  })

  return {
    async list({ search } = {}) {
      await delay()
      let arr = [...store.values()]
      const q = search?.trim().toLowerCase()
      if (q) {
        arr = arr.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.description ?? '').toLowerCase().includes(q) ||
            c.upstream.stream.toLowerCase().includes(q),
        )
      }
      return arr.map((c) => structuredClone(c))
    },

    async get(id) {
      await delay()
      const ch = store.get(id)
      return ch ? structuredClone(ch) : null
    },

    async create(input) {
      await delay()
      const id = nextId()
      seq += 1
      const now = new Date().toISOString()
      const ch: ChannelWithStatus = {
        id,
        name: input.name,
        description: input.description,
        upstream: structuredClone(input.upstream),
        downstream: structuredClone(input.downstream),
        createdAt: now,
        updatedAt: now,
        status: offlineStatus(id),
      }
      store.set(id, ch)
      return structuredClone(ch)
    },

    async update(id, patch) {
      await delay()
      const cur = store.get(id)
      if (!cur) throw new Error(`通道不存在: ${id}`)
      const next: ChannelWithStatus = {
        ...cur,
        ...patch,
        upstream: patch.upstream
          ? { ...cur.upstream, ...patch.upstream }
          : cur.upstream,
        downstream: patch.downstream
          ? { ...cur.downstream, ...patch.downstream }
          : cur.downstream,
        updatedAt: new Date().toISOString(),
      }
      store.set(id, next)
      return structuredClone(next)
    },

    async remove(id) {
      await delay()
      if (!store.has(id)) throw new Error(`通道不存在: ${id}`)
      store.delete(id)
    },

    async kick(id) {
      await delay()
      if (!store.has(id)) throw new Error(`通道不存在: ${id}`)
      // mock：直接置为离线；Phase 4 调 SRS API
      const cur = store.get(id)!
      store.set(id, {
        ...cur,
        status: { ...cur.status, online: false, viewerCount: 0 },
      })
    },
  }
}

/**
 * 全局单例
 * - 生产/开发：HTTP 实现（调 BFF）
 * - 测试：mock 实现（内存）
 */
const isTestEnv =
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  (import.meta.env.MODE === 'test' || import.meta.env.VITEST === 'true')

export const channelService: ChannelService = isTestEnv
  ? createMockChannelService(mockChannels)
  : createHttpChannelService()
