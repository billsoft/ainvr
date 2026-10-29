import { useEffect, useState } from 'react'
import { searchCapacityService, type SearchCapacity } from '@/api/searchCapacityService'
import { formatBytes } from '@/utils/format'

export function SearchCapacityStatus() {
  const [data, setData] = useState<SearchCapacity | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setData(null)
    void searchCapacityService.read(abort.signal).then(value => { if (!abort.signal.aborted) setData(value) })
      .catch(() => { /* Usage failure never discards or blocks the configuration draft. */ })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [retry])
  const full = data && (data.samples >= data.max_samples || data.bytes >= data.max_bytes || data.coverage >= data.max_coverage)
  const rolling = data?.rolling_min_age_ms !== undefined
  return <section aria-label="搜索容量状态" className="rounded-base border border-line bg-surface-page p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">当前运行容量</h4><button type="button" className="min-h-11 rounded-base border border-line px-3" disabled={loading} onClick={() => setRetry(n => n + 1)}>刷新容量</button></div>
    {loading ? <p role="status">正在读取容量…</p> : !data ? <p role="status">容量状态暂不可用，可继续编辑并保存配置；当前数值尚未确认。</p> : <>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="text-ink-subtle">留存证据数量</dt><dd>{data.samples.toLocaleString()} / {data.max_samples.toLocaleString()} 条</dd></div>
        <div><dt className="text-ink-subtle">总证据占用</dt><dd>{formatBytes(data.bytes)} / {formatBytes(data.max_bytes)}</dd></div>
        <div><dt className="text-ink-subtle">平均每条总证据</dt><dd>{data.samples ? formatBytes(data.bytes / data.samples) : '暂无样本，尚不能估算'}</dd></div>
        <div><dt className="text-ink-subtle">覆盖记录数量</dt><dd>{data.coverage.toLocaleString()} / {data.max_coverage.toLocaleString()} 条</dd></div>
      </dl>
      {rolling && data && <p role="status" className="mt-2 text-xs text-ink-subtle">超出容量时自动淘汰最旧证据，最近 {Math.round((data.rolling_min_age_ms ?? 0) / 60000)} 分钟内的证据不会被淘汰；已淘汰 {(data.evicted_samples ?? 0).toLocaleString()} 条（{formatBytes(data.evicted_bytes ?? 0)}）。{data.oldest_retained_captured_ms ? `最早保留证据：${new Date(data.oldest_retained_captured_ms).toLocaleString('zh-CN', { hour12: false })}，更早时段的覆盖会显示为未确认。` : ''}</p>}
      {full && !rolling && <p role="status" className="mt-2 text-amber-800">已达到容量上限，新增采样可能暂停或产生覆盖缺口；已有录像不会因此删除。</p>}
      <p className="mt-2 text-xs text-ink-subtle">当前运行保留上限为 {data.retention_days} 天，是清理上限，不保证完整保存这些天。实际覆盖取决于采样与可用容量；本页未保存的参数不影响上述运行数值。</p>
    </>}
    <p className="mt-2 text-xs text-ink-subtle">总证据包含图片、向量与元数据，不含派生索引、历史库额外开销或原始录像；不能把平均总证据大小当作图片大小。</p>
  </section>
}
