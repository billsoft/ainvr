import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CalendarClock, Code2, Settings, Sparkles, Sun, Trash2 } from 'lucide-react'
import { aiChannelService } from '@/api/aiChannelService'
import { snapshotService } from '@/api/snapshotService'
import { groupSnapshotsByFrame } from '@/utils/snapshotGrouping'
import { isFaceDetectionModel } from '@/utils/channelMatching'
import { SnapshotGroupCard } from './SnapshotGroupCard'
import { ChannelSettingsDialog, type ChannelSettingsPatch } from './ChannelSettingsDialog'
import { ApiExampleDialog } from './ApiExampleDialog'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { DEFAULT_PRESET, RANGE_PRESETS, formatRangeShort, parseDatetimeLocalValue, presetRange } from '@/utils/timeRange'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { Toaster } from '@/components/ui/Toaster'
import { formatBytes } from '@/utils/format'
import { toast } from '@/store/toast'
import type { SnapshotItem, SnapshotOverview } from '@/types/snapshot'
import type { AiFaceEnhanceModel, AiServiceHealth, AiSnapshotProjectionMode } from '@/types/aiChannel'

interface ChannelRow {
  id: string
  name: string
  overview: SnapshotOverview | null
  projectionMode: AiSnapshotProjectionMode
  /** 截图亮度校正开关 + 目标亮度（0-255，128≈L*50 中性），热更新 */
  brightnessEnabled: boolean
  brightnessTarget: number
  /** 选中的人脸修复模型（none=不增强 / gpen=256 / codeformer=512） */
  faceModel: AiFaceEnhanceModel
  /** 增强强度 0-1（1=全量，0.5=半强度） */
  faceBlend: number
  /** 只有人脸识别通道（scrfd_trt）支持人脸修复模型 */
  faceChannel: boolean
}

const PROJECTION_MODE_LABEL: Record<AiSnapshotProjectionMode, string> = {
  none: '不启用坐标转换',
  erp_equirect: 'ERP 全景图坐标展开',
}

const HISTORY_UNAVAILABLE_COPY: Record<NonNullable<SnapshotOverview['reason']>, { label: string; message: string }> = {
  license_pending: {
    label: '等待授权',
    message: '正在等待设备授权，授权通过后自动恢复识别历史，无需操作；已有历史不受影响。',
  },
  channel_deleting: { label: '正在删除', message: '通道正在删除，暂时无法访问识别历史。' },
  service_stopping: { label: '正在停止', message: '服务正在停止或进行授权收尾，完成后自动刷新历史访问状态；已有历史仍保留。' },
  unavailable: { label: '暂不可用', message: '归档访问暂不可用，正在自动重试；已有历史仍保留。' },
}

/** 详情页头部徽标：只给真正启用的模型显示，文案带画布尺寸（与
 * face_enhancer.MODEL_SPECS 一致）。 */
const FACE_MODEL_BADGE: Partial<Record<AiFaceEnhanceModel, { label: string; title: string }>> = {
  gpen: {
    label: '人脸增强 256',
    title: '保存的人脸截图经快速修复增强为 256×256（等比缩放、灰边补齐）',
  },
  codeformer: {
    label: '人脸增强 512',
    title: '保存的人脸截图经精细修复为 512×512（等比缩放、灰边补齐）',
  },
}

/** 时间范围快捷按钮 + 默认范围计算 → ./timeRange.ts（跟弹窗选择器共用
 * 同一份预设表和格式化逻辑，不在这两处各写一套）。 */

/** 用量占比转颜色——三档阈值，复用设计系统里已有的 success/warning/danger
 * token（tailwind.config），不是新发明一套配色。 */
function usageBarColor(percent: number): string {
  if (percent >= 90) return 'bg-danger'
  if (percent >= 70) return 'bg-warning'
  return 'bg-success'
}

function UsageBar({ percent, className = '' }: { percent: number; className?: string }) {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-page ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] ${usageBarColor(clamped)}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

function percentOf(count: number | undefined, max: number | undefined): number {
  if (!max) return 0
  return ((count ?? 0) / max) * 100
}

