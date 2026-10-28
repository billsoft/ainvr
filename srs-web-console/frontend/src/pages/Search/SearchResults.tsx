import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Play, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AuthImage } from '@/components/common/AuthImage'
import { searchImagePath, searchService, type SearchPageResult, type SearchResult } from '@/api/searchService'
import { evidencePlaybackHref } from '@/features/playbackNavigation'

const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-base border border-line px-3 text-sm hover:bg-primary-50 disabled:opacity-50'
const labels: Record<SearchResult['verification']['state'], string> = {
  candidate: '候选，尚未复核', queued: '等待复核', running: '正在复核', match: 'AI 复核符合',
  mismatch: 'AI 复核不符合', uncertain: 'AI 无法判断', unavailable: 'AI 复核暂不可用',
}
const frameLabels = { match: '命中时刻', before: '之前', after: '之后', context: '上下文' }
function stamp(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
export function SearchResults({ data, onUpdate, onMore, moreLoading }: {
  data: SearchPageResult
  onUpdate: (item: SearchResult) => void
  onMore: () => void
  moreLoading: boolean
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [frameId, setFrameId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const focus = useRef<HTMLButtonElement | null>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const panel = useRef<HTMLElement | null>(null)
  const pending = useRef(0)
  const selected = data.items.find(i => i.id === selectedId)
  const selectedIndex = data.items.findIndex(i => i.id === selectedId)
  const frame = selected?.frames.find(f => f.id === frameId) ?? selected?.frames.find(f => f.role === 'match') ?? selected?.frames[0]
  useEffect(() => { if (selectedId) panel.current?.focus() }, [selectedId])
  // A new query owns a separate panel; old feedback must never update it.
  useEffect(() => () => { pending.current++ }, [])
  function open(id: string) { focus.current = cards.current.get(id) ?? null; setSelectedId(id); setFrameId(null) }
  function close() { setSelectedId(null); setFrameId(null); setError(null); focus.current?.focus() }
  function adjacent(direction: -1 | 1) {
    const item = data.items[selectedIndex + direction]
    if (item) open(item.id)
  }
  async function feedback(relevant: boolean) {
    if (!selected || savingId) return
    const epoch = ++pending.current, item = selected
    setSavingId(item.id); setError(null)
    try {
      await searchService.feedback(data.search_id, item.id, relevant)
      if (pending.current === epoch) onUpdate({ ...item, feedback: relevant ? 'relevant' : 'irrelevant' })
    } catch (e) { if (pending.current === epoch) setError({ id: item.id, message: e instanceof Error ? e.message : '反馈未保存，请重试' }) }
    finally { if (pending.current === epoch) setSavingId(null) }
  }
  const coverage = data.coverage === 'sampled'
    ? '所选范围已有采样索引；采样不能证明每个瞬间均被分析。'
    : data.coverage === 'partial' ? '所选范围有未分析或缺失时段，结果可能不完整。' : '覆盖情况暂未确认，未找到不代表事件没有发生。'
  const replay = selected?.recording.state === 'available'
    ? evidencePlaybackHref(selected.recording.channel_id, selected.started_at, selected.ended_at) : null
  return <section aria-label="搜索结果" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold text-ink">已加载 {data.items.length} 条候选</h2>
      <span className="text-xs text-ink-subtle">{coverage}</span>
    </div>
    {!data.items.length && <div className="rounded-xl border border-line bg-surface p-6">
      <h3 className="font-medium">{data.next_cursor ? '本批候选证据已过期或不可用' : '所选范围内暂未找到相关候选'}</h3>
      <p className="mt-2 text-sm text-ink-subtle">{data.next_cursor ? '可继续加载后续候选。' : '可扩大时间或摄像头范围，或改用更具体的外观描述。'}{coverage}</p>
    </div>}
    {error && error.id !== selectedId && <div role="alert" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      第 {data.items.findIndex(i => i.id === error.id) + 1} 条候选的反馈未保存：{error.message}
      <button type="button" className={`${action} ml-2`} onClick={() => open(error.id)}>返回该候选重试</button>
    </div>}
    <div className={selected ? 'grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]' : ''}>
      <div className={`grid items-start gap-3 ${selected ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'}`}>
        {data.items.map((item, n) => {
          const cover = item.frames.find(f => f.role === 'match') ?? item.frames[0]!
          return <button type="button" key={item.id} aria-label={`查看第 ${n + 1} 条候选：${item.channel_name}`}
            ref={element => { if (element) cards.current.set(item.id, element); else cards.current.delete(item.id) }}
            aria-pressed={selectedId === item.id} onClick={() => open(item.id)}
            className={`overflow-hidden rounded-xl border bg-surface text-left transition-colors ${selectedId === item.id ? 'border-primary ring-1 ring-primary' : 'border-line hover:border-primary'}`}>
            <AuthImage path={searchImagePath(data.search_id, item.id, cover.id)} alt={`${item.channel_name} ${stamp(cover.captured_at)}`} className="aspect-video w-full bg-black/90" objectFit="contain" />
            <div className="space-y-1 p-3">
              <p className="truncate text-sm font-medium">{item.channel_name}</p>
              <p className="text-xs text-ink-subtle">{stamp(cover.captured_at)} · {item.kind === 'scene' ? '画面区域命中' : '目标候选'}</p>
              <p className="text-xs text-ink-subtle">{labels[item.verification.state]}</p>
            </div>
          </button>
        })}
      </div>
      {selected && frame && <aside ref={panel} tabIndex={-1} aria-label="候选详情" className="order-first space-y-3 rounded-xl border border-line bg-surface p-4 lg:sticky lg:top-4 lg:order-last"
        onKeyDown={e => {
          if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]'))) return
          if (e.key === 'Escape') { e.stopPropagation(); close() }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); adjacent(e.key === 'ArrowLeft' ? -1 : 1) }
        }}>
        <div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold">{selected.channel_name}</h3><p className="mt-1 text-xs text-ink-subtle">{labels[selected.verification.state]}</p></div>
          <button type="button" className={`${action} shrink-0`} aria-label="关闭详情" onClick={close}><X size={18} /></button></div>
        <div className="flex items-center justify-between gap-2" aria-label="切换候选">
          <button type="button" className={action} disabled={selectedIndex <= 0} onClick={() => adjacent(-1)}><ChevronLeft size={16} />上一条</button>
          <span className="text-xs text-ink-subtle">{selectedIndex + 1} / {data.items.length}</span>
          <button type="button" className={action} disabled={selectedIndex >= data.items.length - 1} onClick={() => adjacent(1)}>下一条<ChevronRight size={16} /></button>
        </div>
        <AuthImage key={frame.id} path={searchImagePath(data.search_id, selected.id, frame.id)} alt={`${frameLabels[frame.role]} ${stamp(frame.captured_at)}`}
          className="h-[min(48vh,420px)] min-h-48 w-full rounded-base bg-black/90" objectFit="contain" />
        <p className="text-sm text-ink-subtle">{frameLabels[frame.role]} · {stamp(frame.captured_at)}</p>
        <div className="flex flex-wrap gap-2" aria-label="关键时刻">
          {selected.frames.map(f => <button type="button" key={f.id} aria-pressed={frame.id === f.id}
            onClick={() => setFrameId(f.id)} className={`${action} ${frame.id === f.id ? 'border-primary bg-primary-50 text-primary' : ''}`}>{frameLabels[f.role]} {new Date(f.captured_at).toLocaleTimeString('zh-CN', { hour12: false })}</button>)}
        </div>
        <p className="text-xs text-ink-subtle">{selected.kind === 'scene' ? '标示的是匹配画面区域，不代表精确目标定位。' : '候选来自同一会话的目标证据；相似不代表身份一致。'} AI 复核仅针对可见证据，不改变告警审核结论。</p>
        {replay ? <><Link to={replay} target="_blank" rel="noopener noreferrer" className={`${action} w-full border-primary bg-primary text-white hover:bg-primary`}><Play size={17} />播放前后录像</Link>
          <p className="text-xs text-ink-subtle">在新页面播放，保留当前搜索结果。</p></>
          : <p role="status" className="rounded-base bg-surface-page p-3 text-sm text-ink-subtle">{selected.recording.state === 'pending' ? '录像状态待确认；仍可查看保存的证据图片。' : '对应录像不可用，仍可查看保存的证据图片。'}</p>}
        <div className="flex gap-2"><button type="button" className={action} disabled={!!savingId} aria-pressed={selected.feedback === 'relevant'} onClick={() => void feedback(true)}><ThumbsUp size={16} />相关</button>
          <button type="button" className={action} disabled={!!savingId} aria-pressed={selected.feedback === 'irrelevant'} onClick={() => void feedback(false)}><ThumbsDown size={16} />不相关</button></div>
        {savingId && <p role="status" className="text-xs text-ink-subtle">{savingId === selectedId ? '正在保存反馈…' : '正在保存另一条候选的反馈，请稍候。'}</p>}
        {error?.id === selectedId && <p role="alert" className="text-sm text-red-600">反馈未保存：{error.message}</p>}
      </aside>}
    </div>
    {data.next_cursor && <button type="button" className={action} disabled={moreLoading} onClick={onMore}>{moreLoading ? '正在加载…' : '加载更多'}</button>}
  </section>
}
