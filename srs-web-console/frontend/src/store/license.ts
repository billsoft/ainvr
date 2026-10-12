import { create } from 'zustand'
import { licenseService, toLicenseApiError } from '@/api/licenseService'
import type {
  LicenseEvent,
  LicenseStateName,
  LicenseStatus,
  MachineCodeInfo,
} from '@/types/license'

// 事件只在本机浏览器留存（运维排查"什么时候翻过状态"），不进任何后端存储。
const EVENTS_KEY = 'ainvr-license-events-v1'
const EVENTS_MAX = 50

export interface GateBlock {
  code: 'LICENSE_REQUIRED' | 'LICENSE_SERVICE_UNAVAILABLE'
  state?: LicenseStateName
  reason?: string
  at: number
}

interface LicenseState {
  status: LicenseStatus | null
  statusAt: number // 最近一次成功取到状态的 performance.now()
  statusLoading: boolean
  statusUnreachable: boolean

  machineCode: MachineCodeInfo | null
  machineCodeLoading: boolean
  machineCodeUnreachable: boolean

  activating: boolean

  events: LicenseEvent[]
  gateBlock: GateBlock | null

  refreshStatus: (force?: boolean) => Promise<void>
  refreshMachineCode: () => Promise<void>
  activate: (key: string) => Promise<LicenseStatus>
  remove: (confirmation: string) => Promise<void>
  /** httpClient 收到门控 503 时上报；授权恢复后由 refreshStatus 自动清除 */
  reportGateBlock: (block: Omit<GateBlock, 'at'>) => void
  clearGateBlock: () => void
}

function loadEvents(): LicenseEvent[] {
  try {
    const raw = localStorage.getItem(EVENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as LicenseEvent[]
    return Array.isArray(parsed) ? parsed.filter((event) => event && Number.isFinite(event.at) && ['state', 'activate-ok', 'activate-failed', 'service-lost', 'service-back'].includes(event.kind)).slice(0, EVENTS_MAX) : []
  } catch {
    return []
  }
}

function persistEvents(events: LicenseEvent[]) {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(0, EVENTS_MAX)))
  } catch {
    // 隐私模式/配额满都不影响主流程
  }
}

export const useLicenseStore = create<LicenseState>((set, get) => {
  let generation = 0
  function pushEvent(ev: Omit<LicenseEvent, 'at'> & { at?: number }) {
    const next = [{ ...ev, at: ev.at ?? Date.now() }, ...get().events].slice(0, EVENTS_MAX)
    set({ events: next })
    persistEvents(next)
  }

  return {
    status: null,
    statusAt: 0,
    statusLoading: false,
    statusUnreachable: false,
    machineCode: null,
    machineCodeLoading: false,
    machineCodeUnreachable: false,
    activating: false,
    events: loadEvents(),
    gateBlock: null,

    async refreshStatus(force = false) {
      if (get().statusLoading || get().activating) return
      const requestGeneration = generation
      set({ statusLoading: true })
      try {
        const prev = get().status
        const wasUnreachable = get().statusUnreachable
        const status = await licenseService.getStatus(force)
        if (requestGeneration !== generation) return
        set({
          status,
          statusAt: performance.now(),
          statusLoading: false,
          statusUnreachable: false,
          // 只有后端确认持有有效业务租约才能解除门控提示
          ...(status.state === 'valid' && status.business_allowed === true ? { gateBlock: null } : {}),
        })
        if (wasUnreachable) pushEvent({ kind: 'service-back' })
        if (!prev || prev.state !== status.state) {
          pushEvent({ kind: 'state', state: status.state, message: status.reason || undefined })
        }
      } catch (e) {
        if (requestGeneration !== generation) return
        const wasUnreachable = get().statusUnreachable
        set({ statusLoading: false, statusUnreachable: true })
        if (!wasUnreachable) {
          pushEvent({ kind: 'service-lost', message: toLicenseApiError(e).message })
        }
      }
    },

    async refreshMachineCode() {
      set({ machineCodeLoading: true })
      try {
        const machineCode = await licenseService.getMachineCode()
        set({ machineCode, machineCodeLoading: false, machineCodeUnreachable: false })
      } catch {
        set({ machineCodeLoading: false, machineCodeUnreachable: true })
      }
    },

    async activate(key: string) {
      if (get().activating) throw new Error('授权操作正在进行，请稍后重试')
      ++generation
      set({ activating: true, statusLoading: false })
      try {
        const status = await licenseService.activate(key)
        set({
          status,
          statusAt: performance.now(),
          statusUnreachable: false,
          activating: false,
          ...(status.state === 'valid' && status.business_allowed === true ? { gateBlock: null } : {}),
        })
        pushEvent({ kind: 'activate-ok', state: status.state })
        return status
      } catch (e) {
        const apiError = toLicenseApiError(e)
        set({ activating: false })
        pushEvent({ kind: 'activate-failed', message: apiError.message })
        throw apiError
      }
    },

    async remove(confirmation: string) {
      if (get().activating) throw new Error('授权操作正在进行，请稍后重试')
      ++generation
      set({ activating: true, statusLoading: false })
      try {
        const status = await licenseService.remove(confirmation)
        set({ status, statusAt: performance.now(), statusUnreachable: false,
          gateBlock: { code: 'LICENSE_REQUIRED', state: 'unlicensed', at: Date.now() } })
        pushEvent({ kind: 'state', state: 'unlicensed', message: '注册密钥已删除' })
      } catch (error) {
        throw toLicenseApiError(error)
      } finally {
        set({ activating: false })
        void get().refreshStatus(true)
      }
    },

    reportGateBlock(block) {
      // 同一拦截原因不重复覆盖（保留首次时间，避免顶栏提示闪烁）
      const cur = get().gateBlock
      if (cur && cur.code === block.code && cur.state === block.state) return
      set({ gateBlock: { ...block, at: Date.now() } })
    },

    clearGateBlock() {
      set({ gateBlock: null })
    },
  }
})
