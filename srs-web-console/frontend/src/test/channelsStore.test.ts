import { createChannelsStore } from '@/store/channels'
import { createMockChannelService } from '@/api/channelService'
import { mockChannels } from '@/mock/channels'
import type { ChannelService } from '@/api/channelService'

function setup(seed = mockChannels) {
  const svc = createMockChannelService(seed)
  return { svc, store: createChannelsStore(svc) }
}

const input = {
  name: '新通道',
  upstream: { protocol: 'rtmp' as const, app: 'live', stream: 'new_stream' },
  downstream: { protocols: ['flv' as const], primary: 'flv' as const },
}

describe('channels store', () => {
  it('fetchChannels 加载数据并结束 loading', async () => {
    const { store } = setup()
    expect(store.getState().channels).toHaveLength(0)
    const p = store.getState().fetchChannels()
    expect(store.getState().loading).toBe(true)
    await p
    const s = store.getState()
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
    expect(s.channels).toHaveLength(5)
  })

  it('fetchChannels 携带当前 search 关键字', async () => {
    const calls: Array<{ search?: string } | undefined> = []
    const spy: ChannelService = {
      ...createMockChannelService(mockChannels),
      list: async (q) => {
        calls.push(q)
        return []
      },
    }
    const store = createChannelsStore(spy)
    store.getState().setSearch('大门')
    await store.getState().fetchChannels()
    expect(calls[0]).toEqual({ search: '大门' })
  })

  it('service 抛错时 error 置位且 loading 复位', async () => {
    const boom: ChannelService = {
      list: async () => {
        throw new Error('SRS 不可达')
      },
      get: async () => null,
      create: async () => {
        throw new Error('x')
      },
      update: async () => {
        throw new Error('x')
      },
      remove: async () => undefined,
      kick: async () => undefined,
    }
    const store = createChannelsStore(boom)
    await store.getState().fetchChannels()
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBe('SRS 不可达')
  })

  it('createChannel 后列表自动刷新', async () => {
    const { store } = setup()
    await store.getState().fetchChannels()
    await store.getState().createChannel(input)
    const names = store.getState().channels.map((c) => c.name)
    expect(names).toContain('新通道')
    expect(store.getState().channels).toHaveLength(6)
  })

  it('deleteChannel 后列表自动刷新', async () => {
    const { store } = setup()
    await store.getState().fetchChannels()
    await store.getState().deleteChannel('ch-001')
    expect(store.getState().channels.map((c) => c.id)).not.toContain('ch-001')
    expect(store.getState().channels).toHaveLength(4)
  })

  it('updateChannel 后列表自动刷新', async () => {
    const { store } = setup()
    await store.getState().fetchChannels()
    await store.getState().updateChannel('ch-001', { name: '新名字' })
    expect(
      store.getState().channels.find((c) => c.id === 'ch-001')?.name,
    ).toBe('新名字')
  })
})