/**
 * 识别历史——左侧通道列表 + 右侧时间轴，视觉/交互对齐 Monitor 页
 * （左侧 aside 通道列表、右侧内容区是同一套布局语言，用户明确要求过
 * "跟实时画面预览差不多"）。原来是概况网格页 + 独立详情页两个路由，
 * 现在合并成一个组件：`/recognition-history` 和
 * `/recognition-history/:channelId` 都渲染这个组件，channelId 只是
 * "当前选中哪个通道"，不是两个不同的页面。
 *
 * 只读信息（数量/占用/投影模式当前值）直接在页面上可见；需要编辑的
 * 设置（保留条数上限、截图变换、清空）收进通道行悬停才出现的设置
 * 按钮里弹窗编辑，跟"只读信息直接可见、设置操作藏进编辑弹窗"这条
 * 明确要求对齐，不再把可编辑控件常驻铺在页面上。
 *
 * 故意不出现"MongoDB/集合/文档"这类技术词——用户看到的、我们代码里叫的，
 * 统一是"记录/识别历史"。
 */
export default function RecognitionHistoryPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()

  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [health, setHealth] = useState<AiServiceHealth | null>(null)

  const [items, setItems] = useState<SnapshotItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // 进入页面默认就是"最近 10 分钟"——用 useState 初始化器直接播种成
  // presetRange(DEFAULT_PRESET) 的结果，而不是空串 + mount effect 再补一次。
  // 后者会先以空范围 fetch 一次、range 变化后再 fetch 一次，凭空多一次
  // 请求，且这次多余的请求正是"进page时先斩后奏"的那种绕过。播种保证
  // range 从第一帧起就是确定的，只会触发一次搜索。
  const [rangeFrom, setRangeFrom] = useState(() => presetRange(DEFAULT_PRESET).from)
  const [rangeTo, setRangeTo] = useState(() => presetRange(DEFAULT_PRESET).to)
  // 当前生效的范围是不是某个快捷预设——只用来给按钮画选中态，不参与
  // 任何请求逻辑；null 表示当前范围来自弹窗手选的自定义区间。
  const [selectedPreset, setSelectedPreset] = useState<string | null>(DEFAULT_PRESET.label)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [minConfidence, setMinConfidence] = useState('')
  const [confirmDeleteRange, setConfirmDeleteRange] = useState(false)
  const [apiExampleOpen, setApiExampleOpen] = useState(false)
  const [clearTarget, setClearTarget] = useState<ChannelRow | null>(null)
  const [settingsTarget, setSettingsTarget] = useState<ChannelRow | null>(null)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const toggleInFlight = useRef(new Set<string>())
  const archiveRevision = useRef(0)

  // 唯一一条"范围变了"的路径——快捷按钮点击、弹窗确定，都只准调这个
  // 函数，不允许各自直接 setRangeFrom/setRangeTo。range 变化本身已经
  // 由下面 buildFilters → useEffect([channelId, loadFirstPage]) 驱动
  // 搜索，这里不需要、也不应该再手动触发一次加载。
  const applyRange = useCallback((from: string, to: string, presetLabel: string | null) => {
    setRangeFrom(from)
    setRangeTo(to)
    setSelectedPreset(presetLabel)
  }, [])

  async function loadChannels() {
    setChannelsLoading(true)
    try {
      const list = await aiChannelService.list()
      const overviews = await Promise.all(
        list.map((c) => snapshotService.getOverview(c.id).catch(() => null)),
      )
      setChannels(list.map((c, i) => ({
        id: c.id,
        name: c.name,
        overview: overviews[i] ?? null,
        projectionMode: c.config.snapshot.projection_mode,
        brightnessEnabled: c.config.snapshot.brightness_enabled ?? false,
        brightnessTarget: c.config.snapshot.brightness_target ?? 128,
        faceModel: c.config.snapshot.face_enhance_model ?? 'none',
        faceBlend: c.config.snapshot.face_enhance_blend ?? 0.5,
        faceChannel: isFaceDetectionModel(c.config.model),
      })))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载通道列表失败')
    } finally {
      setChannelsLoading(false)
    }
  }

  useEffect(() => {
    void loadChannels()
    void aiChannelService.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  // 进入页面默认选中第一个通道——不用再先点一下才能看到内容。
  // replace 不 push：这是"进来自动定位"，不是用户主动导航，不该占浏览器历史。
  useEffect(() => {
    const first = channels[0]
    if (!channelsLoading && !channelId && first) {
      navigate(`/recognition-history/${first.id}`, { replace: true })
    }
  }, [channelsLoading, channelId, channels, navigate])

  const selected = channels.find((c) => c.id === channelId) ?? null

  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  // busyRef 是独立于 React state 的同步并发闸门，理由见 RecognitionHistoryDetail
  // 旧版头注（这次合并页面时原样保留了这条修复）：state 镜像进 ref 那套
  // 写法要等下一次渲染才会同步新值，channelId 切换的重置 effect 和滚动
  // 哨兵的 IntersectionObserver effect 背靠背同步跑在同一轮 effects 里时
  // 会读到没来得及同步的旧值，导致并发重复请求或新通道加载不出来。
  const busyRef = useRef(false)
  const queryGenerationRef = useRef(0)
  // 每次搜索最多主动"补屏"8 次——见下面 maybeTopUp。够填两屏还留余量，
  // 同时防止"服务端一直返回极少条目"这种异常情况下反复触发导致请求风暴；
  // 正常情况下补到两屏或 hasMore=false 就会自然停，用不到这个上限。
  const fillAttemptsRef = useRef(0)

  // 时间范围 + 置信度下限是"搜索"条件——跟前面的手动选择框/快捷按钮共用
  // 同一份 state，任何一个变了都要重新查（下面 effect 里 reset+reload）。
  // 空字符串/0 都表示"不过滤"，不发对应的查询参数。
  const buildFilters = useCallback(() => {
    const parsedConfidence = Number(minConfidence)
    const filters: { minConfidence?: number; fromTs?: number; toTs?: number } = {}
    if (minConfidence !== '' && Number.isFinite(parsedConfidence) && parsedConfidence > 0) {
      filters.minConfidence = parsedConfidence / 100
    }
    if (rangeFrom) filters.fromTs = new Date(rangeFrom).getTime() / 1000
    if (rangeTo) filters.toTs = new Date(rangeTo).getTime() / 1000
    return filters
  }, [minConfidence, rangeFrom, rangeTo])

  const loadMore = useCallback(async () => {
    if (!channelId) return
    if (busyRef.current || !hasMoreRef.current) return
    const generation = queryGenerationRef.current
    busyRef.current = true
    setDetailLoading(true)
    try {
      const page = await snapshotService.listPage(channelId, cursorRef.current, 20, buildFilters())
      if (generation !== queryGenerationRef.current) return
      setItems((prev) => [...prev, ...page.items])
      setCursor(page.next_cursor)
      // 0 条但仍带 cursor 是服务端异常状态（正常分页要么有条目要么 cursor
      // 为 null）——按 hasMore=false 兜底，防止补屏循环对着一个不会再有
      // 数据的游标反复请求。
      setHasMore(page.items.length > 0 && page.next_cursor != null)
    } catch (e) {
      if (generation !== queryGenerationRef.current) return
      setChannels(previous => previous.map(c => c.id === channelId ? { ...c, overview: null } : c))
      toast.error(e instanceof Error ? e.message : '加载识别历史失败')
    } finally {
      if (generation === queryGenerationRef.current) {
        busyRef.current = false
        setDetailLoading(false)
      }
    }
  }, [channelId, buildFilters])

  const loadFirstPage = useCallback(async (isStale: () => boolean = () => false) => {
    if (!channelId) return
    const generation = queryGenerationRef.current
    busyRef.current = true
    setDetailLoading(true)
    try {
      const page = await snapshotService.listPage(channelId, null, 20, buildFilters())
      if (isStale() || generation !== queryGenerationRef.current) return
      setItems(page.items)
      setCursor(page.next_cursor)
      setHasMore(page.next_cursor != null)
    } catch (e) {
      if (!isStale() && generation === queryGenerationRef.current) {
        setChannels(previous => previous.map(c => c.id === channelId ? { ...c, overview: null } : c))
        toast.error(e instanceof Error ? e.message : '加载识别历史失败')
      }
    } finally {
      if (!isStale() && generation === queryGenerationRef.current) {
        busyRef.current = false
        setDetailLoading(false)
      }
    }
  }, [channelId, buildFilters])

  // Refresh dependency state while the page stays open. Sequential rounds avoid
  // piling up database requests; discard responses after navigation/unmount.
  const channelIds = JSON.stringify(channels.map(c => c.id))
  const channelsRef = useRef(channels)
  channelsRef.current = channels
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const ids = JSON.parse(channelIds) as string[]
    async function poll() {
      const revision = archiveRevision.current
      const overviews = await Promise.all(ids.map(id => snapshotService.getOverview(id).catch(() => null)))
      if (cancelled) return
      if (revision !== archiveRevision.current) {
        timer = setTimeout(() => void poll(), 10000)
        return
      }
      const selectedIndex = ids.indexOf(channelId ?? '')
      const recovered = selectedIndex >= 0 && overviews[selectedIndex]?.connected === true &&
        channelsRef.current.find(c => c.id === channelId)?.overview?.connected !== true
      setChannels(previous => previous.map(c => {
        const index = ids.indexOf(c.id)
        return index < 0 ? c : { ...c, overview: overviews[index] ?? null }
      }))
      if (recovered) {
        ++queryGenerationRef.current
        fillAttemptsRef.current = 0
        await loadFirstPage(() => cancelled)
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 10000)
    }
    timer = setTimeout(() => void poll(), 10000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [channelIds, channelId, loadFirstPage])

  // channelId 切换或搜索条件（时间范围/置信度）任何一个变化都要重新拉第一页——
  // 时间范围/置信度切通道时故意不清空：同一个筛选条件挨个通道看是常见用法
  // （比如"看看每个通道最近2小时有没有记录"），不用每切一次通道重填一遍。
  useEffect(() => {
    let cancelled = false
    setItems([])
    setCursor(null)
    setHasMore(true)
    fillAttemptsRef.current = 0
    if (channelId) void loadFirstPage(() => cancelled)
    return () => {
      cancelled = true
      ++queryGenerationRef.current
    }
  }, [channelId, loadFirstPage])

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // 总有一屏提前准备好数据：不是等用户滚到 sentinel 才去拿下一页，而是
  // 每次拿到新数据后检查"当前滚动容器里剩余可滚动内容够不够撑满两屏"，
  // 不够就继续拿——直到够了或者 hasMore=false。数据总量不多（搜索结果
  // 一两页就到底）时，这个循环会自己在 hasMore 变 false 后停下，不会
  // 无限重试。
  const maybeTopUp = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (busyRef.current || !hasMoreRef.current) return
    if (fillAttemptsRef.current >= 8) return
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    if (remaining < el.clientHeight * 2) {
      fillAttemptsRef.current += 1
      void loadMore()
    }
  }, [loadMore])

  // 列表容器（scrollRef/sentinelRef 所在处）只有 channelId 和 selected 都就绪
  // 才渲染——而 selected 依赖"通道列表 + 逐个概览"两跳，首页快照数据可能先到。
  // 下面两个 effect 都必须在容器挂载时重跑，否则补屏拿不到容器、哨兵从未被
  // 观察，页面永远停在第一页（2026-09-23 生产复现："10 分钟只查到 2 条"）。
  const listReady = Boolean(channelId && selected)

  // detailLoading 也列进依赖：每次加载结束（busyRef 已释放）再检查一次是否
  // 还不够两屏——哨兵加载后仍处于可见区时 IntersectionObserver 不会再回调，
  // 只能靠这里接力。
  useEffect(() => {
    maybeTopUp()
  }, [items, listReady, detailLoading, maybeTopUp])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore()
      },
      { root: scrollRef.current, rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore, listReady])

  async function handleDeleteOne(imageId: string) {
    if (!channelId) return
    try {
      await snapshotService.deleteOne(channelId, imageId)
      setItems((prev) => prev.filter((i) => i.image_id !== imageId))
      toast.success('已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleteTarget(null)
    }
  }

  async function handleDeleteRange() {
    if (!channelId) return
    const fromTs = new Date(rangeFrom).getTime() / 1000
    const toTs = new Date(rangeTo).getTime() / 1000
    try {
      const { deleted_count } = await snapshotService.deleteRange(channelId, fromTs, toTs)
      toast.success(`已删除 ${deleted_count} 条`)
      setItems([])
      setCursor(null)
      setHasMore(true)
      void loadFirstPage()
      void loadChannels()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function handleClear() {
    if (!clearTarget) return
    try {
      await snapshotService.clearAll(clearTarget.id)
      toast.success('已清空')
      if (clearTarget.id === channelId) {
        setItems([])
        setCursor(null)
        setHasMore(true)
      }
      void loadChannels()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清空失败')
    } finally {
      setClearTarget(null)
    }
  }

  async function handleSaveSettings(target: ChannelRow, patch: ChannelSettingsPatch) {
    try {
      const result = await aiChannelService.update(target.id, { snapshot: patch })
      toast.success(result.applied_via === 'restart' ? '已保存（通道已重启）' : '已保存并即时生效')
      void loadChannels()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  async function handleToggleArchive(target: ChannelRow, enabled: boolean) {
    if (!target.overview || toggleInFlight.current.has(target.id)) return
    toggleInFlight.current.add(target.id)
    setTogglingIds(new Set(toggleInFlight.current))
    ++archiveRevision.current
    try {
      await aiChannelService.update(target.id, { snapshot: { enabled } })
      ++archiveRevision.current
      setChannels(previous => previous.map(c => c.id === target.id && c.overview
        ? { ...c, overview: { ...c.overview, enabled } } : c))
      toast.success(enabled ? '已开启归档，即时生效' : '已关闭归档，已接收任务收尾保存；实时识别继续运行')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '切换归档失败，请重试')
    } finally {
      toggleInFlight.current.delete(target.id)
      setTogglingIds(new Set(toggleInFlight.current))
    }
  }

  const groups = groupSnapshotsByFrame(items)
  const canDeleteRange = rangeFrom !== '' && rangeTo !== ''
  const rangeFromDate = parseDatetimeLocalValue(rangeFrom)
  const rangeToDate = parseDatetimeLocalValue(rangeTo)
  const rangeDisplay = rangeFromDate && rangeToDate
    ? `${formatRangeShort(rangeFromDate)} → ${formatRangeShort(rangeToDate)}`
    : '选择时间范围'
  const totalCount = channels.reduce((sum, c) => sum + (c.overview?.count ?? 0), 0)
  const totalBytes = channels.reduce((sum, c) => sum + (c.overview?.storage_bytes ?? 0), 0)
  const totalsUnavailable = channelsLoading || channels.some(c => !c.overview || !c.overview.connected)
  const diskUsedPercent = health?.disk_total_bytes
    ? ((health.disk_total_bytes - (health.disk_free_bytes ?? 0)) / health.disk_total_bytes) * 100
    : 0
  const selectedPercent = percentOf(selected?.overview?.count, selected?.overview?.max_count)
  const selectedUnavailable = selected?.overview?.reason ? HISTORY_UNAVAILABLE_COPY[selected.overview.reason] : undefined

  return (
    <section aria-labelledby="recognition-history-title" className="flex h-full min-h-0 flex-col gap-4 md:flex-row">
      <aside className="flex max-h-64 shrink-0 flex-col rounded-panel border border-line bg-surface md:max-h-none md:w-60 xl:w-64">
        <div className="border-b border-line p-3">
          <h1 id="recognition-history-title" className="page-title">识别历史</h1>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-bold text-ink">{totalsUnavailable ? '—' : totalCount.toLocaleString()}</span>
            <span className="text-xs text-ink-faint">{totalsUnavailable ? '统计暂不可用' : `条 · 占用 ${formatBytes(totalBytes)}`}</span>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-ink-faint">
              <span>磁盘剩余</span>
              <span className="font-medium text-ink-subtle">
                {formatBytes(health?.disk_free_bytes)} / {formatBytes(health?.disk_total_bytes)}
              </span>
            </div>
            <UsageBar percent={diskUsedPercent} className="mt-1" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {channelsLoading ? (
            <p className="p-2 text-xs text-ink-faint">加载中…</p>
          ) : channels.length === 0 ? (
            <p className="p-2 text-xs text-ink-faint">还没有配置任何 AI 通道</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {channels.map((c) => {
                const active = c.id === channelId
                const enabled = c.overview?.enabled ?? false
                const connected = c.overview?.connected ?? false
                const unavailable = c.overview?.reason ? HISTORY_UNAVAILABLE_COPY[c.overview.reason] : undefined
                const pct = percentOf(c.overview?.count, c.overview?.max_count)
                // Capture state and history availability are independent.
                return (
                  <li key={c.id} className="group flex items-stretch gap-0.5">
                    <button
                      type="button"
                      onClick={() => navigate(`/recognition-history/${c.id}`)}
                      className={[
                        'flex min-w-0 flex-1 flex-col gap-1.5 rounded-base px-2.5 py-2 text-left text-sm transition-colors',
                        active ? 'bg-primary-50 text-primary' : 'text-ink-subtle hover:bg-surface-page hover:text-ink',
                      ].join(' ')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 flex-1 items-center gap-1">
                          <span className="truncate">{c.name}</span>
                          {enabled && c.faceModel !== 'none' && (
                            <Sparkles size={11} className="shrink-0 text-primary" aria-label={`人脸修复已开启（${c.faceModel}）`} />
                          )}
                        </span>
                        {connected ? (
                          <span className="shrink-0 text-[11px] text-ink-faint">
                            {!enabled && <span className="mr-1">已关闭</span>}
                            {(c.overview?.count ?? 0).toLocaleString()}/{(c.overview?.max_count ?? 0).toLocaleString()}
                          </span>
                        ) : (
                          <span
                            className={[
                              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px]',
                              !enabled ? 'bg-surface-page text-ink-faint' : 'bg-amber-50 text-amber-700',
                            ].join(' ')}
                            title={unavailable?.message ?? (enabled ? c.overview?.last_error ?? '数据库连接中断，正在重试…' : undefined)}
                          >
                            {!c.overview ? '状态未知' : unavailable ? unavailable.label
                              : enabled ? '连接失败' : '已关闭'}
                          </span>
                        )}
                      </div>
                      {connected && <UsageBar percent={pct} />}
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`「${c.name}」识别历史归档`}
                      aria-checked={enabled}
                      aria-busy={togglingIds.has(c.id)}
                      disabled={!c.overview || togglingIds.has(c.id)}
                      title={enabled ? '关闭归档（保留已有历史，实时识别继续）' : '开启归档（即时生效）'}
                      onClick={() => void handleToggleArchive(c, !enabled)}
                      className={`relative my-auto h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-wait disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-line'}`}
                    >
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                    <button
                      type="button"
                      aria-label={`设置「${c.name}」识别历史`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSettingsTarget(c)
                      }}
                      className="flex shrink-0 items-center justify-center rounded-base px-1.5 text-ink-faint transition-colors hover:bg-surface-page hover:text-ink"
                      data-testid={`channel-settings-${c.id}`}
                    >
                      <Settings size={14} aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!channelId || !selected ? (
          <div className="flex h-full items-center justify-center rounded-panel border border-dashed border-line bg-surface text-sm text-ink-faint">
            选择左侧通道查看识别历史
          </div>
        ) : !selected.overview ? (
          <div role="status" className="flex h-full items-center justify-center rounded-panel border border-line bg-surface text-sm text-ink-subtle">
            归档状态暂不可用，正在重试；当前无法判断历史记录数量。
          </div>
        ) : selectedUnavailable ? (
          <div role="status" className="flex h-full items-center justify-center rounded-panel border border-line bg-surface px-6 text-center text-sm text-ink-subtle">
            「{selected.name}」{selectedUnavailable.message}
          </div>
        ) : !selected.overview?.connected ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-panel border border-dashed border-line bg-surface text-center">
            <p className="text-sm text-ink-subtle">「{selected.name}」归档{selected.overview.enabled ? '已开启' : '已关闭'}，但数据库连接中断</p>
            <p className="max-w-sm text-xs text-ink-faint">
              正在自动重连，待写截图保留重试；逐帧模式积压时识别会减速，已有历史仍保留。
              {selected.overview.last_error && <><br /><span className="font-mono">{selected.overview.last_error}</span></>}
            </p>
          </div>
        ) : (
          <>
            <div className="mb-3">
              <h2 className="text-base font-semibold text-ink">{selected.name}</h2>
              {!selected.overview.enabled && <p role="status" className="mt-2 text-sm text-ink-subtle">归档已关闭：不再截取、处理或保存新的识别截图；已接收任务收尾保存，已有历史仍可查看。实时识别和输出流继续运行。</p>}
              {selected.overview.archive_stats?.backpressured && <p role="status" className="mt-2 text-sm text-amber-700">归档处理积压，已降低本通道识别速度；已接收结果正在保存，不会按时间抽样。</p>}
              {selected.overview.archive_stats?.faults?.map((fault) => <p key={fault.stage} role="alert" className="mt-2 text-sm text-danger">
                归档异常（{fault.stage === 'capture' ? '截图' : '图像处理'}，持续 {Math.floor(fault.duration_seconds)} 秒）：{fault.stage === 'capture' ? '暂时无法获取截图' : '图像处理未能完成'}。请检查配置和日志；已接收任务仍保留，实时视频继续运行。
              </p>)}
              {selected.overview.archive_stats?.delivery && <p className="mt-2 text-xs text-ink-subtle">
                本次归档接收 {selected.overview.archive_stats.delivery.accepted} 个目标 · 已保存 {selected.overview.archive_stats.delivery.committed} · 待处理 {selected.overview.archive_stats.delivery.outstanding}
                {selected.overview.archive_stats.delivery.outstanding > 0 && ` · 最久等待 ${Math.ceil(selected.overview.archive_stats.delivery.oldest_wait_seconds)} 秒`}
              </p>}
              {!!selected.overview.archive_stats?.delivery?.quarantined && <p role="alert" className="mt-2 text-sm text-danger">有 {selected.overview.archive_stats.delivery.quarantined} 个目标处理失败，已保留在本地隔离文件，尚未写入识别历史，请检查日志。</p>}
              {!!selected.overview.archive_stats?.quarantined_bytes && !selected.overview.archive_stats?.delivery?.quarantined && <p role="alert" className="mt-2 text-sm text-danger">本地仍有隔离归档文件待处理，请检查归档日志。</p>}
              {!!selected.overview.archive_stats?.dropped_count && <p role="alert" className="mt-2 text-sm text-danger">本次运行有 {selected.overview.archive_stats.dropped_count} 个目标截图未保存，请检查归档日志。</p>}
              <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-subtle">
                <span>{(selected.overview.count ?? 0).toLocaleString()} / {(selected.overview.max_count ?? 0).toLocaleString()} 条</span>
                <span className="text-ink-faint">·</span>
                <span>{PROJECTION_MODE_LABEL[selected.projectionMode]}</span>
                {(() => {
                  const badge = FACE_MODEL_BADGE[selected.faceModel]
                  return badge ? (
                    <span
                      className="flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 font-medium text-primary"
                      data-testid="face-enhance-badge"
                      title={badge.title}
                    >
                      <Sparkles size={11} aria-hidden />{badge.label}
                    </span>
                  ) : null
                })()}
                {selected.brightnessEnabled && (
                  <span
                    className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700"
                    data-testid="brightness-badge"
                    title={`保存前做局部自适应曝光校正，目标亮度 ${selected.brightnessTarget}（人脸增强之前执行）`}
                  >
                    <Sun size={11} aria-hidden />亮度校正 {selected.brightnessTarget}
                  </span>
                )}
              </div>
              <UsageBar percent={selectedPercent} className="mt-1.5 w-56" />
            </div>

            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs text-ink-faint">时间范围</label>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  data-testid="range-trigger"
                  className="mt-1 flex items-center gap-1.5 rounded-base border border-line bg-surface px-2 py-1.5 text-sm text-ink hover:border-primary"
                >
                  <CalendarClock size={14} className="text-ink-faint" aria-hidden />
                  {rangeDisplay}
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {RANGE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={selectedPreset === preset.label}
                    onClick={() => {
                      const r = presetRange(preset)
                      applyRange(r.from, r.to, preset.label)
                    }}
                    className={[
                      'rounded-base border px-2 py-1 text-xs transition-colors',
                      selectedPreset === preset.label
                        ? 'border-primary bg-primary-50 text-primary'
                        : 'border-line text-ink-subtle hover:border-primary hover:text-primary',
                    ].join(' ')}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs text-ink-faint">置信度下限 %</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  placeholder="0"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(e.target.value)}
                  className="mt-1 w-24 rounded-base border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
                  data-testid="min-confidence-input"
                />
              </div>
              {(selectedPreset !== DEFAULT_PRESET.label || minConfidence) && (
                <button
                  type="button"
                  onClick={() => {
                    const d = presetRange(DEFAULT_PRESET)
                    applyRange(d.from, d.to, DEFAULT_PRESET.label)
                    setMinConfidence('')
                  }}
                  className="rounded-base px-2 py-2 text-xs text-ink-faint hover:text-ink"
                >
                  清除筛选
                </button>
              )}
              <button
                type="button"
                disabled={!canDeleteRange}
                onClick={() => setConfirmDeleteRange(true)}
                className="rounded-base border border-line px-3 py-2 text-sm text-danger hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 size={14} className="mr-1 inline" aria-hidden />删除此范围
              </button>
              <button
                type="button"
                onClick={() => setApiExampleOpen(true)}
                className="ml-auto rounded-base border border-line px-3 py-2 text-sm text-ink-subtle hover:border-primary hover:text-primary"
              >
                <Code2 size={14} className="mr-1 inline" aria-hidden />检测接口示例
              </button>
            </div>

            <DateTimeRangePicker
              open={pickerOpen}
              from={rangeFrom}
              to={rangeTo}
              onConfirm={(f, t) => applyRange(f, t, null)}
              onClose={() => setPickerOpen(false)}
            />

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              {groups.length === 0 && !detailLoading ? (
                <p className="mt-8 text-center text-sm text-ink-subtle">暂无识别记录</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {groups.map((group) => (
                    <SnapshotGroupCard
                      key={`${group.channel_id}-${group.frame_pts_ns}`}
                      channelId={channelId}
                      group={group}
                      onDeleteOne={setDeleteTarget}
                    />
                  ))}
                </div>
              )}
              <div ref={sentinelRef} className="h-4" />
              {detailLoading && <p className="py-4 text-center text-sm text-ink-faint">加载中…</p>}
              {!hasMore && items.length > 0 && (
                <p className="py-4 text-center text-xs text-ink-faint">已加载全部记录</p>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除这条识别记录？"
        content="删除后无法恢复。"
        confirmText="删除"
        danger
        onConfirm={() => deleteTarget && handleDeleteOne(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={confirmDeleteRange}
        title="删除这段时间范围内的全部识别记录？"
        content="删除后无法恢复。"
        confirmText="删除"
        danger
        requireText="删除"
        onConfirm={handleDeleteRange}
        onClose={() => setConfirmDeleteRange(false)}
      />

      <ConfirmDialog
        open={clearTarget != null}
        title={`清空「${clearTarget?.name ?? ''}」的识别历史？`}
        content="清空后无法恢复，已归档的识别记录和截图会全部删除。"
        confirmText="清空"
        danger
        requireText="清空"
        onConfirm={handleClear}
        onClose={() => setClearTarget(null)}
      />

      <ApiExampleDialog
        open={apiExampleOpen}
        onClose={() => setApiExampleOpen(false)}
        channelId={channelId ?? ''}
        channelName={selected?.name ?? ''}
        fromTs={rangeFrom ? new Date(rangeFrom).getTime() / 1000 : 0}
        toTs={rangeTo ? new Date(rangeTo).getTime() / 1000 : 0}
        minConfidence={(() => {
          const n = Number(minConfidence)
          return minConfidence !== '' && Number.isFinite(n) && n > 0 ? n / 100 : 0
        })()}
      />

      <ChannelSettingsDialog
        open={settingsTarget != null}
        channelName={settingsTarget?.name ?? ''}
        currentMax={settingsTarget?.overview?.max_count ?? 10000}
        currentProjectionMode={settingsTarget?.projectionMode ?? 'none'}
        currentBrightnessEnabled={settingsTarget?.brightnessEnabled ?? false}
        currentBrightnessTarget={settingsTarget?.brightnessTarget ?? 128}
        currentFaceModel={settingsTarget?.faceModel ?? 'none'}
        currentFaceBlend={settingsTarget?.faceBlend ?? 0.5}
        faceChannel={settingsTarget?.faceChannel ?? false}
        hasRecords={(settingsTarget?.overview?.count ?? 0) > 0}
        currentCount={settingsTarget?.overview?.count ?? 0}
        onSave={(patch) => settingsTarget && void handleSaveSettings(settingsTarget, patch)}
        onRequestClear={() => {
          if (settingsTarget) setClearTarget(settingsTarget)
          setSettingsTarget(null)
        }}
        onClose={() => setSettingsTarget(null)}
      />

      <Toaster />
    </section>
  )
}
