import { useEffect, useState } from 'react'
import { searchService, type SearchChannel, type SearchCoverage, type SearchScope } from '@/api/searchService'

const labels = { sampled: '已采样索引', pending: '待处理', gap: '部分分析／缺口' }
function Intervals({ rows }: { rows: SearchCoverage['ranges'] }) {
  const [limit, setLimit] = useState(20)
  return <><ul className="space-y-1 text-xs text-ink-subtle">
    {rows.slice(0, limit).map((r, i) => <li key={`${r.from}-${r.to}-${i}`}>{new Date(r.from).toLocaleString('zh-CN', { hour12: false })} — {new Date(r.to).toLocaleString('zh-CN', { hour12: false })} · {labels[r.state]}</li>)}
  </ul>{rows.length > limit && <button type="button" className="min-h-11 text-sm text-primary" onClick={() => setLimit(n => n + 20)}>再显示 20 个区间（共 {rows.length} 个）</button>}</>
}
export function SearchCoveragePanel({ scope, channels, onDenied }: { scope: SearchScope; channels: SearchChannel[]; onDenied: (message: string) => void }) {
  const [data, setData] = useState<SearchCoverage | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setData(null)
    void searchService.coverage(scope, abort.signal).then(value => {
      if (!abort.signal.aborted) setData(value)
    }).catch(error => {
      if (abort.signal.aborted) return
      if (error?.status === 401 || error?.status === 403) onDenied('搜索范围访问权限已变化，已停止更新和反馈；请重新选择有权限的摄像头搜索。')
    }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [scope, retry, onDenied])
  return <details className="rounded-base border border-line bg-surface p-3">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">采样覆盖 · {loading ? '正在确认' : data?.state === 'sampled' ? '所选范围已采样' : data?.state === 'partial' ? '所选范围部分分析' : '所选范围尚未确认'}</summary>
    <p className="mb-3 text-xs text-ink-subtle">目标与场景分别列出已记录区间；未列出的时段尚未确认。采样不代表分析了每一瞬间，缺口不能直接判断为无录像。</p>
    {!loading && (!data || data.state === 'unknown') && <p role="status" className="text-sm text-ink-subtle">覆盖情况暂未确认；已返回的候选仍可核对。<button type="button" className="ml-2 min-h-11 text-primary" onClick={() => setRetry(n => n + 1)}>重新确认覆盖</button></p>}
    {scope.channel_ids.map(id => <section key={id} className="mt-2 border-t border-line pt-2">
      <h3 className="text-sm font-medium">{channels.find(c => c.id === id)?.name ?? '所选摄像头'}</h3>
      {(['object', 'scene'] as const).map(kind => {
        const rows = (data?.ranges ?? []).filter(r => r.channel_id === id && r.kind === kind).sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
        return <details key={kind} className="ml-2"><summary className="min-h-11 cursor-pointer py-2 text-sm">{kind === 'object' ? '目标' : '场景'} · {rows.length ? `${rows.length} 个记录区间` : '覆盖未确认'}</summary><Intervals rows={rows} /></details>
      })}
    </section>)}
  </details>
}
