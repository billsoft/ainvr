import { aiReferenceEnabled } from './aiReference'
import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Search, RefreshCw } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { searchEntryScope } from '@/features/searchNavigation'
import { SearchCoveragePanel } from './SearchCoveragePanel'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { toDatetimeLocalValue, parseDatetimeLocalValue, formatRangeFull } from '@/utils/timeRange'
import { newOperationId } from '@/utils/operationId'
import { searchService, type SearchStatus, type SearchPageResult, type SearchChannel } from '@/api/searchService'
import { SearchResults } from './SearchResults'

const button = 'min-h-11 rounded-base border border-line bg-surface px-4 text-sm hover:bg-primary-50 disabled:opacity-50'
type LoadedPage = { cursor: string | null; ids: string[] }
const waiting = (item: SearchPageResult['items'][number]) =>
  (aiReferenceEnabled() && ['queued', 'running'].includes(item.verification.state)) || item.recording.state === 'pending'
function coverageAfter(current: SearchPageResult['coverage'], next: SearchPageResult['coverage']) {
  if (current === 'partial' || next === 'partial') return 'partial'
  return current === 'unknown' || next === 'unknown' ? 'unknown' : 'sampled'
}
export default function SearchPage() {
  const [entryParams, setEntryParams] = useSearchParams()
  const [inherited] = useState(() => searchEntryScope(entryParams))
  const [inheritedVisible, setInheritedVisible] = useState(!!inherited)
  const [query, setQuery] = useState('')
  const [minimum, setMinimum] = useState('0.07')
  const validMinimum = minimum === '' || (Number.isFinite(Number(minimum)) && Number(minimum) >= 0 && Number(minimum) <= 0.2)
  const [data, setData] = useState<SearchPageResult | null>(null)
  const [submitted, setSubmitted] = useState('')
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
  const [scopeOpen, setScopeOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string[]>(inherited?.channel_ids ?? [])
  const [channels, setChannels] = useState<SearchChannel[]>([])
  const [status, setStatus] = useState<SearchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [picker, setPicker] = useState(false)
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
        setSelected(ids => ids.filter(id => sources.items.some(c => c.id === id)))
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
  async function run() {
    if (!validMinimum || loading || error || !status?.ready || !validRange || !query.trim() || !selected.length || selected.length > 100) return
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
    setSearching(true); setQueryError(''); setDescriptionError(false); setRefreshError(''); setEvidenceNotice(false); setAccessError(''); setData(null); setSubmitted(query.trim())
    try {
      const next = await searchService.query({ ...(minimum === '' ? {} : { min_similarity: Number(minimum) }), query: query.trim(), request_id: id, verify: aiReferenceEnabled(),
        scope: { channel_ids: selected, from: from!.toISOString(), to: new Date(to!.getTime() + 1000).toISOString() } }, abort.signal)
      if (epoch.current === own) {
        loadedPages.current = [{ cursor: null, ids: next.items.map(i => i.id) }]
        setData(next); setScopeOpen(false); active.current = { id: next.search_id, abort }
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
  return <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
    <header><h1 className="text-2xl font-semibold text-ink">智能搜索</h1>
      <p className="mt-1 text-sm text-ink-subtle">描述要查找的目标，结合时间与摄像头查找录像证据。</p></header>
    {(!status?.ready || error) && <section role={error ? 'alert' : 'status'} className="rounded-xl border border-line bg-surface p-5">
      <h2 className="font-medium text-ink">{loading ? '正在检查搜索服务' : error ? '暂时无法读取搜索状态' : status?.reason === 'disabled' ? '智能搜索未启用' : status?.reason === 'config_pending' ? '配置等待应用' : status?.reason === 'storage_unavailable' ? '搜索存储不可用' : status?.reason === 'service_unavailable' ? '搜索服务暂不可用' : '等待搜索能力就绪'}</h2>
      <p className="mt-2 text-sm text-ink-subtle">{message}</p>
      <p className="mt-2 text-sm text-ink-subtle">当前无法完成所选范围的搜索，不能据此判断是否发生过事件。</p>
      <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" className={`${button} inline-flex items-center gap-2`} disabled={loading} onClick={() => setRetry(n => n + 1)}><RefreshCw size={16} />重新检查</button>
        {!loading && status && ['disabled', 'config_pending', 'model_pending', 'storage_unavailable'].includes(status.reason ?? '') && <Link to="/config-center?category=search-service" className="inline-flex min-h-11 items-center px-2 text-sm text-primary">前往搜索配置</Link>}</div>
    </section>}
    <form onSubmit={e => { e.preventDefault(); void run() }} onKeyDown={e => {
      if (e.key === 'Escape' && searching && !picker && !e.defaultPrevented && !e.nativeEvent.isComposing) { e.preventDefault(); stop() }
    }} className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-4 md:p-5" aria-label="搜索条件">
      {inheritedVisible && <p className="text-sm text-ink-subtle">已继承入口的摄像头与时间；无权或不可搜索的摄像头不会被选中。<button type="button" className={`${button} ml-2`} onClick={() => {
        const now = new Date(); setSelected([]); setRange({ from: toDatetimeLocalValue(new Date(now.getTime() - 86400000)), to: toDatetimeLocalValue(now) }); setInheritedVisible(false); setEntryParams({}, { replace: true })
      }}>清除继承范围</button></p>}
      <label className="block text-sm font-medium text-ink" htmlFor="search-description">想找什么？</label>
      <input ref={descriptionInput} id="search-description" value={query} onChange={e => {
        setQuery(e.target.value)
        if (descriptionError) { setDescriptionError(false); setQueryError('') }
      }} maxLength={256} aria-invalid={descriptionError || undefined}
        aria-describedby={`search-description-hint${descriptionError ? ' search-query-error' : ''}`}
        onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault() }}
        placeholder="例如：背黑色双肩包的人" className="min-h-12 w-full min-w-0 rounded-base border border-line bg-surface px-4 text-ink" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-ink-subtle">已选 {selected.length} 个摄像头 · {from && to ? `${formatRangeFull(from)} — ${formatRangeFull(to)}` : '请选择时间范围'}</span>
        <button type="button" className={button} aria-expanded={scopeOpen} onClick={() => setScopeOpen(v => !v)}>{scopeOpen ? '收起范围' : '调整范围'}</button>
      </div>
      {scopeOpen && <><div className="flex flex-wrap items-center gap-3">
        <button type="button" className={`${button} inline-flex items-center gap-2`} onClick={() => setPicker(true)}>
          <CalendarDays size={18} />选择时间范围</button>
        <span className="text-sm text-ink-subtle">{from && to ? `${formatRangeFull(from)} — ${formatRangeFull(to)}` : '请选择时间范围'}</span>
      </div>
      <fieldset disabled={loading || !!error} className="rounded-base border border-line p-3"
        aria-describedby={currentListExceedsLimit || selectionAtLimit ? 'search-source-limit' : undefined}>
        <legend className="px-1 text-sm font-medium">摄像头 · 已选 {selected.length} / 100</legend>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input aria-label="查找摄像头" value={filter} onChange={e => setFilter(e.target.value)} placeholder="查找摄像头…" className="min-h-11 w-full min-w-0 rounded-base border border-line px-3 sm:w-auto sm:flex-1" />
          <button type="button" className={button} disabled={!visible.length || currentListExceedsLimit} onClick={() => setSelected(ids => {
            const next = [...new Set([...ids, ...visible.map(c => c.id)])]
            return next.length <= 100 ? next : ids
          })}>选择当前列表</button>
          <button type="button" className={button} disabled={!selected.length} onClick={() => setSelected([])}>清除选择</button>
        </div>
        <div className="grid max-h-52 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(c => <label key={c.id} className={`flex min-h-11 min-w-0 items-center gap-2 rounded-base px-2 ${selectionAtLimit && !selected.includes(c.id) ? 'cursor-not-allowed text-ink-subtle' : 'cursor-pointer hover:bg-primary-50'}`}>
            <input type="checkbox" checked={selected.includes(c.id)} disabled={selectionAtLimit && !selected.includes(c.id)}
              onChange={e => setSelected(ids => e.target.checked ? ids.length < 100 ? [...new Set([...ids, c.id])] : ids : ids.filter(id => id !== c.id))} />
            <span className="min-w-0 flex-1"><span className="block truncate">{c.name}</span>{c.sampling_supported === false && <span className="block text-xs text-amber-800">全景采集待验证 · 可查历史</span>}</span></label>)}
        </div>
        {(currentListExceedsLimit || selectionAtLimit) && <p id="search-source-limit" className="mt-2 text-xs text-ink-subtle">
          {currentListExceedsLimit
            ? `全部选中当前列表后将达到 ${visibleSelectionCount} 个摄像头，单次最多 100 个；请先筛选或取消部分选择。`
            : '已选满 100 个摄像头；取消部分选择后可以添加其他摄像头。'}
        </p>}
        {loading ? <p className="text-sm text-ink-subtle">正在读取摄像头列表…</p>
          : error ? <p className="text-sm text-ink-subtle">暂时无法读取摄像头列表，请恢复服务后重新检查。</p>
          : !visible.length && <p className="text-sm text-ink-subtle">{channels.length ? '没有匹配的摄像头' : '暂无可搜索的 AI 输出通道，请先配置 AI 通道。'}</p>}
      </fieldset></>}
      <div className="max-w-xl space-y-1">
        <label htmlFor="search-minimum" className="text-sm font-medium text-ink">最低相似度</label>
        <div className="flex flex-wrap items-center gap-3">
          <input type="range" aria-label="拖动最低相似度" aria-describedby="search-minimum-hint" min="0" max="0.2" step="0.005" value={minimum === '' ? 0 : Number(minimum) || 0} disabled={searching}
            onChange={e => setMinimum(Number(e.target.value).toFixed(3))} className="h-11 min-w-32 flex-1 cursor-pointer accent-primary focus-visible:outline-primary" />
          <input id="search-minimum" type="number" inputMode="decimal" min="0" max="0.2" step="0.005" placeholder="不限" value={minimum} disabled={searching}
            onChange={e => setMinimum(e.target.value)} aria-invalid={!validMinimum} aria-describedby="search-minimum-hint"
            className="h-11 w-24 rounded-base border border-line bg-surface px-3 text-sm tabular-nums focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" />
          <button type="button" disabled={searching} className={button} onClick={() => setMinimum('')}>不限</button>
        </div>
        <p id="search-minimum-hint" className="text-xs text-ink-subtle">数值越高，结果越少；不是置信度或概率。0.07 为试用起点，可拖动或输入，点击“搜索录像”生效。</p>
        {!validMinimum && <p role="alert" className="text-xs text-red-700">请输入 0 到 0.20 之间的数值，或选择不限。</p>}
      </div>
      <p id="search-description-hint" className="text-xs text-ink-subtle">时间与位置以所选条件为准；描述中的“昨晚”等条件不会自动生效。</p>
            {selected.length > 100 && <p role="alert" className="text-sm text-red-600">单次最多选择 100 个通道，请缩小范围。</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!validMinimum || loading || !status?.ready || !validRange || !query.trim() || !selected.length || selected.length > 100 || searching} className="inline-flex min-h-11 items-center gap-2 rounded-base bg-primary px-5 text-white disabled:opacity-50"><Search size={18} />{searching ? '正在搜索…' : '搜索录像'}</button>
        {searching && <button type="button" className={button} onClick={stop}>取消搜索</button>}
      </div>
    </form>

    {queryError && <p id="search-query-error" role="alert" className="rounded-base border border-red-200 bg-red-50 p-3 text-sm text-red-700">{queryError}</p>}
    {refreshError && <p role="alert" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{refreshError}</p>}
    {evidenceNotice && data && <p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">部分候选证据已过期或不可访问，已停止更新这些候选；可通过已有录像链接核对，或重新搜索。</p>}
    {searching && <p role="status" className="text-sm text-ink-subtle">正在查找“{submitted}”的候选，可随时取消。</p>}
    {data && <><p className="text-sm text-ink-subtle">本次描述：“{submitted}” · {formatRangeFull(new Date(data.scope.from))} — {formatRangeFull(new Date(Date.parse(data.scope.to) - 1))}</p>
      <SearchCoveragePanel key={`coverage-${data.search_id}`} scope={data.scope} channels={channels} onDenied={setAccessError} />
      <SearchResults key={data.search_id} data={data} moreLoading={moreLoading} readOnlyReason={accessError} onAccessDenied={setAccessError} onMore={() => void more()}
        onUpdate={item => setData(old => old && old.search_id === data.search_id ? { ...old, items: old.items.map(i => i.id === item.id ? { ...i, feedback: item.feedback } : i) } : old)} /></>}
    {picker && <DateTimeRangePicker open from={range.from} to={range.to} onClose={() => setPicker(false)}
      onConfirm={(start, end) => { setRange({ from: start, to: end }); setPicker(false) }}
      validateRange={(start, end) => end.getTime() + 1000 - start.getTime() > 31 * 86400000 ? '每次最多查询 31 天' : null} />}
  </div>
}
