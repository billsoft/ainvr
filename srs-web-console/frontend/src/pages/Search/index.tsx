import { aiReferenceEnabled } from './aiReference'
import { useEffect, useRef, useState } from 'react'
import { CalendarClock, ImagePlus, Search, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { requestBlob } from '@/api/httpClient'
import { blobToBase64, encodeReference, loadReference, referenceAccept, releaseReference, ReferenceImageError, type ReferenceCrop, type SearchReference } from '@/features/searchReference'
import { ReferenceImageStrip, ReferenceThumbnail } from './ReferenceImageStrip'
import { ReferenceCropDialog } from './ReferenceCropDialog'
import type { SearchQueryKind, SearchResult, SearchFrame } from '@/api/searchService'
import { searchImagePath } from '@/api/searchService'
import { searchEntryScope } from '@/features/searchNavigation'
import { SearchCoveragePanel } from './SearchCoveragePanel'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { toDatetimeLocalValue, parseDatetimeLocalValue, formatRangeFull, formatRangeShort, presetRange, type RangePreset } from '@/utils/timeRange'
import { newOperationId } from '@/utils/operationId'
import { searchService, type SearchStatus, type SearchPageResult, type SearchChannel } from '@/api/searchService'
import { SearchResults } from './SearchResults'
import { FaceQueryConnected } from '@/features/faces/FaceQueryConnected'

const button = 'min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-base border border-line bg-surface px-3 py-1.5 text-sm text-ink-subtle transition-colors hover:border-primary hover:text-primary disabled:opacity-50'
const searchRanges: RangePreset[] = [
  { label: '近1小时', unit: 'hour', n: 1 },
  { label: '近24小时', unit: 'hour', n: 24 },
  { label: '近7天', unit: 'day', n: 7 },
]
type LoadedPage = { cursor: string | null; ids: string[] }
const waiting = (item: SearchPageResult['items'][number]) =>
  (aiReferenceEnabled() && ['queued', 'running'].includes(item.verification.state)) || item.recording.state === 'pending'
function coverageAfter(current: SearchPageResult['coverage'], next: SearchPageResult['coverage']) {
  if (current === 'partial' || next === 'partial') return 'partial'
  return current === 'unknown' || next === 'unknown' ? 'unknown' : 'sampled'
}
export default function SearchPage() {
  const [mode, setMode] = useState<'text' | 'face'>('text')
  const [entryParams, setEntryParams] = useSearchParams()
  const [inherited] = useState(() => searchEntryScope(entryParams))
  const [inheritedVisible, setInheritedVisible] = useState(!!inherited)
  const [query, setQuery] = useState('')
  const [reference, setReference] = useState<SearchReference | null>(null)
  const [referenceError, setReferenceError] = useState('')
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [cropping, setCropping] = useState(false)
  const [dropping, setDropping] = useState(false)
  // Share of the picture against the description, only when both are given.
  const [imageWeight, setImageWeight] = useState(0.5)
  const [submittedKind, setSubmittedKind] = useState<SearchQueryKind>('text')
  const [submittedReference, setSubmittedReference] = useState<SearchReference | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const referenceEpoch = useRef(0)
  const liveReferences = useRef({ reference: null as SearchReference | null, submitted: null as SearchReference | null })
  useEffect(() => { liveReferences.current = { reference, submitted: submittedReference } }, [reference, submittedReference])
  useEffect(() => () => { releaseReference(liveReferences.current.reference); if (liveReferences.current.submitted?.url !== liveReferences.current.reference?.url) releaseReference(liveReferences.current.submitted) }, [])
  const [minimum, setMinimum] = useState('0.035')
  const validMinimum = minimum === '' || (Number.isFinite(Number(minimum)) && Number(minimum) >= 0 && Number(minimum) <= 0.1)
  const [data, setData] = useState<SearchPageResult | null>(null)
  const [submitted, setSubmitted] = useState('')
  const [submittedCriteria, setSubmittedCriteria] = useState('')
  const [searching, setSearching] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [queryError, setQueryError] = useState('')
  const [descriptionError, setDescriptionError] = useState(false)
  const descriptionInput = useRef<HTMLInputElement>(null)
  const [refreshError, setRefreshError] = useState('')
  const [evidenceNotice, setEvidenceNotice] = useState(false)
  const [accessError, setAccessError] = useState('')
  const epoch = useRef(0)
  const active = useRef<{ id: string; abort: AbortController } | null>(null)
  const loadedPages = useRef<LoadedPage[]>([])
  const currentData = useRef<SearchPageResult | null>(null)
  const staleResults = useRef(new Set<string>())
  const needsUpdate = (item: SearchPageResult['items'][number], index: number) => !staleResults.current.has(item.id) && (waiting(item) || (aiReferenceEnabled() && index < 5 && item.verification.state === 'candidate'))
  useEffect(() => { currentData.current = data }, [data])
  function stop() {
    epoch.current++
    loadedPages.current = []
    staleResults.current.clear()
    if (active.current) {
      active.current.abort.abort()
      void searchService.cancel(active.current.id).catch(() => undefined)
      active.current = null
    }
    setSearching(false); setMoreLoading(false)
  }
  useEffect(() => () => {
    epoch.current++
    if (active.current) {
      active.current.abort.abort()
      void searchService.cancel(active.current.id).catch(() => undefined)
    }
  }, [])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string[]>(inherited?.channel_ids ?? [])
  const defaultSelectionApplied = useRef(!!inherited)
  const [channels, setChannels] = useState<SearchChannel[]>([])
  const [status, setStatus] = useState<SearchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [picker, setPicker] = useState(false)
  // Which quick preset produced the current range (null = hand-picked in the dialog or inherited). Only paints the pressed state.
  const [selectedPreset, setSelectedPreset] = useState<string | null>(inherited ? null : '近24小时')
  const [range, setRange] = useState(() => {
    if (inherited) return { from: toDatetimeLocalValue(new Date(inherited.from)), to: toDatetimeLocalValue(new Date(Date.parse(inherited.to) - 1)) }
    const now = new Date()
    return { from: toDatetimeLocalValue(new Date(now.getTime() - 86400000)), to: toDatetimeLocalValue(now) }
  })
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError('')
    Promise.all([searchService.status(abort.signal), searchService.channels(abort.signal)])
      .then(([next, sources]) => {
        if (abort.signal.aborted) return
        setStatus(next); setChannels(sources.items)
        // First load without an inherited selection: all AI outputs (the page limit is 100 per search). Later reloads only prune.
        const apply = !defaultSelectionApplied.current
        defaultSelectionApplied.current = true
        setSelected(ids => apply ? sources.items.slice(0, 100).map(c => c.id) : ids.filter(id => sources.items.some(c => c.id === id)))
      })
      .catch(e => { if (!abort.signal.aborted) { setStatus(null); setError(e instanceof Error ? e.message : '读取搜索状态失败') } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [retry])
  const from = parseDatetimeLocalValue(range.from), to = parseDatetimeLocalValue(range.to)
  const visible = channels.filter(c => c.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const visibleSelectionCount = new Set([...selected, ...visible.map(c => c.id)]).size
  const currentListExceedsLimit = visibleSelectionCount > 100
  const selectionAtLimit = selected.length >= 100
  const validRange = !!from && !!to && to.getTime() >= from.getTime() && to.getTime() + 1000 - from.getTime() <= 31 * 86400000
  const kind: SearchQueryKind = reference ? (query.trim() ? 'image_text' : 'image') : 'text'
  // The description threshold is calibrated for description-to-picture scores only; picture queries do not use it.
  const minimumApplies = kind === 'text'
  const criteriaKey = JSON.stringify([query.trim(), minimumApplies ? (minimum === '' ? null : minimum) : null, [...selected].sort(), range.from, range.to,
    reference?.url ?? null, reference?.crop ?? null, kind === 'image_text' ? imageWeight : null])
  const hasClue = !!query.trim() || !!reference
  /** Keep a picture's object URL while either the composer or the shown search summary still uses it.
   * A new selection copies the reference with the same URL, so ownership is by URL, not by object. */
  function retire(old: SearchReference | null, keep: (SearchReference | null)[]) {
    if (old && !keep.some(other => other?.url === old.url)) releaseReference(old)
  }
  function replaceReference(next: SearchReference | null) {
    const old = liveReferences.current.reference
    liveReferences.current.reference = next
    setReference(next)
    if (old !== next) retire(old, [next, liveReferences.current.submitted])
  }
  async function addPicture(blob: Blob, origin: SearchReference['origin'], crop: ReferenceCrop | null = null) {
    const own = ++referenceEpoch.current
    setReferenceBusy(true); setReferenceError('')
    try {
      const next = await loadReference(blob, origin, crop)
      if (own !== referenceEpoch.current) { releaseReference(next); return }
      replaceReference(next)
      return next
    } catch (e) {
      if (own === referenceEpoch.current) setReferenceError(e instanceof ReferenceImageError ? e.message : '无法读取这张图片，请换一张 JPEG 或 PNG 图片')
    } finally { if (own === referenceEpoch.current) setReferenceBusy(false) }
  }
  function pictureFrom(items: DataTransferItemList | FileList | null | undefined): File | null {
    if (!items) return null
    for (const entry of Array.from(items as ArrayLike<DataTransferItem | File>)) {
      const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null
      if (file && file.type.startsWith('image/')) return file
    }
    return null
  }
  /** "Search with this picture" from a result: the saved evidence picture, preselecting the detected target. */
  async function useResultPicture(item: SearchResult, frame: SearchFrame) {
    if (!data) return
    const own = ++referenceEpoch.current
    setReferenceBusy(true); setReferenceError('')
    try {
      const blob = await requestBlob(searchImagePath(data.search_id, item.id, frame.id))
      if (own !== referenceEpoch.current) return
      if (!blob) throw new ReferenceImageError('这张证据图片已过期或不可访问，请重新搜索')
      const crop = item.kind === 'object' && frame.bbox ? { x: frame.bbox[0], y: frame.bbox[1], w: frame.bbox[2], h: frame.bbox[3] } : null
      const picture = blob.type === 'image/jpeg' || blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/jpeg' })
      if (await addPicture(picture, 'result', crop)) descriptionInput.current?.scrollIntoView?.({ block: 'nearest' })
    } catch (e) {
      if (own === referenceEpoch.current) { setReferenceError(e instanceof ReferenceImageError ? e.message : '无法读取这张证据图片，请重试'); setReferenceBusy(false) }
    }
  }
  async function run() {
    if ((minimumApplies && !validMinimum) || loading || error || !status?.ready || !validRange || !hasClue || referenceBusy || !selected.length || selected.length > 100) return
    let id: string
    try { id = newOperationId('uuid') }
    catch (e) {
      setQueryError(e instanceof Error ? e.message : '无法创建搜索请求，请重试')
      setDescriptionError(false)
      return
    }
    stop()
    const own = epoch.current, abort = new AbortController()
    active.current = { id, abort }
    const picture = reference, searchKind = kind
    setSearching(true); setQueryError(''); setDescriptionError(false); setRefreshError(''); setEvidenceNotice(false); setAccessError(''); setData(null); setSubmitted(query.trim()); setSubmittedCriteria(criteriaKey)
    setSubmittedKind(searchKind)
    const previousSubmitted = liveReferences.current.submitted
    liveReferences.current.submitted = picture; setSubmittedReference(picture)
    if (previousSubmitted !== picture) retire(previousSubmitted, [picture, liveReferences.current.reference])
    try {
      const scope = { channel_ids: selected, from: from!.toISOString(), to: new Date(to!.getTime() + 1000).toISOString() }
      let next: SearchPageResult
      if (picture) {
        let image: string
        try { image = await blobToBase64(await encodeReference(picture)) }
        catch (e) { throw e instanceof ReferenceImageError ? e : new ReferenceImageError('无法处理这张图片，请换一张或重新框选') }
        if (epoch.current !== own) return
        next = await searchService.imageQuery({ query: query.trim(), image, request_id: id, scope,
          ...(searchKind === 'image_text' ? { image_weight: imageWeight } : {}) }, abort.signal)
      } else next = await searchService.query({ ...(minimum === '' ? {} : { min_similarity: Math.min(1, Number(minimum)) }), query: query.trim(), request_id: id, verify: aiReferenceEnabled(),
        scope }, abort.signal)
      if (epoch.current === own) {
        loadedPages.current = [{ cursor: null, ids: next.items.map(i => i.id) }]
        setData(next); active.current = { id: next.search_id, abort }
      }
    } catch (e) {
      if (epoch.current === own && !abort.signal.aborted) {
        setQueryError(e instanceof Error ? e.message : '搜索失败，请重试'); active.current = null
        const code = e && typeof e === 'object' && 'code' in e ? e.code : null
        const invalidDescription = typeof code === 'string' && ['query_too_long', 'query_too_large', 'query_invalid_utf8', 'query_unrepresentable'].includes(code)
        setDescriptionError(invalidDescription)
        if (invalidDescription) descriptionInput.current?.focus()
        // A failed/expired HTTP response may still have opened a persisted
        // query. Do not leave its unfinished verification running unnoticed.
        void searchService.cancel(id).catch(() => undefined)
      }
    } finally { if (epoch.current === own) setSearching(false) }
  }
  async function more() {
    if (!data?.next_cursor || moreLoading) return
    const own = epoch.current, previous = data, cursor = data.next_cursor
    setMoreLoading(true); setQueryError('')
    try {
      const next = await searchService.page(previous.search_id, cursor, active.current?.abort.signal)
      if (epoch.current === own && next.search_id === previous.search_id) {
        if (!loadedPages.current.some(page => page.cursor === cursor))
          loadedPages.current.push({ cursor, ids: next.items.map(i => i.id) })
        setData(old => {
          if (!old || old.search_id !== next.search_id) return old
          const ids = new Set(old.items.map(i => i.id))
          return { ...old, next_cursor: next.next_cursor, coverage: coverageAfter(old.coverage, next.coverage), items: [...old.items, ...next.items.filter(i => !ids.has(i.id))] }
        })
      }
    } catch (e) { if (epoch.current === own) setQueryError(e instanceof Error ? e.message : '加载失败，请重试') }
    finally { if (epoch.current === own) setMoreLoading(false) }
  }
  const pendingUpdates = data?.items.some(needsUpdate) ?? false
  useEffect(() => {
    if (!data || !pendingUpdates || accessError) return
    const id = data.search_id, own = epoch.current, abort = new AbortController()
    let busy = false, pageOffset = 0
    const deadline = Date.now() + 10 * 60000
    const update = async () => {
      if (Date.now() > deadline) { clearInterval(timer); setRefreshError('部分复核或录像仍在处理中，可稍后重新搜索查看最新状态'); return }
      if (busy || document.hidden) return
      busy = true
      try {
        const pendingIds = new Set(currentData.current?.items.filter(needsUpdate).map(i => i.id))
        const pages = loadedPages.current.filter(page => page.ids.some(item => pendingIds.has(item)))
        // Poll already loaded pages, not just the first one. Bound each round
        // and rotate fairly if a future backend offers more than three pages.
        const targets = pages.length ? [...pages.slice(pageOffset % pages.length), ...pages.slice(0, pageOffset % pages.length)].slice(0, 3) : []
        pageOffset += targets.length
        for (const target of targets) {
          if (abort.signal.aborted || epoch.current !== own) return
          const next = await searchService.page(id, target.cursor, abort.signal)
          if (next.search_id !== id) throw new Error('搜索状态不匹配，请重新搜索')
          if (epoch.current !== own || abort.signal.aborted) return
          const changes = new Map(next.items.map(i => [i.id, i]))
          const unavailable = new Set(target.ids.filter(item => pendingIds.has(item) && !changes.has(item)))
          if (unavailable.size) {
            unavailable.forEach(item => staleResults.current.add(item))
            setEvidenceNotice(true)
          }
          setData(old => {
            if (!old || old.search_id !== id) return old
            // Keep card order, selection, feedback and the user's pagination
            // cursor unchanged while verification/recording become available.
            return { ...old, coverage: unavailable.size ? 'partial' : coverageAfter(old.coverage, next.coverage), items: old.items.map(i => {
              const changed = changes.get(i.id)
              if (changed) return { ...i, verification: changed.verification, recording: changed.recording }
              // Evidence disappearance does not prove that the recording is
              // missing. Keep its last known identity/state and stop polling.
              return unavailable.has(i.id) ? { ...i, verification: { state: 'unavailable' as const } } : i
            }) }
          })
        }
        if (epoch.current === own && !abort.signal.aborted) setRefreshError('')
      } catch (e) {
        if (!abort.signal.aborted && epoch.current === own) {
          const status = e && typeof e === 'object' && 'status' in e ? e.status : null
          if (status === 403 || status === 404 || status === 410) {
            clearInterval(timer)
            setAccessError(status === 403 ? '搜索证据访问权限已变化，已停止更新和反馈；请重新选择有权限的摄像头搜索。' : '本次搜索或证据已过期，已停止更新和反馈；请重新搜索。')
            setRefreshError('')
            void searchService.cancel(id).catch(() => undefined)
          } else setRefreshError(e instanceof Error ? e.message : '复核状态更新失败，可重新搜索')
        }
      } finally { busy = false }
    }
    const timer = setInterval(() => void update(), 4000)
    return () => { clearInterval(timer); abort.abort() }
  }, [data?.search_id, pendingUpdates, accessError])
  const message = loading ? '正在检查搜索服务…' : error || (status?.reason === 'disabled'
    ? '智能搜索尚未启用，请到系统配置中选择模型、采集范围与外挂存储后启用。'
    : status?.reason === 'config_pending' ? '搜索配置正在等待服务应用，请稍后重新检查。'
    : status?.reason === 'storage_unavailable'
    ? '搜索历史或索引存储暂不可用，请检查外挂存储和历史库状态。'
    : status?.reason === 'service_unavailable' ? '搜索服务暂不可用，请检查服务运行状态后重新尝试。'
    : '搜索模型与索引尚未就绪。条件可先设置，尚不能搜索录像。')
  const changedSinceSearch = !!data && criteriaKey !== submittedCriteria
  return <section aria-label="智能搜索" className="search-workspace flex h-full min-h-0 flex-col gap-4 md:flex-row">
    {mode === 'text' && <aside aria-label="搜索通道" className="flex max-h-72 shrink-0 flex-col rounded-panel border border-line bg-surface md:max-h-none md:w-56 xl:w-60">
      <div className="mb-3 border-b border-line p-3"><h1 className="page-title">智能搜索</h1><p className="mt-2 text-xs text-ink-subtle">选择 AI 输出，查找录像证据</p></div>
      <fieldset disabled={loading || !!error} className="flex min-h-0 flex-1 flex-col px-2 pb-3"
        aria-describedby={currentListExceedsLimit || selectionAtLimit ? 'search-source-limit' : undefined}>
        <legend className="mb-2 px-1 text-xs text-ink-faint">AI 输出 · 已选 {selected.length} / 100</legend>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input aria-label="查找摄像头" value={filter} onChange={e => setFilter(e.target.value)} placeholder="查找摄像头…" className="min-h-9 w-full min-w-0 rounded-base border border-line px-2 py-1.5 text-sm" />
          <button type="button" className={`${button} px-2 text-xs`} disabled={!visible.length || currentListExceedsLimit} onClick={() => setSelected(ids => {
            const next = [...new Set([...ids, ...visible.map(c => c.id)])]
            return next.length <= 100 ? next : ids
          })}>选择当前列表</button>
          <button type="button" className={`${button} px-2 text-xs`} disabled={!selected.length} onClick={() => setSelected([])}>清除选择</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {visible.map(c => <label key={c.id} className={`flex min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-base px-2.5 py-2 text-sm ${selected.includes(c.id) ? 'bg-primary-50 text-primary' : 'text-ink-subtle'} ${selectionAtLimit && !selected.includes(c.id) ? 'cursor-not-allowed text-ink-subtle' : 'cursor-pointer hover:bg-primary-50'}`}>
            <input type="checkbox" checked={selected.includes(c.id)} disabled={selectionAtLimit && !selected.includes(c.id)}
              onChange={e => setSelected(ids => e.target.checked ? ids.length < 100 ? [...new Set([...ids, c.id])] : ids : ids.filter(id => id !== c.id))} />
            <span className="min-w-0 flex-1"><span className="block break-words">{c.name}</span>{c.sampling_supported === false && <span className="block text-xs text-amber-800">全景采集待验证 · 可查历史</span>}</span></label>)}
        </div>
        {(currentListExceedsLimit || selectionAtLimit) && <p id="search-source-limit" className="mt-2 text-xs text-ink-subtle">
          {currentListExceedsLimit
            ? `全部选中当前列表后将达到 ${visibleSelectionCount} 个摄像头，单次最多 100 个；请先筛选或取消部分选择。`
            : '已选满 100 个摄像头；取消部分选择后可以添加其他摄像头。'}
        </p>}
        {loading ? <p className="text-sm text-ink-subtle">正在读取摄像头列表…</p>
          : error ? <p className="text-sm text-ink-subtle">暂时无法读取摄像头列表，请恢复服务后重新检查。</p>
          : !visible.length && <p className="text-sm text-ink-subtle">{channels.length ? '没有匹配的摄像头' : '暂无可搜索的 AI 输出通道，请先配置 AI 通道。'}</p>}
      </fieldset>
      <p className="border-t border-line p-3 text-xs leading-relaxed text-ink-faint">支持跨通道多选。修改通道或条件后，点击搜索应用。</p>
    </aside>}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <nav aria-label="搜索方式" className="flex shrink-0 gap-1 border-b border-line">
      {([['text', '画面搜索'], ['face', '以脸查找']] as const).map(([id, title]) => <button key={id} type="button" aria-pressed={mode === id} className={'min-h-11 border-b-2 px-3 text-sm ' + (mode === id ? 'border-primary text-primary' : 'border-transparent text-ink-subtle')} onClick={() => { if (mode !== id) { stop(); setPicker(false); setMode(id) } }}>{title}</button>)}
    </nav>
    {mode === 'face' ? <div className="min-h-0 overflow-y-auto"><FaceQueryConnected mode="search" /></div> : <>
    {/* Search conditions never scroll away with the results; a tall expanded panel scrolls on its own. */}
    <div aria-label="搜索条件区" className="max-h-[60vh] shrink-0 space-y-3 overflow-y-auto">
    {(!status?.ready || error) && <section role={error ? 'alert' : 'status'} className="rounded-xl border border-line bg-surface p-5">
      <h2 className="font-medium text-ink">{loading ? '正在检查搜索服务' : error ? '暂时无法读取搜索状态' : status?.reason === 'disabled' ? '智能搜索未启用' : status?.reason === 'config_pending' ? '配置等待应用' : status?.reason === 'storage_unavailable' ? '搜索存储不可用' : status?.reason === 'service_unavailable' ? '搜索服务暂不可用' : '等待搜索能力就绪'}</h2>
      <p className="mt-2 text-sm text-ink-subtle">{message}</p>
      <p className="mt-2 text-sm text-ink-subtle">当前无法完成所选范围的搜索，不能据此判断是否发生过事件。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" className={`${button} inline-flex items-center gap-2`} disabled={loading} onClick={() => setRetry(n => n + 1)}><RefreshCw size={16} />重新检查</button>
        {!loading && status && ['disabled', 'config_pending', 'model_pending', 'storage_unavailable'].includes(status.reason ?? '') && <Link to="/config-center?category=search-service" className="inline-flex min-h-11 items-center px-2 text-sm text-primary">前往搜索配置</Link>}</div>
    </section>}
    <form onSubmit={e => { e.preventDefault(); void run() }} onKeyDown={e => {
      if (e.key === 'Escape' && searching && !picker && !cropping && !e.defaultPrevented && !e.nativeEvent.isComposing) { e.preventDefault(); stop() }
    }} onPaste={e => {
      const file = pictureFrom(e.clipboardData?.items) ?? pictureFrom(e.clipboardData?.files)
      if (file) { e.preventDefault(); void addPicture(file, 'upload') }
    }} onDragOver={e => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); setDropping(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false) }}
      onDrop={e => {
        setDropping(false)
        const file = pictureFrom(e.dataTransfer?.files)
        if (file) { e.preventDefault(); void addPicture(file, 'upload') }
      }}
      className={`min-w-0 space-y-3 rounded-lg ${dropping ? 'outline-dashed outline-2 outline-offset-4 outline-primary' : ''}`} aria-label="搜索条件">
      <input ref={fileInput} type="file" accept={referenceAccept} className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="search-reference-file"
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void addPicture(file, 'upload') }} />
      {inheritedVisible && <p className="text-sm text-ink-subtle">已继承入口的摄像头与时间；无权或不可搜索的摄像头不会被选中。<button type="button" className={`${button} ml-2`} onClick={() => {
        const now = new Date(); setSelected([]); setRange({ from: toDatetimeLocalValue(new Date(now.getTime() - 86400000)), to: toDatetimeLocalValue(now) }); setInheritedVisible(false); setEntryParams({}, { replace: true })
      }}>清除继承范围</button></p>}
      <div className="flex flex-col gap-2 sm:flex-row">
      <div className="relative min-w-0 flex-1"><Search size={18} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 text-ink-faint" />
      <label className="sr-only" htmlFor="search-description">想找什么？</label>
      <input ref={descriptionInput} id="search-description" value={query} onChange={e => {
        setQuery(e.target.value)
        if (descriptionError) { setDescriptionError(false); setQueryError('') }
      }} maxLength={256} aria-invalid={descriptionError || undefined}
        aria-describedby={`search-description-hint${descriptionError ? ' search-query-error' : ''}`}
        onKeyDown={e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) e.preventDefault() }}
        placeholder={reference ? '补充描述（可选），例如：有人背着这个包' : '描述衣着、颜色或物品，也可以添加图片'} className="min-h-9 [@media(pointer:coarse)]:min-h-11 w-full min-w-0 rounded-base border border-line bg-surface pl-9 pr-3 py-1.5 text-sm text-ink outline-none transition focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/10" />
      </div>
      <div className="flex shrink-0 gap-2">
        {!reference && <button type="button" className={`${button} inline-flex items-center gap-1.5`} disabled={referenceBusy || searching} onClick={() => fileInput.current?.click()}
          aria-describedby="search-reference-hint"><ImagePlus size={16} aria-hidden="true" />{referenceBusy ? '正在读取…' : '添加图片'}</button>}
        <button type="submit" disabled={(minimumApplies && !validMinimum) || loading || !status?.ready || !validRange || !hasClue || referenceBusy || !selected.length || selected.length > 100 || searching} className="inline-flex min-h-9 [@media(pointer:coarse)]:min-h-11 items-center gap-2 rounded-base bg-primary px-4 py-1.5 text-sm text-white transition-colors hover:bg-primary/90 disabled:opacity-50"><Search size={18} />{searching ? '正在搜索…' : '搜索录像'}</button>
        {searching && <button type="button" className={button} onClick={stop}>取消搜索</button>}
      </div>
      </div>
      <span id="search-reference-hint" className="sr-only">选择一张 JPEG 或 PNG 图片，也可以直接粘贴或拖入图片</span>
      {reference && <ReferenceImageStrip reference={reference} disabled={searching || referenceBusy}
        onCrop={() => setCropping(true)} onReplace={() => fileInput.current?.click()}
        onRemove={() => { referenceEpoch.current++; setReferenceBusy(false); setReferenceError(''); replaceReference(null); descriptionInput.current?.focus() }} />}
      {referenceError && <p role="alert" className="rounded-base border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{referenceError}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <div><span className="mb-1 block text-xs text-ink-faint">时间范围</span><button type="button" aria-label="选择时间范围" className={`${button} inline-flex items-center gap-1.5 px-2`} onClick={() => setPicker(true)}><CalendarClock size={14} className="text-ink-faint" aria-hidden="true" /><span>{from && to ? `${formatRangeShort(from)} → ${formatRangeShort(to)}` : '选择时间范围'}</span></button></div>
        <div className="flex flex-wrap gap-1" aria-label="快捷时间范围">{searchRanges.map(preset => <button key={preset.label} type="button" aria-pressed={selectedPreset === preset.label} className={['min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-base border px-2 py-1 text-xs transition-colors', selectedPreset === preset.label ? 'border-primary bg-primary-50 text-primary' : 'border-line text-ink-subtle hover:border-primary hover:text-primary'].join(' ')} onClick={() => { setRange(presetRange(preset)); setSelectedPreset(preset.label) }}>{preset.label}</button>)}</div>
      <details className="group ml-auto open:basis-full open:ml-0">
        <summary className="inline-flex min-h-9 [@media(pointer:coarse)]:min-h-11 cursor-pointer items-center gap-1.5 text-xs text-ink-subtle hover:text-primary"><SlidersHorizontal size={14} aria-hidden="true" />高级选项 · {kind === 'text' ? `相似度 ${minimum === '' ? '不限' : minimum}` : kind === 'image_text' ? `侧重 ${imageWeight === 0.5 ? '均衡' : imageWeight > 0.5 ? '图片' : '文字'}` : '以图搜索'}<span className="ml-1 text-ink-faint group-open:rotate-180">⌄</span></summary>
        {kind === 'image_text' && <div className="mt-2 max-w-xl space-y-1">
          <label htmlFor="search-image-weight" className="text-sm font-medium text-ink">图片与文字的侧重</label>
          <div className="flex items-center gap-3 text-xs text-ink-subtle"><span className="shrink-0">更看重文字</span>
            <input id="search-image-weight" type="range" min="0.2" max="0.8" step="0.1" value={imageWeight} disabled={searching}
              aria-valuetext={imageWeight === 0.5 ? '均衡' : imageWeight > 0.5 ? '更看重图片' : '更看重文字'}
              onChange={e => setImageWeight(Number(Number(e.target.value).toFixed(1)))} className="h-11 min-w-32 flex-1 cursor-pointer accent-primary" />
            <span className="shrink-0">更看重图片</span>
            <button type="button" disabled={searching || imageWeight === 0.5} className={button} onClick={() => setImageWeight(0.5)}>均衡</button></div>
          <p className="text-xs text-ink-subtle">结果太杂时可调整侧重后重新搜索；文字只用于排序参考，不是必须满足的条件。</p>
        </div>}
        {kind === 'image' && <p className="mt-2 max-w-xl text-xs text-ink-subtle">以图搜索按外观相近程度排序，不设最低相似度门槛；添加文字描述后可调整图片与文字的侧重。</p>}
        {kind === 'text' && <div className="mt-2 max-w-xl space-y-1">
        <label htmlFor="search-minimum" className="text-sm font-medium text-ink">最低相似度</label>
        <div className="flex flex-wrap items-center gap-3">
          <input type="range" aria-label="拖动最低相似度" aria-describedby="search-minimum-hint" min="0" max="0.1" step="0.005" value={minimum === '' ? 0 : Number(minimum) || 0} disabled={searching}
            onChange={e => setMinimum(Number(e.target.value).toFixed(3))} className="h-11 min-w-32 flex-1 cursor-pointer accent-primary focus-visible:outline-primary" />
          <input id="search-minimum" type="number" inputMode="decimal" min="0" max="0.1" step="0.005" placeholder="不限" value={minimum} disabled={searching}
            onChange={e => setMinimum(e.target.value)} aria-invalid={!validMinimum} aria-describedby="search-minimum-hint"
            className="h-11 w-24 rounded-base border border-line bg-surface px-3 text-sm tabular-nums focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
          <button type="button" disabled={searching} className={button} onClick={() => setMinimum('')}>不限</button>
        </div>
        <p id="search-minimum-hint" className="text-xs text-ink-subtle">数值越高，结果越少；不是置信度或概率。0.035 为试用起点，可拖动或输入，点击“搜索录像”生效。</p>
        {!validMinimum && <p role="alert" className="text-xs text-red-700">请输入 0 到 0.10 之间的数值，或选择不限。</p>}
      </div>}
        <p className="mt-2 text-xs text-ink-subtle">时间与位置以所选条件为准；描述中的“昨晚”等条件不会自动生效。</p>
      </details>
      </div>


      <span id="search-description-hint" className="sr-only">描述目标外观；时间与位置以所选条件为准，描述中的时间不会自动生效。</span>
      {!data && !searching && !reference && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle"><span>试着描述</span>{['背黑色双肩包的人', '穿红色上衣的人', '白色汽车'].map(example => <button type="button" key={example} className="min-h-7 [@media(pointer:coarse)]:min-h-11 rounded-base border border-line bg-surface px-2 hover:bg-primary-50 hover:text-primary" onClick={() => { setQuery(example); descriptionInput.current?.focus() }}>{example}</button>)}</div>}
      {changedSinceSearch && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">条件已修改，点击“搜索录像”应用；下方仍是上一次搜索结果。</p>}
            {selected.length > 100 && <p role="alert" className="text-sm text-red-600">单次最多选择 100 个通道，请缩小范围。</p>}

    </form>
    </div>
    <div aria-label="搜索结果区" className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2">
    {queryError && <p id="search-query-error" role="alert" className="rounded-base border border-red-200 bg-red-50 p-3 text-sm text-red-700">{queryError}</p>}
    {refreshError && <p role="alert" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{refreshError}</p>}
    {evidenceNotice && data && <p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">部分候选证据已过期或不可访问，已停止更新这些候选；可通过已有录像链接核对，或重新搜索。</p>}
    {searching && <p role="status" className="text-sm text-ink-subtle">{submittedKind === 'text' ? `正在查找“${submitted}”的候选，可随时取消。` : submittedKind === 'image' ? '正在按参考图片查找相似候选，图片需要先经过识别，约需几秒，可随时取消。' : `正在按参考图片和“${submitted}”查找候选，可随时取消。`}</p>}
    {data && <><div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-surface-page text-xs text-ink-subtle">
      {submittedKind === 'text' || !submittedReference
        ? <p className="min-w-0 break-words"><span className="font-medium text-ink">本次描述：“{submitted}”</span><span className="ml-2">{data.scope.channel_ids.length} 个摄像头 · {formatRangeFull(new Date(data.scope.from))} — {formatRangeFull(new Date(Date.parse(data.scope.to) - 1))}</span></p>
        : <div className="flex min-w-0 items-center gap-3"><ReferenceThumbnail reference={submittedReference} className="h-12 w-12" />
          <p className="min-w-0 break-words"><span className="font-medium text-ink">本次搜索：参考图片{submittedReference.crop ? '（局部）' : ''}{submittedKind === 'image_text' ? ` ＋ “${submitted}”` : ''}</span>
            <span className="ml-2">{data.scope.channel_ids.length} 个摄像头 · {formatRangeFull(new Date(data.scope.from))} — {formatRangeFull(new Date(Date.parse(data.scope.to) - 1))}</span></p></div>}
    </div>
      <SearchCoveragePanel key={`coverage-${data.search_id}`} scope={data.scope} channels={channels} onDenied={setAccessError} />
      <SearchResults key={data.search_id} data={data} queryKind={submittedKind} moreLoading={moreLoading} readOnlyReason={accessError} onAccessDenied={setAccessError} onMore={() => void more()}
        onUseImage={searching ? undefined : (item, frame) => void useResultPicture(item, frame)} pictureBusy={referenceBusy}
        onUpdate={item => setData(old => old && old.search_id === data.search_id ? { ...old, items: old.items.map(i => i.id === item.id ? { ...i, feedback: item.feedback } : i) } : old)} /></>}
    {picker && <DateTimeRangePicker open from={range.from} to={range.to} onClose={() => setPicker(false)}
      onConfirm={(start, end) => { setRange({ from: start, to: end }); setSelectedPreset(null); setPicker(false) }}
      validateRange={(start, end) => end.getTime() + 1000 - start.getTime() > 31 * 86400000 ? '每次最多查询 31 天' : null} />}
    {cropping && reference && <ReferenceCropDialog reference={reference} onClose={() => setCropping(false)}
      onConfirm={crop => { setCropping(false); replaceReference({ ...reference, crop }) }} />}
    </div>
    </>}
    </div>
  </section>
}
