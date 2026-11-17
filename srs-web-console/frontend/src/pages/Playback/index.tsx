import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import SearchPage from '@/pages/Search'
import type { SearchChannel, SearchScope } from '@/api/searchService'
import { CalendarClock, CircleAlert, PanelLeft, PanelLeftClose, Search, X } from 'lucide-react'
import { recordingService } from '@/api/recordingService'
import { Toaster } from '@/components/ui/Toaster'
import { toast } from '@/store/toast'
import { formatBytes, formatDuration } from '@/utils/format'
import { findSegmentAt, retentionLabel } from '@/utils/recording'
import type { RecorderChannel, RecorderStats, RecordingSegment } from '@/types/recording'
import { RecordingTimeline } from './RecordingTimeline'
import { RecordingPlayer, type PlayerControl, type PlayerTransport } from './RecordingPlayer'
import { ChannelScheduleDialog } from './ChannelScheduleDialog'
import { initialRange, rangeFromQuery, resolvePlayback, seiMarks, type PlaybackRange } from './model'
import { useRangeRecordings } from './useRangeRecordings'
import { useDockedColumns } from './useDockedColumns'
import { CurrentFileBar } from './CurrentFileBar'

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
  const [range, setRange] = useState<PlaybackRange>(() => rangeFromQuery(searchParams) ?? initialRange())
  // Smart search sits beside the player. It is created the first time it is opened and then only hidden,
  // so its query, results and selection survive while results are played one after another.
  const entryScope = (): SearchScope | null => channelId
    ? { channel_ids: [channelId], from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() } : null
  const [searchEntry, setSearchEntry] = useState<SearchScope | null>(null)
  const [searchMounted, setSearchMounted] = useState(false)
  // The channels to search are ticked in the channel list on the left, not in a second list inside the panel.
  const [searchChannels, setSearchChannels] = useState<SearchChannel[]>([])
  const [searchSelected, setSearchSelected] = useState<string[]>([])
  // Search hits shown on the timeline of the channel they were recorded on.
  const [hits, setHits] = useState<{ channelId: string; at: number }[]>([])
  // Three docked columns like an editor with a side assistant: channels | playback | search.
  const { hostRef, stacked, showLeft, showRight: showSearch, toggleLeft, toggleRight: toggleSearch, closeRight: closeSearch } =
    useDockedColumns({ searchRequested: searchParams.get('search') === '1' })
  // The panel is created the first time its column is shown, with the channel and window open at that moment.
  useEffect(() => {
    if (!showSearch || searchMounted) return
    setSearchEntry(entryScope()); setSearchSelected(channelId ? [channelId] : []); setSearchMounted(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSearch, searchMounted])
  const searchableIds = new Set(searchChannels.map(c => c.id))
  const catalogue = useRangeRecordings(channelId, range.from, range.to)
  const scope = `${channelId}:${range.from}:${range.to}`
  const currentScope = useRef(scope); currentScope.current = scope
  const [playing, setPlaying] = useState<{ channelId: string; segmentId: string; offsetMs: number; request: number; scope: string } | null>(null)
  const playingRef = useRef(playing); playingRef.current = playing
  const selectionRequest = useRef(0)
  const prepareAbort = useRef<AbortController | null>(null)
  const [pendingPosition, setPendingPosition] = useState<number | null>(null)
  useEffect(() => () => prepareAbort.current?.abort(), [])
  // 正在播放的段在一次 catalogue 成功刷新里缺失，可能只是 NAS（SMB）列举
  // 暂时不完整，立刻按"已删除/覆盖"处理会误杀播放、清空时间轴指针；
  // 必须连续两次独立成功刷新都确认缺失才移除。
  const missingStreakRef = useRef(0)
  const [playheadTs, setPlayheadTs] = useState<number | null>(null)
  const [cursorScope, setCursorScope] = useState<string | null>(null)
  const [playNotice, setPlayNotice] = useState('')
  const [checking, setChecking] = useState(false)
  const [retry, setRetry] = useState(0)
  const recoveredRequest = useRef<number | null>(null)
  const selectedChannel = channels.find(c => c.id === channelId) ?? null
  const rangeSegments = catalogue.segments
  const aiMarks = useMemo(() => seiMarks(rangeSegments), [rangeSegments])
  const currentSegment = playing?.scope === scope ? rangeSegments.find(s => s.id === playing.segmentId) ?? null : null
  const [previewTs, setPreviewTs] = useState<number | null>(null)
  const playbackUrl = currentSegment ? recordingService.playUrl(currentSegment.id) : null
  // Dragging: the file under the dragged pointer. Otherwise the file the player has loaded, which is where the
  // pointer is (files have seams and a click in a gap loads the nearest one, so a lookup by time would flicker).
  const playhead = cursorScope === scope ? playheadTs : null
  const pointerSegment = previewTs != null ? findSegmentAt(rangeSegments, previewTs)
    : currentSegment ?? (playhead != null ? findSegmentAt(rangeSegments, playhead) : null)
  const filteredChannels = channels.filter(c => c.name.toLowerCase().includes(search.trim().toLowerCase()))
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
    if (!channelId && channels[0]) navigate(`/playback/${channels[0].id}${searchParams.toString() ? `?${searchParams}` : ''}`, { replace: true })
  }, [channelId, channels, navigate, searchParams])
  // A link followed while this page is open (a search result on another channel or day) moves the
  // window too; the range is otherwise only read from the address once, at mount.
  const appliedQuery = useRef(`${channelId}|${searchParams.get('from')}|${searchParams.get('to')}`)
  useEffect(() => {
    const key = `${channelId}|${searchParams.get('from')}|${searchParams.get('to')}`
    if (key === appliedQuery.current) return
    appliedQuery.current = key
    const next = rangeFromQuery(searchParams)
    if (next && (next.from !== range.from || next.to !== range.to)) setRange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, searchParams])
  useEffect(() => {
    prepareAbort.current?.abort()
    setPendingPosition(null)
    ++selectionRequest.current
    setPlaying(null); setPlayheadTs(null); setCursorScope(null); setChecking(false); setPlayNotice(''); setPreviewTs(null)
  }, [scope, channelId])
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void recordingService.preparePlayback(playing.segmentId).catch(() => undefined)
    }, 30000)
    return () => window.clearInterval(timer)
  }, [playing?.segmentId])

  // The list holds channels only; the time to watch is chosen on the timeline.
  function selectChannel(id: string) {
    if (id !== channelId) navigate(`/playback/${id}`)
  }
  function removeUnavailable(id: string) {
    catalogue.remove(id)
    if (playingRef.current?.segmentId === id) setPlaying(null)
    setPlayNotice('这段录像已被删除或循环覆盖，列表和时间轴已更新，请选择其他片段。')
  }
  async function playSegment(id: string, segment: RecordingSegment, offset = 0, requestedPosition?: number) {
    if (id !== channelId || !segment.playable) return
    const target = Math.max(range.from, segment.startTs, Math.min(range.to - 1, segment.endTs - 1, segment.startTs + offset))
    prepareAbort.current?.abort()
    const controller = new AbortController()
    prepareAbort.current = controller
    const sameSegment = playingRef.current?.segmentId === segment.id && playingRef.current.scope === scope && !checking && !playNotice
    const request = ++selectionRequest.current
    const requestedScope = scope
    // Show the requested position immediately, including preflight and buffering.
    // Only this request's decoded media clock may subsequently advance it.
    setCursorScope(scope); setPlayheadTs(requestedPosition ?? target); setPendingPosition(requestedPosition ?? target)
    setChecking(true); setPlayNotice('')
    try {
      if (!sameSegment) await recordingService.preparePlayback(segment.id, controller.signal)
      if (request !== selectionRequest.current || currentScope.current !== requestedScope) return
      setPlaying({ channelId: id, segmentId: segment.id, offsetMs: target - segment.startTs, request, scope })
    } catch (error) {
      if (request !== selectionRequest.current || currentScope.current !== requestedScope) return
      const status = (error as { status?: number }).status
      setPlaying(null)
      if (status === 404 || status === 410) removeUnavailable(segment.id)
      else setPlayNotice(error instanceof Error ? error.message : '暂时无法读取录像，请重试')
      setPendingPosition(null)
      catalogue.refresh()
    } finally { if (request === selectionRequest.current && currentScope.current === requestedScope) setChecking(false) }
  }
  function seekTo(ts: number) {
    if (!channelId) return
    const target = resolvePlayback(rangeSegments, ts, range)
    if (target) void playSegment(channelId, target.segment, target.offsetMs, Math.max(range.from, Math.min(range.to - 1, ts)))
    else { prepareAbort.current?.abort(); ++selectionRequest.current; setChecking(false); setPendingPosition(null); setCursorScope(scope); setPlayheadTs(ts); setPlayNotice('所选时间范围内没有可播放录像。') }
  }
  // Opening a channel starts its recording: the first playable one in the window, where the timeline
  // pointer sits. Once per channel and window, so a refresh never restarts it and a failed start is
  // not retried in a loop; the play button starts it again at the pointer.
  // The timeline carries the same transport as the player: one play state, one speed, one pair of
  // previous/next buttons, so neither place keeps its own copy.
  const playerControl = useRef<PlayerControl | null>(null)
  const [transport, setTransport] = useState<PlayerTransport>({ playing: false, speed: 1, hasSegment: false })
  const autoStarted = useRef<string | null>(null)
  function startAtPointer() {
    if (!channelId) return
    const target = resolvePlayback(rangeSegments, playheadTs ?? range.from, range)
    if (target) void playSegment(channelId, target.segment, target.offsetMs)
    else setPlayNotice('所选时间范围内没有可播放录像。')
  }
  useEffect(() => {
    if (!channelId || catalogue.loading || catalogue.error || playing || checking) return
    if (searchParams.get('autoplay') === '1' && rangeFromQuery(searchParams)) return
    if (autoStarted.current === scope || !rangeSegments.some(s => s.playable)) return
    autoStarted.current = scope
    startAtPointer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, channelId, catalogue.loading, catalogue.error, rangeSegments, playing, checking])
  const linkedPlayback = useRef<string | null>(null)
  useEffect(() => {
    if(searchParams.get('autoplay')!=='1'||!rangeFromQuery(searchParams)||!channelId||catalogue.loading||catalogue.error)return
    if(linkedPlayback.current===scope)return
    linkedPlayback.current=scope
    autoStarted.current=scope
    const at=Number(searchParams.get('at'))
    const target=resolvePlayback(rangeSegments,Number.isFinite(at)&&at>0?at:range.from,range)
    if(target)void playSegment(channelId,target.segment,target.offsetMs)
    else setPlayNotice('所选时间范围内没有可播放录像，请检查该通道的录像配置或等待录像文件完成。')
    // The link has been followed: drop its one-shot parameters so a later window change starts normally.
    const rest = new URLSearchParams(searchParams); rest.delete('autoplay'); rest.delete('at'); setSearchParams(rest, { replace: true })
    // Only initialize a linked replay once; refresh must not interrupt manual seeking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope,channelId,catalogue.loading,catalogue.error,rangeSegments,searchParams])
  /** Plays a search result: seek in place on the open channel when its time is in the window, otherwise
   *  follow the result's own recording (channel and, if needed, a window of an hour either side). */
  function openEvidence(targetChannel: string, at: number) {
    const inRange = at >= range.from && at < range.to
    if (targetChannel === channelId && inRange) { seekTo(at); return }
    const from = inRange ? range.from : Math.max(0, at - 3_600_000)
    const to = inRange ? range.to : Math.min(Date.now(), at + 3_600_000)
    navigate(`/playback/${encodeURIComponent(targetChannel)}?${new URLSearchParams({ from: String(from), to: String(to), at: String(at), autoplay: '1' })}`)
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
    if (recoveredRequest.current === selected.request) {
      setPlayNotice('录像仍无法播放：请检查网络或浏览器解码支持，也可手动重新加载。')
      return
    }
    recoveredRequest.current = selected.request
    const target = playheadTs ?? (currentSegment ? currentSegment.startTs + selected.offsetMs : null)
    setChecking(true); setPlayNotice('正在恢复媒体会话并核对录像…')
    try {
      await recordingService.preparePlayback(selected.segmentId)
      if (selectionRequest.current !== selected.request || playingRef.current?.request !== selected.request || currentScope.current !== selected.scope) return
      setPlaying({ ...selected, offsetMs: currentSegment && target !== null
        ? Math.max(0, Math.min(currentSegment.durationMs - 1, target - currentSegment.startTs)) : selected.offsetMs })
      setRetry(value => value + 1)
      setPlayNotice('')
    } catch (error) {
      if (selectionRequest.current !== selected.request || playingRef.current?.request !== selected.request || currentScope.current !== selected.scope) return
      if ([404, 410].includes((error as { status: number }).status)) removeUnavailable(selected.segmentId)
      else setPlayNotice(error instanceof Error ? error.message : '录像存储暂不可用')
      catalogue.refresh()
    } finally {
      if (selectionRequest.current === selected.request && currentScope.current === selected.scope) setChecking(false)
    }
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
  function handleChangeRange(from: number, to: number, preset: string | null = null) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { toast.error('请选择有效的起止时间'); return }
    setRange({ from, to, preset })
  }
  function jumpToNow() { const next = initialRange(); setRange(next) }
  const isToday = true
  const poolPercent = stats && stats.poolTotalBytes > 0 ? stats.poolUsedBytes / stats.poolTotalBytes * 100 : 0

  return (
    <section
      ref={hostRef}
      aria-labelledby="playback-title"
      className={`flex h-full min-h-0 gap-4 overflow-hidden ${stacked ? 'flex-col overflow-y-auto' : 'flex-row'}`}
    >
      {/* 列表与播放器各自滚动，页面边距由统一布局提供。 */}
      <Toaster />

      {/* ============ 左栏：通道列表（只列通道；看哪个时间在下面的时间轴上选）============ */}
      {!showLeft && (
        <div className={`flex shrink-0 rounded-panel border border-line bg-surface ${stacked ? 'min-h-11 w-full items-center px-2' : 'w-11 items-start justify-center pt-2'}`}>
          <button type="button" aria-label="通道列表" aria-pressed={false} title="展开通道列表" onClick={toggleLeft}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page hover:text-primary"><PanelLeft size={18} /></button>
        </div>
      )}
      <aside hidden={!showLeft} aria-label="通道列表" className={`flex shrink-0 flex-col overflow-hidden rounded-panel border border-line bg-surface [&[hidden]]:hidden ${stacked ? 'max-h-[45vh] w-full' : 'w-64'}`}>
        {/* 头部统计 */}
        <div className="border-b border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <h1 id="playback-title" className="page-title">录像回放</h1>
            <button type="button" aria-label="收起通道列表" title="收起通道列表" onClick={toggleLeft}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page hover:text-primary"><PanelLeftClose size={18} /></button>
          </div>
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

        {showSearch && searchChannels.length > 0 && <div role="group" aria-label="搜索范围" className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs text-ink-subtle">
          <span className="mr-auto">搜索范围 {searchSelected.length} 个</span>
          <button type="button" className="min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-base border border-line px-2 hover:border-primary hover:text-primary" onClick={() => setSearchSelected(searchChannels.slice(0, 100).map(c => c.id))}>全部 AI</button>
          <button type="button" className="min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-base border border-line px-2 hover:border-primary hover:text-primary disabled:opacity-40" disabled={!searchSelected.length} onClick={() => setSearchSelected([])}>清除</button>
        </div>}

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
                const keep = retentionLabel(c.oldestSegmentTs)

                return (
                  <li key={c.id}>
                    {/* 通道行 */}
                    <div className="flex items-center">
                    {showSearch && searchableIds.has(c.id) && <label className="flex min-h-11 min-w-9 shrink-0 cursor-pointer items-center justify-center" title="加入智能搜索范围">
                      <input type="checkbox" aria-label={`搜索范围：${c.name}`} checked={searchSelected.includes(c.id)}
                        onChange={e => setSearchSelected(ids => e.target.checked ? ids.length < 100 ? [...new Set([...ids, c.id])] : ids : ids.filter(id => id !== c.id))} />
                    </label>}
                    <button
                      type="button"
                      onClick={() => selectChannel(c.id)}
                      className={[
                        'flex min-w-0 flex-1 items-center gap-2 rounded-base px-2 py-2 text-left text-sm transition-colors',
                        active
                          ? 'bg-primary-50 text-primary'
                          : 'text-ink-subtle hover:bg-surface-page hover:text-ink',
                      ].join(' ')}
                    >
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
                    </div>

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
      <div className={`flex min-w-0 flex-col gap-3 ${stacked ? 'flex-none' : 'min-h-0 flex-1 overflow-hidden'}`}>
        {(playNotice || checking || catalogue.loading || catalogue.error) && <div role="status" className="rounded-base border border-line bg-surface px-4 py-2 text-sm">
          {checking ? '正在加载所选位置的录像…' : catalogue.error || (catalogue.loading ? '正在加载所选时间范围…' : playNotice)}
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

        {selectedChannel && allUnplayable && (
          <div data-testid="storage-unavailable-panel" className="rounded-base border border-warning/40 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800">
            <div className="flex items-center gap-1.5 font-medium"><CircleAlert size={13} className="shrink-0" />录像暂时无法播放</div>
            <p className="mt-1">原因：{unplayableReason}</p>
            <p className="mt-1 text-amber-700/80">所选范围内 {rangeSegments.length} 段录像仍保存在存储上，存储恢复后自动可播，无需操作。</p>
          </div>
        )}
        {selectedChannel && !allUnplayable && unplayableCount > 0 && (
          <p data-testid="unplayable-segments-note" className="rounded bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800">
            {unplayableCount} 段录像所在存储暂时无法访问，时间轴上已置灰：{unplayableReason}
          </p>
        )}
        {selectedChannel && !catalogue.loading && !catalogue.error && rangeSegments.length === 0 && (
          <p role="status" className="text-xs text-ink-faint">所选时间范围内没有录像</p>
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
                  initiallyMuted={searchParams.get('autoplay')==='1'}
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
                  requestedTs={pendingPosition}
                  errorMessage={playNotice}
                  offsetMs={playing?.offsetMs ?? 0}
                  playUrl={playbackUrl ? `${playbackUrl}${playbackUrl.includes('?') ? '&' : '?'}retry=${retry}` : null}
                  seekVersion={playing?.request ?? 0}
                  downloadUrl={currentSegment ? recordingService.downloadUrl(currentSegment.id) : null}
                  isToday={isToday}
                  onJumpNow={jumpToNow}
                  playbackRange={range}
                  onTimeUpdate={ts => {
                    if (currentSegment && playing?.request === selectionRequest.current && playingRef.current?.request === playing.request && currentScope.current === scope)
                      { setPendingPosition(null); setPlayheadTs(Math.max(range.from, Math.min(range.to, ts))) }
                  }}
                  onNext={() => { if (playing?.request === selectionRequest.current) jump(1) }}
                  onSeek={seekTo}
                  onStart={rangeSegments.some(s => s.playable) ? startAtPointer : undefined}
                  controlRef={playerControl}
                  onTransport={setTransport}
                  onError={() => { void playbackFailed() }}
                  onRetry={() => { recoveredRequest.current = null; void playbackFailed() }}
                />
              </div>
            </div>

            {/* 指针所在的录像文件：时间范围、大小，并可下载 */}
            <div className="shrink-0">
              <CurrentFileBar segment={pointerSegment} pointerSet={previewTs != null || playhead != null} playingId={currentSegment?.id ?? null}
                downloadUrl={pointerSegment ? recordingService.downloadUrl(pointerSegment.id) : null} unplayableReason={unplayableReason} />
            </div>

            {/* 时间轴（含范围选择，合并为一个组件） */}
            <div className="shrink-0">
              <RecordingTimeline
                win={range}
                selectedPreset={range.preset}
                segments={rangeSegments}
                playheadTs={cursorScope === scope ? playheadTs : null}
                aiMarks={aiMarks}
                hits={hits.filter(h => h.channelId === channelId).map(h => h.at)}
                onPreview={setPreviewTs}
                drops={catalogue.drops}
                onSeek={seekTo}
                transport={{
                  ...transport,
                  canStart: rangeSegments.some(s => s.playable),
                  onToggle: () => { if (transport.hasSegment) playerControl.current?.toggle(); else startAtPointer() },
                  onSpeed: speed => playerControl.current?.setSpeed(speed),
                  onPrev: () => jump(-1),
                  onNext: () => jump(1),
                }}
                onChangeRange={handleChangeRange}
              />
            </div>
          </>
        )}
      </div>

      {/* ============ 右栏：智能搜索（结果在中间播放器里播放）============ */}
      {!showSearch && (
        <div className={`flex shrink-0 rounded-panel border border-line bg-surface ${stacked ? 'min-h-11 w-full items-center px-2' : 'w-11 items-start justify-center pt-2'}`}>
          <button type="button" aria-label="智能搜索" aria-pressed={false} title="展开智能搜索" onClick={toggleSearch}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page hover:text-primary"><Search size={18} /></button>
        </div>
      )}
      {searchMounted && (
        <aside aria-label="智能搜索" hidden={!showSearch}
          className={`flex shrink-0 flex-col overflow-hidden rounded-panel border border-line bg-surface p-3 [&[hidden]]:hidden ${stacked ? 'max-h-[60vh] w-full' : 'w-80'}`}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold text-ink">智能搜索</h2>
            <button type="button" aria-label="收起智能搜索" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base hover:bg-surface-page" onClick={closeSearch}><X size={18} /></button>
          </div>
          <div className="min-h-0 flex-1">
            <SearchPage variant="side" entryScope={searchEntry} onPlay={openEvidence}
              selected={searchSelected} onSelectedChange={setSearchSelected} onChannels={setSearchChannels}
              listVisible={showLeft} onResults={setHits} />
          </div>
        </aside>
      )}
    </section>
  )
}
