import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CalendarClock, ChevronDown, ChevronRight, CircleAlert, Folder, FolderOpen, Play, Search } from 'lucide-react'
import { recordingService } from '@/api/recordingService'
import { Toaster } from '@/components/ui/Toaster'
import { toast } from '@/store/toast'
import { formatBytes, formatDuration } from '@/utils/format'
import { DAY_MS, dateKey, startOfDay, retentionLabel } from '@/utils/recording'
import type { RecorderChannel, RecorderStats, RecordingSegment } from '@/types/recording'
import { RecordingTimeline } from './RecordingTimeline'
import { RecordingPlayer } from './RecordingPlayer'
import { ChannelScheduleDialog } from './ChannelScheduleDialog'
import { initialRange, resolvePlayback, seiMarks, type PlaybackRange } from './model'
import { useRangeRecordings } from './useRangeRecordings'

function usageColor(pct: number) { return pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success' }
function storageLabel(kind?: string) { return kind === 'smb' ? 'NAS' : '本机磁盘' }

export default function PlaybackPage() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [healthState, setHealthState] = useState<'loading' | 'ok' | 'down'>('loading')
  const [storageIssue, setStorageIssue] = useState('')
  const [stats, setStats] = useState<RecorderStats | null>(null)
  const [channels, setChannels] = useState<RecorderChannel[]>([])
  const [search, setSearch] = useState('')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null)
  const [expandedDates, setExpandedDates] = useState<Record<string, Set<string>>>({})
  const [range, setRange] = useState<PlaybackRange>(initialRange)
  const catalogue = useRangeRecordings(channelId, range.from, range.to)
  const scope = `${channelId}:${range.from}:${range.to}`
  const currentScope = useRef(scope); currentScope.current = scope
  const [playing, setPlaying] = useState<{ channelId: string; segmentId: string; offsetMs: number; request: number; scope: string } | null>(null)
  const playingRef = useRef(playing); playingRef.current = playing
  const selectionRequest = useRef(0)
  // 正在播放的段在一次 catalogue 成功刷新里缺失，可能只是 NAS（SMB）列举
  // 暂时不完整，立刻按"已删除/覆盖"处理会误杀播放、清空时间轴指针；
  // 必须连续两次独立成功刷新都确认缺失才移除。
  const missingStreakRef = useRef(0)
  const [playheadTs, setPlayheadTs] = useState<number | null>(null)
  const [cursorScope, setCursorScope] = useState<string | null>(null)
  const [playNotice, setPlayNotice] = useState('')
  const [checking, setChecking] = useState(false)
  const [retry, setRetry] = useState(0)
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const selectedChannel = channels.find(c => c.id === channelId) ?? null
  const rangeSegments = catalogue.segments
  const aiMarks = useMemo(() => seiMarks(rangeSegments), [rangeSegments])
  const currentSegment = playing?.scope === scope ? rangeSegments.find(s => s.id === playing.segmentId) ?? null : null
  const playbackUrl = currentSegment ? recordingService.playUrl(currentSegment.id) : null
  const filteredChannels = channels.filter(c => c.name.toLowerCase().includes(search.trim().toLowerCase()))
  const loadedDays = useMemo(() => {
    const days: Record<string, RecordingSegment[]> = {}
    for (const segment of rangeSegments) {
      const key = `${channelId}__${dateKey(Math.max(range.from, segment.startTs))}`
      ;(days[key] ??= []).push(segment)
    }
    return days
  }, [rangeSegments, range.from, channelId])
  // 读不到的段：全部读不到时整块换成原因说明（一排点不动的灰条目会让人以为
  // "有录像却看不了"）；部分读不到时保留可播的段并说明灰色的是什么。
  const unplayableCount = rangeSegments.filter(s => !s.playable).length
  const allUnplayable = rangeSegments.length > 0 && unplayableCount === rangeSegments.length
  const otherStorage = stats ? rangeSegments.find(s => !s.playable && s.storage !== stats.poolKind) : undefined
  const unplayableReason = otherStorage && stats
    ? `这些录像保存在${storageLabel(otherStorage.storage)}上，当前录像存储已切换为${storageLabel(stats.poolKind)}，切回后即可播放`
    : storageIssue || '录像所在存储暂时无法访问'

  const loadBase = useCallback(async () => {
    try {
      const [health, st, list] = await Promise.all([recordingService.health(), recordingService.stats(), recordingService.listChannels()])
      setStats(st); setChannels(list); setHealthState(health.ok ? 'ok' : 'down')
      setStorageIssue(health.storageHealthy === false ? health.message || '录像存储不可用' : '')
    } catch { setHealthState('down') }
  }, [])
  useEffect(() => {
    void loadBase()
    const timer = window.setInterval(() => { void loadBase() }, 5000)
    return () => { window.clearInterval(timer) }
  }, [loadBase])
  useEffect(() => {
    if (searchParams.get('schedule') === '1' && healthState !== 'loading') setScheduleOpen(true)
  }, [searchParams, healthState])
  useEffect(() => {
    if (!channelId && channels[0]) navigate(`/playback/${channels[0].id}`, { replace: true })
  }, [channelId, channels, navigate])
  useEffect(() => {
    ++selectionRequest.current
    setPlaying(null); setPlayheadTs(null); setCursorScope(null); setChecking(false); setPlayNotice('')
    setExpandedChannelId(channelId ?? null); setExpandedDates({}); setVisibleCounts({})
  }, [scope, channelId])
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void recordingService.preparePlayback(playing.segmentId).catch(() => undefined)
    }, 30000)
    return () => window.clearInterval(timer)
  }, [playing?.segmentId])

  function toggleChannel(id: string) {
    if (id !== channelId) navigate(`/playback/${id}`)
    else setExpandedChannelId(value => value === id ? null : id)
  }
  function toggleDate(id: string, day: string) {
    setExpandedDates(previous => {
      const all = Object.keys(loadedDays).filter(key => key.startsWith(id + '__')).map(key => key.slice(id.length + 2))
      const days = new Set(previous[id] ?? all)
      if (days.has(day)) days.delete(day); else days.add(day)
      return { ...previous, [id]: days }
    })
  }
  function removeUnavailable(id: string) {
    catalogue.remove(id)
    if (playingRef.current?.segmentId === id) setPlaying(null)
    setPlayNotice('这段录像已被删除或循环覆盖，列表和时间轴已更新，请选择其他片段。')
  }
  async function playSegment(id: string, segment: RecordingSegment, offset = 0) {
    if (id !== channelId || !segment.playable) return
    const target = Math.max(range.from, segment.startTs, Math.min(range.to - 1, segment.endTs - 1, segment.startTs + offset))
    const request = ++selectionRequest.current
    const requestedScope = scope
    // Show the requested position immediately, including preflight and buffering.
    // Only this request's decoded media clock may subsequently advance it.
    setCursorScope(scope); setPlayheadTs(target)
    setChecking(true); setPlayNotice('')
    try {
      await recordingService.preparePlayback(segment.id)
      if (request !== selectionRequest.current || currentScope.current !== requestedScope) return
      setPlaying({ channelId: id, segmentId: segment.id, offsetMs: target - segment.startTs, request, scope })
      const key = dateKey(Math.max(range.from, segment.startTs))
      setExpandedDates(previous => ({ ...previous, [id]: new Set([...(previous[id] ?? Object.keys(loadedDays).map(k => k.split('__')[1]!)), key]) }))
      setExpandedChannelId(id)
    } catch (error) {
      if (request !== selectionRequest.current || currentScope.current !== requestedScope) return
      const status = (error as { status?: number }).status
      setPlaying(null)
      if (status === 404 || status === 410) removeUnavailable(segment.id)
      else setPlayNotice(error instanceof Error ? error.message : '暂时无法读取录像，请重试')
      catalogue.refresh()
    } finally { if (request === selectionRequest.current && currentScope.current === requestedScope) setChecking(false) }
  }
  function seekTo(ts: number) {
    if (!channelId) return
    const target = resolvePlayback(rangeSegments, ts, range)
    if (target) void playSegment(channelId, target.segment, target.offsetMs)
    else setPlayNotice('所选时间范围内没有可播放录像。')
  }
  function jump(dir: 1 | -1) {
    if (!currentSegment || !channelId) return
    const index = rangeSegments.findIndex(segment => segment.id === currentSegment.id)
    const candidates = dir === 1 ? rangeSegments.slice(index + 1) : rangeSegments.slice(0, index).reverse()
    const segment = candidates.find(item => item.playable && (dir < 0 || item.endTs > (playheadTs ?? currentSegment.endTs)))
    if (segment) void playSegment(channelId, segment, Math.max(0, (playheadTs ?? segment.startTs) - segment.startTs))
  }
  async function playbackFailed() {
    const selected = playingRef.current
    if (!selected || selected.request !== selectionRequest.current) return
    try { await recordingService.preparePlayback(selected.segmentId) }
    catch (error) {
      if (selectionRequest.current !== selected.request || playingRef.current?.request !== selected.request || currentScope.current !== selected.scope) return
      if ([404, 410].includes((error as { status: number }).status)) removeUnavailable(selected.segmentId)
      else setPlayNotice(error instanceof Error ? error.message : '录像存储暂不可用')
    }
    catalogue.refresh()
  }
  useEffect(() => {
    if (playing?.scope !== scope || !playing) { missingStreakRef.current = 0; return }
    if (currentSegment) { missingStreakRef.current = 0; return }
    if (catalogue.loading || catalogue.error) return
    missingStreakRef.current += 1
    if (missingStreakRef.current >= 2) {
      missingStreakRef.current = 0
      removeUnavailable(playing.segmentId)
    }
    // 段对象随每次刷新重建，不能把段对象本身放进依赖（否则永远判定不到缺失）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scope, currentSegment, catalogue.loading, catalogue.error])
  useEffect(() => {
    if (playing?.segmentId) Array.from(document.querySelectorAll('[data-testid]')).find(el => el.getAttribute('data-testid') === `segment-row-${playing.segmentId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [playing?.segmentId])
  function handleChangeRange(from: number, to: number, preset: string | null = null) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { toast.error('请选择有效的起止时间'); return }
    setRange({ from, to, preset })
  }
  function jumpToNow() { const next = initialRange(); setRange(next) }
  const isToday = true
  const poolPercent = stats && stats.poolTotalBytes > 0 ? stats.poolUsedBytes / stats.poolTotalBytes * 100 : 0

  return (
    <section
      aria-labelledby="playback-title"
      className="flex h-full min-h-0 flex-col gap-4 overflow-hidden md:flex-row"
    >
      {/* 列表与播放器各自滚动，页面边距由统一布局提供。 */}
      <Toaster />

      {/* ============ 左栏：通道树（内部滚动）============ */}
      <aside className="flex max-h-64 shrink-0 flex-col overflow-hidden rounded-panel border border-line bg-surface md:max-h-none md:w-64 xl:w-72">
        {/* 头部统计 */}
        <div className="border-b border-line p-3">
          <h1 id="playback-title" className="page-title">录像回放</h1>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-bold text-ink">
              {formatDuration(stats ? stats.todayDurationMs / 1000 : 0)}
            </span>
            <span className="text-xs text-ink-faint">今日</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            已写入 {formatBytes(stats?.todayBytes ?? 0)}
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-ink-faint">
              <span>存储{stats?.poolKind === 'smb' ? '（NAS）' : '（本机）'}</span>
              <span className="font-medium text-ink-subtle">
                {formatBytes(stats?.poolUsedBytes ?? 0)} / 可用 {formatBytes(stats?.poolAvailableBytes ?? 0)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-page">
              <div
                className={`h-full rounded-full transition-[width] ${usageColor(poolPercent)}`}
                style={{ width: `${Math.min(100, poolPercent)}%` }}
                role="progressbar"
                aria-valuenow={Math.round(poolPercent)}
              />
            </div>
            {!!stats?.writeDegradedChannels && (
              <div
                data-testid="storage-write-warning"
                className="mt-2 flex items-start gap-1 rounded bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800"
                title="近一小时存在未保存的录像，可能来自写入积压或停止录制。请结合时间轴标记和录像日志核对具体原因；历史缺口不代表当前仍在丢帧。"
              >
                <CircleAlert size={12} className="mt-px shrink-0" />
                <span>录像缺口 · 近 1 小时未保存约 {Math.round((stats.droppedMsLastHour ?? 0) / 1000)} 秒</span>
              </div>
            )}
          </div>
        </div>

        {/* 搜索 */}
        <div className="border-b border-line p-2">
          <div className="flex items-center gap-1.5 rounded-base bg-surface-page px-2 py-1.5">
            <Search size={13} className="text-ink-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索通道…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
          </div>
        </div>

        {/* 通道树（内部滚动） */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {healthState === 'loading' ? (
            <p className="p-3 text-xs text-ink-faint">加载中…</p>
          ) : filteredChannels.length === 0 ? (
            <p className="p-3 text-xs text-ink-faint">没有可录像的通道</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filteredChannels.map((c) => {
                const active = c.id === channelId
                const expanded = expandedChannelId === c.id
                const keep = retentionLabel(c.oldestSegmentTs)
                const chExpandedDates = expandedDates[c.id] ?? new Set(Object.keys(loadedDays).filter(key => key.startsWith(c.id + '__')).map(key => key.slice(c.id.length + 2)))

                return (
                  <li key={c.id}>
                    {/* 通道行 */}
                    <button
                      type="button"
                      onClick={() => toggleChannel(c.id)}
                      className={[
                        'flex w-full items-center gap-2 rounded-base px-2 py-2 text-left text-sm transition-colors',
                        active
                          ? 'bg-primary-50 text-primary'
                          : 'text-ink-subtle hover:bg-surface-page hover:text-ink',
                      ].join(' ')}
                    >
                      {expanded
                        ? <ChevronDown size={14} className="shrink-0 text-ink-faint" />
                        : <ChevronRight size={14} className="shrink-0 text-ink-faint" />}
                      <span
                        className={[
                          'h-2 w-2 shrink-0 rounded-full',
                          c.recording
                            ? c.sourceOnline ? 'bg-success' : 'bg-ink-faint'
                            : 'border border-line bg-surface',
                        ].join(' ')}
                        title={c.recordingDetail ?? (c.recording ? '正在录制' : '未开启录像')}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      {c.kind === 'ai' && (
                        <span className="shrink-0 rounded-full border border-primary/30 px-1 text-[10px] text-primary">AI</span>
                      )}
                      {c.recording && keep && (
                        <span className="shrink-0 text-[11px] text-ink-faint">{keep}</span>
                      )}
                    </button>

                    {/* 展开内容：日期分组 */}
                    {expanded && (
                      <div className="ml-3 mt-0.5 border-l border-line pl-2">
                        {(() => {
                          // Only dates containing files in the selected range.
                          const dayKeys = new Set<string>()
                          // 已加载的日期
                          for (const key of Object.keys(loadedDays)) {
                            if (key.startsWith(`${c.id}__`)) {
                              dayKeys.add(key.slice(c.id.length + 2))
                            }
                          }

                          const sortedDays = Array.from(dayKeys).sort().reverse()
                          if (!sortedDays.length) return <p className="p-2 text-xs text-ink-faint">{catalogue.loading ? '正在加载录像…' : catalogue.error ? '录像列表暂不可用' : '所选时间范围内没有录像'}</p>
                          if (c.id === channelId && allUnplayable) return (
                            <div data-testid="storage-unavailable-panel" className="m-1 rounded-base border border-warning/40 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800">
                              <div className="flex items-center gap-1.5 font-medium"><CircleAlert size={13} className="shrink-0" />录像暂时无法播放</div>
                              <p className="mt-1">原因：{unplayableReason}</p>
                              <p className="mt-1 text-amber-700/80">所选范围内 {rangeSegments.length} 段录像仍保存在存储上，存储恢复后自动可播，无需操作。</p>
                            </div>
                          )
                          const note = c.id === channelId && unplayableCount > 0 ? (
                            <p data-testid="unplayable-segments-note" className="mx-1 mb-1 rounded bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800">
                              {unplayableCount} 段录像所在存储暂时无法访问，已置灰：{unplayableReason}
                            </p>
                          ) : null

                          return <>{note}{sortedDays.map((dk) => {
                            const cacheKey = `${c.id}__${dk}`
                            const segs = loadedDays[cacheKey]
                            const isExpanded = chExpandedDates.has(dk)
                            const isLoading = catalogue.loading
                            const todayD = new Date(`${dk}T00:00`)
                            const diffDays = Math.round((startOfDay(Date.now()) - todayD.getTime()) / DAY_MS)
                            let label = `${todayD.getFullYear()}/${todayD.getMonth() + 1}/${todayD.getDate()}`
                            if (diffDays === 0) label = '今天'
                            else if (diffDays === 1) label = '昨天'

                            return (
                              <div key={dk} className="mb-0.5">
                                {/* 日期行 */}
                                <button
                                  type="button"
                                  onClick={() => toggleDate(c.id, dk)}
                                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-ink-subtle hover:bg-surface-page"
                                >
                                  {isExpanded
                                    ? <ChevronDown size={12} className="text-ink-faint" />
                                    : <ChevronRight size={12} className="text-ink-faint" />}
                                  {isExpanded
                                    ? <FolderOpen size={13} className="text-primary/70" />
                                    : <Folder size={13} className="text-ink-faint" />}
                                  <span className="flex-1 truncate">{label}</span>
                                  {segs ? (
                                    <span className="text-[11px] text-ink-faint">
                                      {segs.length}段
                                    </span>
                                  ) : isLoading ? (
                                    <span className="text-[11px] text-ink-faint">加载中…</span>
                                  ) : null}
                                </button>

                                {/* 分段列表 */}
                                {isExpanded && segs && (
                                  <ul className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
                                    {[...segs]
                                      .sort((a, b) => b.startTs - a.startTs)
                                      .slice(0, Math.max(visibleCounts[cacheKey] ?? 100, [...segs].sort((a, b) => b.startTs - a.startTs).findIndex(s => s.id === playing?.segmentId) + 1))
                                      .map((seg) => {
                                        const isCurrent = currentSegment?.id === seg.id
                                        return (
                                          <li key={seg.id}>
                                            <button
                                              type="button"
                                              disabled={!seg.playable}
                                              title={seg.playable ? undefined : unplayableReason}
                                              onClick={() => playSegment(c.id, seg)}
                                              data-testid={`segment-row-${seg.id}`}
                                              aria-current={isCurrent ? 'true' : undefined}
                                              className={[
                                                'flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors',
                                                isCurrent
                                                  ? 'bg-primary-50 text-primary'
                                                  : seg.playable
                                                    ? 'text-ink-subtle hover:bg-surface-page hover:text-ink'
                                                    : 'cursor-not-allowed opacity-50',
                                              ].join(' ')}
                                            >
                                              <Play
                                                size={10}
                                                className={isCurrent ? 'text-primary' : 'text-ink-faint'}
                                              />
                                              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                                {seg.startTs
                                                  ? new Date(seg.startTs).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 8)
                                                  : '--:--:--'}
                                                {' – '}
                                                {seg.endTs
                                                  ? new Date(seg.endTs).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 8)
                                                  : '--:--:--'}
                                              </span>
                                              <span className="shrink-0 text-[10px] text-ink-faint">
                                                {Math.round(seg.durationMs / 1000)}s
                                              </span>
                                            </button>
                                          </li>
                                        )
                                      })}
                                    {segs.length > (visibleCounts[cacheKey] ?? 100) && (
                                      <li className="px-2 py-1 text-center text-[11px] text-ink-faint">
                                        <button onClick={() => setVisibleCounts(prev => ({ ...prev, [cacheKey]: (prev[cacheKey] ?? 100) + 100 }))}>显示更多录像（共 {segs.length} 段）</button>
                                      </li>
                                    )}
                                  </ul>
                                )}
                              </div>
                            )
                          })}</>
                        })()}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* 底部入口：打开录像通道选择对话框（通道勾选 + 24h 时间表） */}
        <div className="border-t border-line p-2">
          <button
            onClick={() => setScheduleOpen(true)}
            className="flex w-full items-center gap-2 rounded-base px-2.5 py-2 text-sm text-ink-subtle hover:bg-surface-page hover:text-ink"
            data-testid="open-channel-schedule"
          >
            <CalendarClock size={15} />录像通道选择
          </button>
        </div>
      </aside>

      <ChannelScheduleDialog
        open={scheduleOpen}
        channels={channels}
        onClose={() => {
          setScheduleOpen(false)
          if (searchParams.has('schedule')) {
            const next = new URLSearchParams(searchParams)
            next.delete('schedule')
            setSearchParams(next, { replace: true })
          }
        }}
        onSaved={() => { void loadBase() }}
      />

      {/* ============ 右主区（播放器 + 时间轴）============ */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        {(playNotice || checking || catalogue.loading || catalogue.error) && <div role="status" className="rounded-base border border-line bg-surface px-4 py-2 text-sm">
          {checking ? '正在确认录像文件…' : catalogue.error || (catalogue.loading ? '正在加载所选时间范围…' : playNotice)}
        </div>}
        {healthState === 'down' && (
          <div
            data-testid="recorder-down-banner"
            className="flex flex-wrap items-center gap-3 rounded-panel border border-warning/40 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            <CircleAlert size={16} className="shrink-0" />
            <span className="flex-1">录像微服务不可达，录像回放暂不可用。请检查服务状态或联系管理员。</span>
          </div>
        )}

        {!selectedChannel ? (
          <div className="flex h-full items-center justify-center rounded-panel border border-dashed border-line bg-surface text-sm text-ink-faint">
            选择左侧通道查看录像回放
          </div>
        ) : (
          <>
            {/* 播放器（严格 16:9，视频非 16:9 时内部加黑边）。
                超宽矮屏（带鱼屏/窗口高度不足）下 aspect-video 的高度由宽度
                推导，若不加 max-h 约束会向下溢出，与时间轴发生视觉重叠。
                外层 flex-1+min-h-0 给定高度上限，内层 h-full 把约束传下去，
                player 自身 max-h-full：高度受限时保持盒宽、视频 object-contain
                补黑边，控制条始终留在盒内。 */}
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
              <div className="flex h-full max-h-full w-full max-w-full items-center justify-center">
                <RecordingPlayer
                  channelName={selectedChannel.name}
                  channelMeta={{
                    kind: selectedChannel.kind,
                    recording: selectedChannel.recording,
                    recordingState: selectedChannel.recordingState,
                    recordingDetail: selectedChannel.recordingDetail,
                    codec: currentSegment?.codec ?? selectedChannel.codec,
                    width: currentSegment?.width ?? selectedChannel.width,
                    height: currentSegment?.height ?? selectedChannel.height,
                    fps: currentSegment?.fps ?? selectedChannel.fps,
                    hasAudio: currentSegment?.hasAudio ?? selectedChannel.hasAudio,
                    seiPresent: currentSegment?.seiPresent,
                  }}
                  segment={currentSegment}
                  checking={checking}
                  offsetMs={playing?.offsetMs ?? 0}
                  playUrl={playbackUrl ? `${playbackUrl}${playbackUrl.includes('?') ? '&' : '?'}retry=${retry}` : null}
                  seekVersion={playing?.request ?? 0}
                  downloadUrl={currentSegment ? recordingService.downloadUrl(currentSegment.id) : null}
                  isToday={isToday}
                  onJumpNow={jumpToNow}
                  playbackRange={range}
                  onTimeUpdate={ts => {
                    if (currentSegment && playing?.request === selectionRequest.current && playingRef.current?.request === playing.request && currentScope.current === scope)
                      setPlayheadTs(Math.max(range.from, Math.min(range.to, ts)))
                  }}
                  onNext={() => { if (playing?.request === selectionRequest.current) jump(1) }}
                  onSeek={seekTo}
                  onError={() => { void playbackFailed() }}
                  onRetry={() => { setRetry(value => value + 1); void playbackFailed() }}
                />
              </div>
            </div>

            {/* 时间轴（含范围选择，合并为一个组件） */}
            <div className="shrink-0">
              <RecordingTimeline
                win={range}
                selectedPreset={range.preset}
                segments={rangeSegments}
                playheadTs={cursorScope === scope ? playheadTs : null}
                aiMarks={aiMarks}
                drops={catalogue.drops}
                onSeek={seekTo}
                onChangeRange={handleChangeRange}
              />
            </div>
          </>
        )}
      </div>


    </section>
  )
}
