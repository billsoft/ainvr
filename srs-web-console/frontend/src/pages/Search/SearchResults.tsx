import { useEffect, useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, Play, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { SearchEvidenceImage } from './SearchEvidenceImage'
import { searchImagePath, searchService, type SearchPageResult, type SearchResult } from '@/api/searchService'
import { evidencePlaybackHref } from '@/features/playbackNavigation'
import { aiReferenceEnabled } from './aiReference'

const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-base border border-line px-3 text-sm hover:bg-primary-50 disabled:opacity-50'
const labels: Record<SearchResult['verification']['state'], string> = {
  candidate: '候选，尚未复核', queued: 'AI 参考：等待分析', running: 'AI 参考：正在分析', match: 'AI 参考：符合描述',
  mismatch: 'AI 参考：不符合描述', uncertain: 'AI 参考：无法判断', unavailable: 'AI 参考：暂不可用',
}
const reasonLabels: Record<string, string> = {
  task_unavailable: '搜索参考分析未启用或暂不可用；请到系统配置的大模型微服务保存并应用配置，仍可人工核对。',
  model_unavailable: '参考分析模型暂不可用，仍可人工核对。',
  evidence_unavailable: '复核所需证据已过期或不可用。',
  scope_denied: '当前无权读取复核所需证据。',
  input_too_long: '描述超出参考模型输入范围，可缩短描述重新搜索。',
  request_timeout: '参考分析未在限定时间内完成，不表示候选不符合。',
  temporal_evidence_required: '单张图片不足以证明这个过程，请结合前后录像。',
  ambiguous_evidence: '可见证据不足以明确判断，请结合录像核对。',
  insufficient_evidence: '可见证据不足以明确判断，请结合录像核对。',
  profile_changed: '参考分析配置已变化，可重新搜索查看新分析。',
  cancelled: '参考分析已取消。',
}
function Verification({ value, detail = false, stopped = false }: { value: SearchResult['verification']; detail?: boolean; stopped?: boolean }) {
  const interrupted = stopped && (value.state === 'queued' || value.state === 'running')
  const tone = interrupted ? 'border-line bg-surface-page text-ink-subtle' : value.state === 'match' || value.state === 'uncertain' ? 'border-amber-200 bg-amber-50 text-amber-900'
    : value.state === 'queued' || value.state === 'running' ? 'border-blue-200 bg-blue-50 text-blue-800'
    : 'border-line bg-surface-page text-ink-subtle'
  return <div className="space-y-1">
    {!detail && <span className={`inline-flex rounded-base border px-2 py-1 text-xs ${tone}`}>{interrupted ? 'AI 参考：分析已停止' : labels[value.state]}</span>}
    {detail && <>
      {value.cached && <p className="text-xs text-ink-subtle">沿用相同查询与证据的参考分析，未重复推理。</p>}
      {value.reason && reasonLabels[value.reason] && <p className="text-xs text-ink-subtle">{reasonLabels[value.reason]}</p>}
    </>}
  </div>
}
export function SearchSimilarity({ value }: { value?: number }) {
  const valid = typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1.00001
  return <p className="text-xs tabular-nums text-ink-subtle" title="图文向量的余弦相似度，不是概率或已确认匹配；仅用于辅助比较本次候选。">{valid ? `相似度 ${value.toFixed(4)}` : '相似度暂不可用'}</p>
}
const frameLabels = { match: '命中时刻', before: '较早采样', after: '较晚采样', context: '其他关键时刻' }
function stamp(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
export function SearchResults({ data, onUpdate, onMore, moreLoading, readOnlyReason, onAccessDenied }: {
  data: SearchPageResult
  onUpdate: (item: SearchResult) => void
  onMore: () => void
  moreLoading: boolean
  readOnlyReason?: string
  onAccessDenied?: (message: string) => void
}) {
  const [rankedIds, setRankedIds] = useState<string[] | null>(null)
  const ranks = new Map((rankedIds ?? []).map((id, n) => [id, n]))
  const items = rankedIds ? [...data.items].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)) : data.items
  const aiOn = aiReferenceEnabled()
  const hasReview = items.some(i => ['match', 'mismatch', 'uncertain', 'unavailable'].includes(i.verification.state))
  const gesture = useRef<{ x: number; y: number; at: number } | null>(null)
  function reorder() {
    const priority = { match: 0, uncertain: 1, candidate: 2, queued: 2, running: 2, unavailable: 3, mismatch: 4 }
    setRankedIds([...items].sort((a, b) => priority[a.verification.state] - priority[b.verification.state]).map(i => i.id))
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [frameId, setFrameId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const focus = useRef<HTMLButtonElement | null>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const panel = useRef<HTMLElement | null>(null)
  const pending = useRef(0)
  const selected = items.find(i => i.id === selectedId)
  const selectedIndex = items.findIndex(i => i.id === selectedId)
  const frame = selected?.frames.find(f => f.id === frameId) ?? selected?.frames.find(f => f.role === 'match') ?? selected?.frames[0]
  useEffect(() => {
    if (selectedId && panel.current) { panel.current.scrollTop = 0; panel.current.focus() }
  }, [selectedId])
  // A new query owns a separate panel; old feedback must never update it.
  useEffect(() => () => { pending.current++ }, [])
  function open(id: string) { focus.current = cards.current.get(id) ?? null; setSelectedId(id); setFrameId(null) }
  function close() { setSelectedId(null); setFrameId(null); setError(null); focus.current?.focus() }
  function adjacent(direction: -1 | 1) {
    const item = items[selectedIndex + direction]
    if (item) open(item.id)
  }
  async function feedback(relevant: boolean) {
    if (!selected || savingId || readOnlyReason) return
    const epoch = ++pending.current, item = selected
    setSavingId(item.id); setError(null)
    try {
      await searchService.feedback(data.search_id, item.id, relevant)
      if (pending.current === epoch) onUpdate({ ...item, feedback: relevant ? 'relevant' : 'irrelevant' })
    } catch (e) {
      if (pending.current === epoch) {
        const status = e && typeof e === 'object' && 'status' in e ? e.status : null
        if (status === 403 || status === 404 || status === 410) onAccessDenied?.(status === 403 ? '搜索证据访问权限已变化，已停止更新和反馈；请重新选择有权限的摄像头搜索。' : '本次搜索或证据已过期，已停止更新和反馈；请重新搜索。')
        else setError({ id: item.id, message: e instanceof Error ? e.message : '反馈未保存，请重试' })
      }
    }
    finally { if (pending.current === epoch) setSavingId(null) }
  }
  const coverage = data.coverage === 'sampled'
    ? '所选范围已有采样索引；采样不能证明每个瞬间均被分析。'
    : data.coverage === 'partial' ? '所选范围有未分析或缺失时段，结果可能不完整。' : '覆盖情况暂未确认，未找到不代表事件没有发生。'
  const replay = selected?.recording.state === 'available'
    ? evidencePlaybackHref(selected.recording.channel_id, selected.started_at, selected.ended_at) : null
  return <section aria-label="搜索结果" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold text-ink">已加载 {data.items.length} 条候选</h2>
        {data.coverage !== 'sampled' && <span className="rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-800">{data.coverage === 'partial' ? '部分覆盖' : '覆盖待确认'}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-subtle">{rankedIds ? '按复核状态排序' : '按图文相似度排序'}</span>
        {aiOn && hasReview && <button type="button" className={action} onClick={reorder}>按复核状态重排已加载候选</button>}
      </div>
    </div>
    <details className="text-xs text-ink-subtle">
      <summary className="flex min-h-9 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1"><span>结果说明</span><span role="status" className="rounded-full bg-surface px-2 py-1">{aiOn ? 'AI 参考分析已开启' : 'AI 参考分析已暂停'}</span></summary>
      <div className="max-w-3xl space-y-2 rounded-lg border border-line bg-surface p-3 leading-relaxed">
        <p>按图文相似度返回最多 60 条候选，不代表均符合描述。分数不是概率；第一名也可能不匹配。{data.min_similarity === undefined ? '本次不限最低相似度。' : `本次最低相似度 ${data.min_similarity.toFixed(3).replace(/0$/, '')}，低于门槛的候选不显示。`}</p>
        <p>{coverage}</p>
        <p>{aiOn ? '本次搜索仅对前 5 条候选进行 AI 参考分析；其余候选尚未复核。参考分析未标定，不是概率，不会隐藏候选或代替人工判断。' : '让大模型优先处理告警审核；请人工核对候选与录像。'}</p>
        {aiOn && hasReview && <p>复核已更新，候选顺序保持稳定。手动重排仅调整已加载候选；新加载结果追加到末尾。</p>}
      </div>
    </details>
    {!data.items.length && <div className="rounded-xl border border-line bg-surface p-6">
      <h3 className="font-medium">{data.next_cursor ? '本批候选证据已过期或不可用' : data.min_similarity === undefined ? '所选范围内暂未找到相关候选' : '所选范围内，没有候选达到当前相似度要求'}</h3>
      <p className="mt-2 text-sm text-ink-subtle">{data.next_cursor ? '可继续加载后续候选。' : '可降低最低相似度后重新搜索，扩大时间或摄像头范围，或改用更具体的外观描述。'}</p>
    </div>}
    {error && error.id !== selectedId && <div role="alert" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      第 {items.findIndex(i => i.id === error.id) + 1} 条候选的反馈未保存：{error.message}
      <button type="button" className={`${action} ml-2`} onClick={() => open(error.id)}>返回该候选重试</button>
    </div>}
    {readOnlyReason && <p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{readOnlyReason}</p>}
    <div className={selected ? 'grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]' : ''}>
      <div className={`grid min-w-0 items-start gap-3 ${selected ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3'}`}>
        {items.map((item, n) => {
          const cover = item.frames.find(f => f.role === 'match') ?? item.frames[0]!
          return <button type="button" key={item.id} aria-label={`查看第 ${n + 1} 条候选：${item.channel_name}`}
            ref={element => { if (element) cards.current.set(item.id, element); else cards.current.delete(item.id) }}
            aria-pressed={selectedId === item.id} onClick={() => open(item.id)}
            className={`group min-w-0 overflow-hidden rounded-xl border bg-surface text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${selectedId === item.id ? 'border-primary ring-1 ring-primary' : 'border-line hover:border-primary'}`}>
            <div className="relative">
              {readOnlyReason ? <div className="flex aspect-video items-center justify-center bg-surface-page p-3 text-sm text-ink-subtle">证据暂不可访问</div> : <SearchEvidenceImage bbox={item.kind === 'object' ? cover.bbox : undefined} path={searchImagePath(data.search_id, item.id, cover.id)} alt={`${item.channel_name} ${stamp(cover.captured_at)}`} className="aspect-video w-full bg-slate-950" />}
              <span className="absolute left-2 top-2 rounded bg-black/65 px-2 py-1 text-xs font-medium tabular-nums text-white">#{String(n + 1).padStart(2, '0')}</span>
              {item.feedback && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-xs text-white">{item.feedback === 'relevant' ? '已标相关' : '已标不相关'}</span>}
            </div>
            <div className="space-y-2 p-3">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink"><Camera size={14} className="shrink-0 text-ink-faint" /><span className="truncate" title={item.channel_name}>{item.channel_name}</span></p>
              <p className="text-xs tabular-nums text-ink-subtle">{stamp(cover.captured_at)}</p>
              <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line pt-2"><SearchSimilarity value={item.similarity} /><span className="text-xs text-ink-faint">{item.kind === 'scene' ? '场景候选' : '目标候选'}</span></div>
              {aiOn && <Verification value={item.verification} stopped={!!readOnlyReason} />}
            </div>
          </button>
        })}
      </div>
      {selected && frame && <aside ref={panel} tabIndex={-1} aria-label="候选详情" className="order-first min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary xl:sticky xl:top-0 xl:order-last xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain"
        onKeyDown={e => {
          if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]'))) return
          if (e.key === 'Escape') { e.stopPropagation(); close() }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); adjacent(e.key === 'ArrowLeft' ? -1 : 1) }
        }}>
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="mb-1 text-xs text-ink-subtle">候选 #{String(selectedIndex + 1).padStart(2, '0')}</p><h3 className="break-words font-semibold">{selected.channel_name}</h3>{aiOn && <div className="mt-1"><Verification value={selected.verification} stopped={!!readOnlyReason} /></div>}</div>
          <button type="button" className={`${action} shrink-0`} aria-label="关闭详情" onClick={close}><X size={18} /></button></div>
        <div className="flex items-center justify-between gap-2" aria-label="切换候选" style={{ touchAction: 'pan-y pinch-zoom' }}
          onTouchStart={e => { gesture.current = e.touches.length === 1 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, at: Date.now() } : null }}
          onTouchMove={e => { if (e.touches.length !== 1) gesture.current = null }}
          onTouchCancel={() => { gesture.current = null }}
          onTouchEnd={e => {
            const start = gesture.current; gesture.current = null
            const end = e.changedTouches[0]; if (!start || !end || e.touches.length || Date.now() - start.at > 700) return
            const dx = end.clientX - start.x, dy = end.clientY - start.y
            if (Math.abs(dx) >= 60 && Math.abs(dy) < 30) { e.preventDefault(); adjacent(dx < 0 ? 1 : -1) }
          }}>
          <button type="button" className={action} disabled={selectedIndex <= 0} onClick={() => adjacent(-1)}><ChevronLeft size={16} />上一条</button>
          <span className="text-xs text-ink-subtle">{selectedIndex + 1} / {data.items.length}</span>
          <button type="button" className={action} disabled={selectedIndex >= data.items.length - 1} onClick={() => adjacent(1)}>下一条<ChevronRight size={16} /></button>
        </div>
        {readOnlyReason ? <p className="rounded-base bg-surface-page p-4 text-sm text-ink-subtle">证据暂不可访问，请重新搜索。</p> : <SearchEvidenceImage bbox={selected.kind === 'object' ? frame.bbox : undefined} key={frame.id} path={searchImagePath(data.search_id, selected.id, frame.id)} alt={`${frameLabels[frame.role]} ${stamp(frame.captured_at)}`}
          className="aspect-video w-full overflow-hidden rounded-lg bg-slate-950" />}
        <div className="flex flex-wrap items-center justify-between gap-1"><p className="text-xs tabular-nums text-ink-subtle">{frameLabels[frame.role]} · {stamp(frame.captured_at)}</p><SearchSimilarity value={selected.similarity} /></div>
        {readOnlyReason ? null : replay ? <Link to={replay} target="_blank" rel="noopener noreferrer" className={`${action} w-full border-primary bg-primary text-white hover:bg-primary`}><Play size={17} />播放前后录像</Link>
          : <p role="status" className="rounded-base bg-surface-page p-3 text-sm text-ink-subtle">{selected.recording.state === 'pending' ? '录像状态待确认；仍可查看保存的证据图片。' : '对应录像不可用，仍可查看保存的证据图片。'}</p>}
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3"><span className="mr-auto text-xs text-ink-subtle">人工反馈</span><button type="button" className={`${action} ${selected.feedback === 'relevant' ? 'border-primary bg-primary-50 text-primary' : ''}`} disabled={!!savingId || !!readOnlyReason} aria-pressed={selected.feedback === 'relevant'} onClick={() => void feedback(true)}><ThumbsUp size={16} />相关</button>
          <button type="button" className={`${action} ${selected.feedback === 'irrelevant' ? 'border-primary bg-primary-50 text-primary' : ''}`} disabled={!!savingId || !!readOnlyReason} aria-pressed={selected.feedback === 'irrelevant'} onClick={() => void feedback(false)}><ThumbsDown size={16} />不相关</button></div>
        {savingId && <p role="status" className="text-xs text-ink-subtle">{savingId === selectedId ? '正在保存反馈…' : '正在保存另一条候选的反馈，请稍候。'}</p>}
        {error?.id === selectedId && <p role="alert" className="text-sm text-red-600">反馈未保存：{error.message}</p>}
        <div className="flex flex-wrap gap-2" aria-label="关键时刻">
          {selected.frames.map(f => <button type="button" key={f.id} aria-pressed={frame.id === f.id}
            onClick={() => setFrameId(f.id)} className={`${action} ${frame.id === f.id ? 'border-primary bg-primary-50 text-primary' : ''}`}>{frameLabels[f.role]} {new Date(f.captured_at).toLocaleTimeString('zh-CN', { hour12: false })}</button>)}
        </div>
        <details className="text-xs leading-relaxed text-ink-subtle"><summary className="min-h-11 cursor-pointer py-3">证据与操作说明</summary><div className="space-y-2 border-t border-line pt-2">
          <p>{selected.kind === 'scene' ? '匹配画面区域：整幅场景截图，未定位精确目标；请结合录像核实。' : '候选来自同一会话的目标证据；相似不代表身份一致。'} {aiOn ? 'AI 参考仅针对命中帧；' : ''}其他关键时刻是离散采样，连续过程以录像为准；不改变告警审核结论。</p>
          <p>可在上方切换区左右滑动，或用左右方向键切换候选；Esc 关闭详情。图片区域保留缩放与平移手势。</p>
          {replay && <p>在新页面播放，保留当前搜索结果。</p>}
          {aiOn && <Verification value={selected.verification} detail stopped={!!readOnlyReason} />}
        </div></details>
      </aside>}
    </div>
    {data.next_cursor && <button type="button" className={action} disabled={moreLoading || !!readOnlyReason} onClick={onMore}>{moreLoading ? '正在加载…' : '加载更多'}</button>}
  </section>
}
