import { create } from 'zustand'
import { channelService } from '@/api/channelService'
import type { ChannelCreateInput, ChannelService } from '@/api/channelService'
import type { ChannelWithStatus } from '@/types/channel'

interface ChannelsState {
  channels: ChannelWithStatus[]
  loading: boolean
  error: string | null
  search: string
  fetchChannels: () => Promise<void>
  setSearch: (s: string) => void
  createChannel: (input: ChannelCreateInput) => Promise<ChannelWithStatus>
  updateChannel: (
    id: string,
    patch: Partial<ChannelCreateInput>,
  ) => Promise<ChannelWithStatus>
  deleteChannel: (id: string) => Promise<void>
}

/** 支持注入 service（测试用），默认全局单例 */
export function createChannelsStore(service: ChannelService = channelService) {
  return create<ChannelsState>((set, get) => ({
    channels: [],
    loading: false,
    error: null,
    search: '',

    async fetchChannels() {
      set({ loading: true, error: null })
      try {
        const { search } = get()
        const channels = await service.list({ search })
        set({ channels, loading: false })
      } catch (e) {
        set({
          loading: false,
          error: e instanceof Error ? e.message : '加载通道失败',
        })
      }
    },

    setSearch(search) {
      set({ search })
    },

    async createChannel(input) {
      const ch = await service.create(input)
      await get().fetchChannels()
      return ch
    },

    async updateChannel(id, patch) {
      const ch = await service.update(id, patch)
      await get().fetchChannels()
      return ch
    },

    async deleteChannel(id) {
      await service.remove(id)
      await get().fetchChannels()
    },
  }))
}

export const useChannelsStore = createChannelsStore()
