import { CalendarClock, ChevronDown, Download, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { channelService } from '@/api/channelService'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { periodSlots } from '@/pages/Flow/FlowChart'
import { rangeOf, type CustomRange, type Preset } from '@/pages/Flow/flowRange'
import { toDatetimeLocalValue } from '@/utils/timeRange'
import { deltaOf, insightsOf, peakOf, sampleSource, toCsv, totalsOf, type AnalyticsData, type AnalyticsScope } from './analyticsSource'
import { DataTag } from './DataTag'
import { PlanPanel } from './plan/PlanPanel'
import { useRealZones } from './plan/useRealZones'
import { TrendChart } from './TrendChart'
import { WeekHourPanel } from './WeekHourPanel'

const presets: { id: Exclude<Preset, 'custom'>; name: string }[] = [{ id: 'today', name: '今天' }, { id: 'yesterday', name: '昨天' }, { id: '7d', name: '近 7 天' }, { id: '30d', name: '近 30 天' }]
const tabs = [{ id: 'overview', name: '总览' }, { id: 'flow', name: '客流' }, { id: 'heat', name: '热区' }, { id: 'week', name: '规律' }] as const
type Tab = typeof tabs[number]['id']
const seg = 'btn-secondary !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const colors = { in: '#16a34a', out: '#f97316' }
// 数据来源由这里统一选择；接入真实统计后换成真实来源，页面其余部分不用改。
const source = sampleSource

function validateAnalyticsRange(from: Date, to: Date) {
  const duration = to.getTime() + 1000 - from.getTime()
  if (!Number.isFinite(duration) || duration <= 0) return '请选择有效的起止时间'
  return duration > 31 * 86400000 ? '统计分析每次最多查询 31 天，请缩短时间范围' : null
}

function Delta({ current, previous, compare, label }: { current: number; previous: number | null; compare: boolean; label: string }) {
  if (!compare) return null
  const d = deltaOf(current, previous)
  if (d === null) return <span className="text-[11px] text-ink-faint">{label}无统计覆盖，不对比</span>
  return <span className={`text-[11px] ${d >= 0 ? 'text-success-700' : 'text-danger-700'}`}>较{label} {d >= 0 ? '+' : '−'}{Math.abs(d).toFixed(0)}%</span>
}
function Kpi({ label, value, unit, children }: { label: string; value: string; unit?: string; children?: React.ReactNode }) {
  return <div aria-label={label} role="group" className="ui-panel flex min-w-0 flex-col justify-center px-3 py-1.5">
    <span className="text-[11px] text-ink-subtle">{label}</span>
    <span className="flex flex-wrap items-baseline gap-x-2"><span className="text-xl font-semibold leading-7 tabular-nums text-ink">{value}{unit && <span className="ml-1 text-xs font-normal text-ink-faint">{unit}</span>}</span>{children}</span>
  </div>
}

function ChannelPicker({ channels, selected, onToggle }: { channels: { id: string; name: string }[]; selected: string[]; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return <div ref={box} className="relative">
    <button type="button" aria-haspopup="true" aria-expanded={open} className={seg} onClick={() => setOpen(v => !v)}>通道 {selected.length}/{channels.length}<ChevronDown size={14} aria-hidden="true" /></button>
    {open && <div role="group" aria-label="统计通道" className="ui-panel absolute left-0 top-full z-30 mt-1 max-h-72 w-64 space-y-0.5 overflow-auto p-1.5 shadow-lg">
      {channels.map(c => <label key={c.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-base px-2 text-sm text-ink hover:bg-surface-hover [@media(pointer:coarse)]:min-h-11">
        <input type="checkbox" checked={selected.includes(c.id)} onChange={() => onToggle(c.id)} className="h-4 w-4 accent-primary" /><span className="truncate">{c.name}</span></label>)}
      {!channels.length && <p className="p-2 text-sm text-ink-subtle">还没有通道</p>}
    </div>}
  </div>
}

/** 统计分析：做成仪表盘，横屏时总览一屏看完；放不下的详情分到标签页，不用上下翻。 */
export default function AnalyticsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (tabs.find(t => t.id === params.get('tab'))?.id ?? 'overview') as Tab
  const preset = (['today', 'yesterday', '7d', '30d'].includes(params.get('range') ?? '') ? params.get('range') : 'today') as Preset
  const [custom, setCustom] = useState<CustomRange | null>(null), [customOn, setCustomOn] = useState(false), [pickerRange, setPickerRange] = useState<{ from: string; to: string } | null>(null)
  const active: Preset = customOn && custom ? 'custom' : preset
  const [channels, setChannels] = useState<{ id: string; name: string }[] | null>(null), [selected, setSelected] = useState<string[]>([])
  const [compare, setCompare] = useState(true), [view, setView] = useState<'trend' | 'rank'>('trend'), [revision, setRevision] = useState(0)
  const [data, setData] = useState<AnalyticsData | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [updated, setUpdated] = useState<Date | null>(null)
  const latest = useRef(0)
  const setParam = (key: string, value: string, fallback: string) => setParams(old => { const next = new URLSearchParams(old); value === fallback ? next.delete(key) : next.set(key, value); return next }, { replace: true })

  useEffect(() => {
    let alive = true
    void channelService.list().then(rows => {
      if (!alive) return
      const list = rows.map(c => ({ id: c.id, name: c.name }))
      setChannels(list); setSelected(list.slice(0, 3).map(c => c.id))
    }).catch(() => { if (alive) { setChannels([]); setError('通道列表读取失败') } })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!source.refreshMs) return
    const t = setInterval(() => { if (!document.hidden) setRevision(n => n + 1) }, source.refreshMs); return () => clearInterval(t)
  }, [])

  const range = useMemo(() => rangeOf(active, new Date(), custom), [active, custom, revision])
  const scope: AnalyticsScope | null = useMemo(() => selected.length ? { channelIds: selected, from: range.from, to: range.to, bucket: range.bucket, previous: range.previous, compareLabel: range.compare } : null, [selected, range])
  const names = useMemo(() => Object.fromEntries((channels ?? []).map(c => [c.id, c.name])), [channels])

  useEffect(() => {
    if (!scope) { setData(null); return }
    const id = ++latest.current
    setLoading(true); setError('')
    void source.load(scope).then(d => { if (id === latest.current) { setData(d); setUpdated(new Date()) } })
      .catch(e => { if (id === latest.current) { setData(null); setError(e instanceof Error ? e.message : '统计读取失败') } })
      .finally(() => { if (id === latest.current) setLoading(false) })
  }, [scope])

  const zonesNow = useRealZones(range, revision)

  const toggle = (id: string) => setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id])
  const totals = data ? totalsOf(data) : null, peak = data ? peakOf(data) : null
  const slots = useMemo(() => periodSlots(range.from, range.to, range.bucket), [range])
  const exportCsv = useCallback(() => {
    if (!data) return
    const blob = new Blob([toCsv(data, names)], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = `统计分析${data.provenance === 'sample' ? '-示例' : ''}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url)
  }, [data, names])
  const rankList = data ? data.channels.map(c => ({ id: c.channelId, total: c.in.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total) : []
  const rankMax = Math.max(1, ...rankList.map(r => r.total))
  const multi = selected.length >= 2

  const trend = (mode: 'trend' | 'rank', toggleable: boolean) => data && <section aria-label="客流趋势" className="ui-panel flex min-h-[16rem] flex-col gap-1 p-3 lg:min-h-0">
    <header className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-ink">客流趋势</h2><DataTag kind="ready" />
      {toggleable && multi && <div role="group" aria-label="视图" className="ml-auto flex gap-1">{([['trend', '趋势'], ['rank', '排名']] as const).map(([id, name]) => <button key={id} type="button" aria-pressed={view === id} className={seg} onClick={() => setView(id)}>{name}</button>)}</div>}</header>
    {mode === 'trend' || !multi
      ? <TrendChart label="进入与离开趋势" bucket={range.bucket} slots={data.slots} series={(['in', 'out'] as const).map(k => ({ name: k === 'in' ? '进入' : '离开', color: colors[k], values: data.slots.map((_, i) => data.channels.reduce((n, c) => n + (c[k][i] ?? 0), 0)) }))} />
      : <ol aria-label="通道排名" className="min-h-0 flex-1 space-y-1.5 overflow-auto">{rankList.map((r, i) => <li key={r.id} className="flex items-center gap-2 text-xs"><span className="w-4 text-ink-subtle">{i + 1}</span><span className="w-28 truncate text-ink">{names[r.id] ?? r.id}</span>
        <span className="h-2.5 flex-1 rounded-full bg-surface-page"><span className="block h-2.5 rounded-full" style={{ width: `${r.total / rankMax * 100}%`, background: colors.in }} /></span><span className="w-14 text-right tabular-nums text-ink">{r.total.toLocaleString('zh-CN')}</span></li>)}</ol>}
  </section>
  const coverage = data && <section className="ui-panel flex min-h-0 flex-col gap-1 overflow-auto p-3" aria-label="统计覆盖">
    <header className="flex items-center gap-2"><h2 className="text-sm font-semibold text-ink">数据完整度</h2><DataTag kind="ready" /></header>
    <ul className="space-y-1.5">{data.channels.map(c => <li key={c.channelId} className="flex items-center gap-2 text-xs"><span className="w-24 truncate text-ink">{names[c.channelId] ?? c.channelId}</span>
      <span className="h-2 flex-1 rounded-full bg-surface-page"><span className={`block h-2 rounded-full ${c.coverage < 95 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${c.coverage}%` }} /></span><span className="w-11 text-right tabular-nums text-ink">{c.coverage.toFixed(1)}%</span></li>)}</ul>
    <p className="text-[11px] text-ink-faint">低于 95% 时数字可能偏低。</p>
  </section>
  const appearance = <section className="ui-panel flex min-h-0 flex-col gap-1 overflow-auto p-3" aria-label="外观属性统计">
    <header className="flex items-center gap-2"><h2 className="text-sm font-semibold text-ink">外观属性</h2><DataTag kind="pending" /></header>
    <p className="text-xs text-ink-subtle">衣着颜色等占比待智能搜索的颜色区分能力验证后提供，验证前不展示示例数字。</p></section>
  const heatPanel = <PlanPanel zones={zonesNow.zones} counters={zonesNow.counters} counts={zonesNow.counts} loading={zonesNow.loading} error={zonesNow.error} countsFailed={zonesNow.countsFailed} />

  return <main className="alarm-workspace flex flex-col gap-2 lg:h-full lg:min-h-0 lg:overflow-hidden">
    <header className="flex flex-wrap items-center gap-2">
      <h1 className="text-lg font-semibold leading-7 text-ink">统计分析</h1>
      {data?.provenance === 'sample' && <span role="note" aria-label="数据来源说明" title="当前显示的是示例数据：统计后端还没有接入，数字不代表真实客流，导出文件也会带“示例”标记。每个面板的标签说明了它的真实数据能不能接入。" className="rounded-full border border-warning bg-amber-50 px-2.5 py-0.5 text-xs text-ink">示例数据 · 未接入真实统计</span>}
      <ChannelPicker channels={channels ?? []} selected={selected} onToggle={toggle} />
      <div role="group" aria-label="时间范围" className="flex gap-1">{presets.map(p => <button key={p.id} type="button" aria-pressed={active === p.id} className={seg} onClick={() => { setCustomOn(false); setParam('range', p.id, 'today') }}>{p.name}</button>)}
        <button type="button" aria-label="自选时间范围" aria-pressed={active === 'custom'} className={seg} onClick={() => setPickerRange({ from: toDatetimeLocalValue(range.from), to: toDatetimeLocalValue(new Date(range.to.getTime() - 1000)) })}><CalendarClock size={14} aria-hidden="true" />自选</button></div>
      <button type="button" aria-pressed={compare} className={seg} onClick={() => setCompare(v => !v)}>对比：{range.compare}</button>
      <span className="ml-auto flex items-center gap-2 text-xs text-ink-subtle">{updated && <>更新于 {updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</>}
        <button type="button" className="btn-secondary !px-2 !py-1" aria-label="刷新" disabled={loading} onClick={() => setRevision(n => n + 1)}><RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} /></button>
        <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" disabled={!data} onClick={exportCsv}><Download size={14} aria-hidden="true" />导出 CSV</button></span>
    </header>
    {error && <p role="alert" className="rounded-base border border-danger bg-danger-50 px-3 py-1.5 text-sm text-danger-700">{error}</p>}
    <div role="tablist" aria-label="统计视图" className="flex gap-1 border-b border-line">
      {tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`-mb-px border-b-2 px-4 py-1.5 text-sm [@media(pointer:coarse)]:min-h-11 ${tab === t.id ? 'border-primary font-medium text-primary' : 'border-transparent text-ink-subtle hover:text-ink'}`} onClick={() => setParam('tab', t.id, 'overview')}>{t.name}</button>)}
      {data && <ul aria-label="洞察列表" className="ml-3 hidden min-w-0 flex-1 items-center gap-4 overflow-hidden text-xs text-ink-subtle lg:flex">{insightsOf(data).map(t => <li key={t} title={t} className="min-w-0 truncate">{t}</li>)}</ul>}
    </div>

    {!selected.length && channels && channels.length > 0 && <p role="status" className="py-6 text-center text-sm text-ink-subtle">请至少选择一个通道。</p>}
    {loading && !data && <p role="status" className="py-8 text-center text-sm text-ink-subtle">正在生成统计…</p>}

    {data && totals && peak && <>
      {(tab === 'overview' || tab === 'flow') && <section aria-label="概览" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Kpi label="进入人次" value={totals.in.toLocaleString('zh-CN')}><Delta current={totals.in} previous={data.previous?.in ?? null} compare={compare} label={data.compareLabel} /></Kpi>
        <Kpi label="离开人次" value={totals.out.toLocaleString('zh-CN')}><Delta current={totals.out} previous={data.previous?.out ?? null} compare={compare} label={data.compareLabel} /></Kpi>
        <Kpi label="高峰时段" value={peak.label}><span className="text-[11px] text-ink-faint">{peak.value.toLocaleString('zh-CN')} 人次 · 占 {peak.share}%</span></Kpi>
        <Kpi label="告警数" value={data.alarms.toLocaleString('zh-CN')} unit="条" />
      </section>}
      <div role="tabpanel" aria-label={tabs.find(t => t.id === tab)!.name} className="min-h-0 flex-1">
        {tab === 'overview' && <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="grid min-h-0 gap-2 lg:grid-rows-2">{trend(view, true)}<WeekHourPanel grid={data.weekHour} /></div>
          <div className="grid min-h-0 gap-2 lg:grid-rows-[minmax(0,13fr)_minmax(0,7fr)]">{heatPanel}
            <div className="grid min-h-0 gap-2 md:grid-cols-2">{coverage}{appearance}</div></div>
        </div>}
        {tab === 'flow' && <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">{trend('trend', false)}
          <div className="grid min-h-0 gap-2">{coverage}</div></div>}
        {tab === 'heat' && <div className="lg:h-full lg:[&>section]:h-full">{heatPanel}</div>}
        {tab === 'week' && <div className="grid gap-2 lg:h-full lg:grid-rows-[minmax(0,1fr)_auto]"><WeekHourPanel grid={data.weekHour} />{appearance}</div>}
      </div>
      <p className="text-[11px] text-ink-faint">进出人次为经过计数线的目标次数：同一目标往返分别计入，遮挡或识别中断可能少计，不等于精确人数。</p>
    </>}
    {pickerRange && <DateTimeRangePicker open from={pickerRange.from} to={pickerRange.to} validateRange={validateAnalyticsRange} onConfirm={(from, to) => { setCustom({ from: new Date(from), to: new Date(to) }); setCustomOn(true) }} onClose={() => setPickerRange(null)} />}
  </main>
}
