import { create, type StateCreator } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { aiChannelService } from '@/api/aiChannelService'
import type { AiChannelService } from '@/api/aiChannelService'
import type {
  AiChannel, AiChannelCreatePatch, AiChannelUpdatePatch, AiConfigUpdateResult, AiStreamOption,
} from '@/types/aiChannel'

interface AiChannelsState {
  channels: AiChannel[]
  loading: boolean
  error: string | null
  /** health() 探测失败时置位——降级横幅、禁用新建/编辑/启停按钮都靠这个,
   * 不是靠某次请求 catch 到异常临时判断（那样横幅会闪烁）。*/
  serviceUnreachable: boolean
  fetchChannels: () => Promise<void>
  checkHealth: () => Promise<void>
  createChannel: (patch: AiChannelCreatePatch) => Promise<AiChannel>
  updateChannel: (id: string, patch: AiChannelUpdatePatch) => Promise<AiConfigUpdateResult>
  deleteChannel: (id: string) => Promise<void>
  startChannel: (id: string) => Promise<void>
  stopChannel: (id: string) => Promise<void>
  listStreams: () => Promise<AiStreamOption[]>
}

/** 支持注入 service（测试用）+ 可选的 sessionStorage 持久化 key（只有生产
 * 单例传，测试工厂不传——避免多个测试各自 createAiChannelsStore() 时
 * 互相从同一个 sessionStorage key 读到上一个测试写下的脏数据）。 */
export function createAiChannelsStore(
  service: AiChannelService = aiChannelService,
  persistKey?: string,
) {
  const stateCreator: StateCreator<AiChannelsState> = (set, get) => ({
    channels: [],
    loading: false,
    error: null,
    serviceUnreachable: false,

    async fetchChannels() {
      set({ loading: true, error: null })
      try {
        const channels = await service.list()
        // 拉列表成功本身就说明服务可达——不需要额外等 checkHealth 那一轮
        // 才清掉横幅，用户点开页面第一时间看到的应该是真实状态。
        set({ channels, loading: false, serviceUnreachable: false })
      } catch (e) {
        // 拉取失败：保留上一次成功的列表（架构 §11.3.6"前端保留最后一次
        // 成功列表"），不清空 channels，只标记不可达 + 记录错误文案。
        // 这份"上一次成功的列表"现在还能扛住整页刷新——见下面 persist 配置，
        // 刷新后 store 重新初始化时会先从 sessionStorage 里把它取回来，
        // 不会在服务已知不可达的情况下把上次数据也一起丢成空列表（审计发现 P1-7）。
        set({
          loading: false,
          serviceUnreachable: true,
          error: e instanceof Error ? e.message : '加载 AI 通道失败',
        })
      }
    },

    async checkHealth() {
      const health = await service.health()
      set({ serviceUnreachable: health === null })
    },

    // create/update 的响应体本身就带回了完整的新/改后通道对象——直接拿它
    // 更新本地列表，不必再等一轮全量 fetchChannels()（审计发现 P1-5：
    // 此前每次操作后都整表重拉，多打一次请求，操作反馈也多等一轮网络延迟）。
    async createChannel(patch) {
      const ch = await service.create(patch)
      set((s) => ({ channels: [...s.channels, ch] }))
      return ch
    },

    async updateChannel(id, patch) {
      const result = await service.update(id, patch)
      set((s) => ({ channels: s.channels.map((c) => (c.id === id ? result.channel : c)) }))
      return result
    },

    // delete/start/stop 的响应体不带完整通道对象（delete 只回 {deleted:true}，
    // start/stop 只回 {status:'starting'|'stopping'}），没有权威数据可以直接
    // 拿来更新列表——这三个改成真正的乐观更新：先本地改，失败了再回滚，
    // 让用户点击后立刻看到反馈，不用干等一整轮网络往返。
    async deleteChannel(id) {
      const prev = get().channels
      set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }))
      try {
        await service.remove(id)
      } catch (e) {
        set({ channels: prev })
        throw e
      }
    },

    async startChannel(id) {
      const prev = get().channels
      set((s) => ({
        channels: s.channels.map((c) => (c.id === id ? { ...c, state: 'starting' } : c)),
      }))
      try {
        await service.start(id)
        // start()/stop() 只回一个过渡态，最终是不是真的 running/idle 要等
        // 下一轮轮询或这次显式重拉才知道——乐观更新只负责"立刻给个反馈"，
        // 不代替这次真正的状态核实。
        await get().fetchChannels()
      } catch (e) {
        set({ channels: prev })
        throw e
      }
    },

    async stopChannel(id) {
      const prev = get().channels
      set((s) => ({
        channels: s.channels.map((c) => (c.id === id ? { ...c, state: 'stopping' } : c)),
      }))
      try {
        await service.stop(id)
        await get().fetchChannels()
      } catch (e) {
        set({ channels: prev })
        throw e
      }
    },

    async listStreams() {
      return service.listStreams()
    },
  })

  if (!persistKey) {
    return create<AiChannelsState>(stateCreator)
  }

  return create<AiChannelsState>()(
    persist(stateCreator, {
      name: persistKey,
      storage: createJSONStorage(() => sessionStorage),
      // 只镜像 channels 本身——loading/error/serviceUnreachable 都是瞬态，
      // 页面重新挂载后会被 fetchChannels()/checkHealth() 立刻重新计算，
      // 存旧值反而可能让刷新那一瞬间显示出跟真实情况不符的过渡态。
      partialize: (s) => ({ channels: s.channels }),
    }),
  )
}

export const useAiChannelsStore = createAiChannelsStore(aiChannelService, 'ai-channels-last-known')
