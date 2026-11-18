import { CalendarClock, Download, RefreshCw } from 'lucide-react'
import { segment, segmented } from '@/components/ui/filterStyles'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { alarmAnalyticsCsv, alarmAnalyticsHref, alarmAnalyticsService, type AlarmAnalyticsQuery, type AlarmAnalyticsResult, type AlarmAnalyticsTrigger } from '@/api/alarmAnalyticsService'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'
import { rangeOf, validateCustomRange, type CustomRange, type Preset } from '@/pages/Flow/flowRange'
import { toDatetimeLocalValue } from '@/utils/timeRange'
import { AlarmAnalyticsMap } from './AlarmAnalyticsMap'
import AlarmAnalyticsQuality, { QualityKpis, QualityNotes } from './AlarmAnalyticsQuality'
import { useElementSize } from './TrendChart'
import { alarmBusinessName, isAlarmBusinessKind } from '@/features/alarmBusinessKind'
import { useAlarmLink } from '@/pages/AlarmCenter/alarmLink'

const button = 'btn-secondary !min-h-7 [@media(pointer:coarse)]:!min-h-11 !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const field = 'form-input !min-h-7 [@media(pointer:coarse)]:!min-h-11 !w-auto !max-w-[13rem] !py-1 text-xs'
// Where and when alarms happen is one screen; review quality answers a different question and has its own view.
const tabs = [['overview', '概况'], ['quality', '审核质量']] as const
const viewButton = segment + ' !min-h-8 !px-3 text-xs [@media(pointer:coarse)]:!min-h-11'
// Beside the alarm list every control is one height (36 px, 44 px on touch) and never wraps.
const compactButton = 'btn-secondary !min-h-9 [@media(pointer:coarse)]:!min-h-11 !px-3 !py-1 text-sm whitespace-nowrap aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const compactView = segment + ' !min-h-8 !px-3 text-sm [@media(pointer:coarse)]:!min-h-11'
const presets = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const
const typeNames: Record<string, string> = { appearance: '出现', region_approach: '接近', region_contact: '接触（历史）', region_enter: '进入', region_traverse: '穿过', line_crossing: '越线（历史）' }
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const count = (value: number) => value.toLocaleString('zh-CN')
const date = (value: string, timezone: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
const zoneId = (zone: { channel_id: string; zone_id: string }) => JSON.stringify([zone.channel_id, zone.zone_id])

function readLocations(raw: string | null): AlarmAnalyticsQuery['locations'] | 'invalid' {
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100 || raw.length > 4096 || parsed.some(z => !z || typeof z !== 'object' || Object.keys(z).some(k => !['channel_id', 'zone_id'].includes(k)) || !['channel_id', 'zone_id'].every(k => typeof z[k] === 'string' && z[k].trim() && z[k].length <= 256 && !/[\x00-\x1f]/.test(z[k])))) return 'invalid'
    return Array.from(new Map(parsed.map(z => [zoneId(z), { channel_id: z.channel_id as string, zone_id: z.zone_id as string }])).values())
  } catch { return 'invalid' }
}

function Panel({ title, children, extra, className = '' }: { title: string; children: ReactNode; extra?: ReactNode; className?: string }) {
  return <section className={'ui-panel min-w-0 p-3 ' + className} aria-label={title}><header className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">{title}</h2>{extra}</header>{children}</section>
}

function TriggerRank({ rows, query, quality = false, compact = false }: { rows: AlarmAnalyticsTrigger[]; query: AlarmAnalyticsQuery; quality?: boolean; compact?: boolean }) {
  const [copyStatus, setCopyStatus] = useState('')
  const sorted = rows.filter(r => !query.trigger_id || r.trigger_id === query.trigger_id).sort((a, b) => (quality ? b.human_false_positive - a.human_false_positive : b.total - a.total) || a.trigger_id.localeCompare(b.trigger_id))
  const max = Math.max(1, ...sorted.map(r => quality ? r.human_false_positive : r.total))
  const copyId = async (id: string) => {
    let copied = false
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(id); copied = true } } catch { /* HTTP deployments may not expose Clipboard API. */ }
    if (!copied) {
      const previous = document.activeElement
      const input = document.createElement('textarea')
      input.value = id; input.readOnly = true; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select()
      try { copied = document.execCommand('copy') } catch { copied = false }
      input.remove(); if (previous instanceof HTMLElement) previous.focus()
    }
    setCopyStatus(copied ? '已复制规则编号' : '未能自动复制，请选中下方规则编号复制')
  }
  return <><div className={quality ? 'max-h-[clamp(9rem,18vh,15rem)] overflow-auto' : compact ? 'max-h-[clamp(9rem,22vh,22rem)] [@container(min-width:44rem)]:max-h-[clamp(6rem,14vh,18rem)] overflow-auto' : 'max-h-[clamp(9rem,22vh,22rem)] overflow-auto'} tabIndex={0} aria-label={quality ? '规则审核质量排名滚动区域' : '告警规则排名滚动区域'}><table className="w-full table-fixed text-xs" aria-label={quality ? '规则审核质量排名' : '告警规则排名'}><thead className="sticky top-0 z-10 bg-white text-left text-ink-subtle"><tr><th className="font-medium">告警规则</th><th className="w-36 text-right font-medium">{quality ? '人工误报 / 明确结论' : '涉及告警'}</th></tr></thead><tbody>{sorted.map((r, i) => {
    const name = r.name?.trim() && r.name !== r.trigger_id ? r.name : '未命名规则'
    return <tr className="border-t border-line align-top" key={r.trigger_id}><td className="py-1 pr-3"><Link className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center gap-2 text-ink hover:text-primary focus-visible:outline-primary" to={alarmAnalyticsHref({ ...query, trigger_id: r.trigger_id })}><span className="text-ink-faint">{i + 1}</span><span className="min-w-0 flex-1"><span className="block truncate" title={name}>{name}</span><span className="mt-1 block h-1 overflow-hidden rounded bg-surface-page" aria-hidden="true"><span className="block h-full rounded bg-amber-400" style={{ width: `${(quality ? r.human_false_positive : r.total) / max * 100}%` }} /></span></span></Link><details className="ml-4"><summary className="inline-flex min-h-6 [@media(pointer:coarse)]:min-h-11 cursor-pointer items-center text-xs text-ink-subtle underline decoration-dotted underline-offset-2" aria-label={`规则详情：${name}`}>规则详情</summary><dl className="space-y-1 rounded bg-surface-page p-2 text-xs"><div><dt className="text-ink-subtle">规则编号</dt><dd className="select-text break-all font-mono">{r.trigger_id}</dd></div><div><dt className="inline text-ink-subtle">执行版本 </dt><dd className="inline">{r.rule_versions.length ? r.rule_versions.join(' / ') : '未记录'}</dd></div><div><button type="button" className="inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center text-primary underline focus-visible:outline-primary" aria-label={`复制规则编号：${name}`} onClick={() => { void copyId(r.trigger_id) }}>复制编号</button></div></dl></details></td><td className="py-1 text-right tabular-nums"><Link className="inline-flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center text-primary underline focus-visible:outline-primary" to={alarmAnalyticsHref({ ...query, trigger_id: r.trigger_id, ...(quality ? { audit: 'human_false_positive' as const } : {}) })}>{quality ? `${count(r.human_false_positive)} / ${count(r.human_reviewed)}` : count(r.total)}</Link>{quality && <span className="block text-xs text-ink-subtle">{r.human_reviewed ? `${(r.human_false_positive / r.human_reviewed * 100).toFixed(1)}%` : '—'}{r.human_reviewed < 20 ? ' · 样本少' : ''}</span>}</td></tr>
  })}</tbody></table>{!sorted.length && <p className="py-4 text-xs text-ink-subtle">当前范围没有已关联告警规则的告警。</p>}</div>{copyStatus && <p role="status" className="mt-1 text-xs text-ink-subtle">{copyStatus}</p>}</>
}

function AlarmTrend({ result, previous, query, fit = false }: { result: AlarmAnalyticsResult; previous: AlarmAnalyticsResult | null; query: AlarmAnalyticsQuery; /** Fill the panel it sits in (beside the list): no scrolling, and bars are the way into a slot. */ fit?: boolean }) {
  const [chosen, setChosen] = useState('')
  const rows = result.trend, max = Math.max(1, ...rows.map(r => r.total), ...(previous?.trend.map(r => r.total) ?? []))
  const [chartBox, { w: width, h: height }] = useElementSize<HTMLDivElement>({ w: 600, h: 150 })
  const left = 34, right = 12, top = 10, plot = Math.max(24, height - top - 26), plotWidth = Math.max(24, width - left - right), slot = plotWidth / Math.max(rows.length, 1)
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotWidth / 52))))
  const comparePoints = previous?.trend.map((r, i) => `${left + slot * (i + .5)},${top + plot * (1 - r.total / max)}`).join(' ')
  return <><div className="mb-1 flex flex-wrap gap-3 text-[11px] text-ink-subtle"><span>■ 已记录告警 · 条</span>{previous && <span>┄ 对比期 · 相同时段序号</span>}<span className="ml-auto">点击柱子查看该时段告警</span></div><div ref={chartBox} className={'relative min-w-0 ' + (fit ? 'min-h-0 flex-1' : 'h-[clamp(8rem,19vh,15rem)] [@container(min-width:44rem)]:h-[clamp(6rem,15vh,15rem)]')}><svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" role="img" aria-label="告警时间趋势">{[0, .5, 1].map(n => <g key={n}><line x1={left} x2={width - right} y1={top + plot * (1 - n)} y2={top + plot * (1 - n)} stroke="#e5e7eb" /><text x={left - 5} y={top + plot * (1 - n) + 4} textAnchor="end" fontSize="10.5" fill="#64748b">{Math.round(max * n)}</text></g>)}{rows.map((r, i) => <a href={alarmAnalyticsHref({ ...query, from: r.from, to: r.to })} key={r.from} tabIndex={0} aria-label={`${date(r.from, query.timezone)}至${date(r.to, query.timezone)} ${r.total}条告警`}><title>{date(r.from, query.timezone)} — {date(r.to, query.timezone)}（结束不含）：{r.total} 条</title><rect x={left + i * slot + 1} y={top} width={Math.max(1, slot - 2)} height={plot} fill="transparent" /><rect x={left + i * slot + slot * .2} y={top + plot * (1 - r.total / max)} width={Math.max(1, slot * .6)} height={r.total ? Math.max(1, plot * r.total / max) : 0} rx="2" fill="#f59e0b" />{i % labelEvery === 0 && <text x={left + slot * (i + .5)} y={height - 8} textAnchor="middle" fontSize="10.5" fill="#64748b">{new Intl.DateTimeFormat('zh-CN', { timeZone: query.timezone, ...(query.bucket === 'hour' ? { hour: '2-digit', hourCycle: 'h23' as const } : { month: 'numeric', day: 'numeric' }) }).format(new Date(r.from))}</text>}</a>)}{comparePoints && <polyline points={comparePoints} fill="none" stroke="#64748b" strokeDasharray="4 3" strokeWidth="2" pointerEvents="none" />}</svg></div>{!fit && <div className="flex flex-wrap items-center gap-2 text-xs"><label>时段 <select aria-label="告警趋势时段" className={field} value={chosen} onChange={e => setChosen(e.target.value)}><option value="">选择时段</option>{rows.map((r, i) => <option key={r.from} value={i}>{date(r.from, query.timezone)} · {r.total} 条</option>)}</select></label>{rows[Number(chosen)] && chosen !== '' && <Link className="inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center text-primary underline" to={alarmAnalyticsHref({ ...query, from: rows[Number(chosen)]!.from, to: rows[Number(chosen)]!.to })}>查看该时段</Link>}</div>}</>
}

function WeekPattern({ result, query, bare = false }: { result: AlarmAnalyticsResult; query: AlarmAnalyticsQuery; bare?: boolean }) {
  const max = Math.max(1, ...result.week.flat())
  const grid = <div className="min-h-0 overflow-auto"><div className="grid min-w-[26rem] gap-0.5" style={{ gridTemplateColumns: '2.5rem repeat(24,minmax(0,1fr))' }}><span />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="text-center text-[10px] text-ink-faint">{hour}</span>)}{result.week.map((hours, day) => <div className="contents" key={day}><span className="flex items-center text-xs text-ink-subtle">{weekdays[day]}</span>{hours.map((n, hour) => <Link key={hour} to={alarmAnalyticsHref({ ...query, weekday: day, hour })} aria-label={`${weekdays[day]} ${hour}时 ${n}条告警`} title={`${weekdays[day]} ${hour}:00—${hour + 1}:00 · ${n} 条；覆盖未知`} className="flex min-h-6 [@media(pointer:coarse)]:min-h-11 items-center justify-center rounded text-[10px] outline-offset-2 hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary" style={{ background: n ? `rgba(245,158,11,${.16 + .72 * n / max})` : '#f8fafc', color: n / max > .65 ? '#451a03' : '#64748b' }}>{n > 0 ? n : <span className="sr-only">0</span>}</Link>)}</div>)}</div></div>
  if (bare) return grid
  return <Panel className="flex min-h-0 flex-col" title="星期 × 小时" extra={<span className="text-xs text-ink-subtle">已记录告警数 · {query.timezone}</span>}>{grid}<p className="mt-2 text-[11px] text-ink-subtle" title="按所选发生时段汇总；颜色表示原始数量。0 为没有已记录告警，采集覆盖未知；未计算异常基线或风险率。格子下钻保留完整时间范围，并附加星期和小时条件。">颜色为已记录告警数；点格子查看该时段告警。</p></Panel>
}

function TypeDistribution({ result, query, spatial = false }: { result: AlarmAnalyticsResult; query: AlarmAnalyticsQuery; spatial?: boolean }) {
  if (!spatial && result.business_kinds === undefined) return <p role="status" className="py-4 text-xs text-ink-subtle">业务分类统计暂不可用，可切换趋势查看已记录告警。</p>
  const rows = [...(spatial ? result.types : result.business_kinds ?? [])].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
  const max = Math.max(1, ...rows.map(row => row.total))
  return <><div className="max-h-[clamp(10rem,27vh,23rem)] overflow-auto">{rows.map(row => <Link key={row.id} to={alarmAnalyticsHref({ ...query, ...(spatial ? { primary_type: row.id } : { event_kind: row.id }) })} className="grid min-h-8 [@media(pointer:coarse)]:min-h-11 grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs"><span>{spatial ? typeNames[row.id] || row.id : alarmBusinessName(row.id)}</span><span className="h-3 rounded bg-amber-50"><span className="block h-full rounded bg-amber-500" style={{ width: `${row.total / max * 100}%` }} /></span><span className="text-right text-primary tabular-nums">{count(row.total)}</span></Link>)}</div>{!rows.length && <p className="py-4 text-xs text-ink-subtle">当前范围没有已记录告警。</p>}<p className="mt-2 text-[11px] text-ink-subtle">{spatial ? '每条空间行为告警只按当前最高阶段归类，各阶段互斥。活动升级后历史分类可能变化。' : '同一筛选范围内，每条告警只计入一个业务类别；点击保留当前范围查看告警。'}</p></>
}


/** Embedded in 告警分析: the rule comes from the rules column (null = every rule). Standalone it reads `trigger_id`. */
export default function AlarmAnalyticsPage({ triggerId, compact = false }: { triggerId?: string | null; /** Beside the alarm list: one chart at a time under the map. */ compact?: boolean } = {}) {
  const [params, setParams] = useSearchParams()
  // On the alarm page the period ends where the rules column counts to, so their numbers agree, and both count again together.
  const link = useAlarmLink()
  const [now, setNow] = useState(() => new Date()), [revision, setRevision] = useState(0)
  const [picker, setPicker] = useState<{ from: string; to: string } | null>(null), [editing, setEditing] = useState(false)
  const [chosenView, setChartView] = useState<'business' | 'time' | 'type' | 'week' | null>(null)
  const [current, setCurrent] = useState<{ key: string; scope: string; result: AlarmAnalyticsResult } | null>(null), [previous, setPrevious] = useState<{ scope: string; result: AlarmAnalyticsResult } | null>(null)
  const [error, setError] = useState(''), [previousError, setPreviousError] = useState(''), [loading, setLoading] = useState(true)
  const [catalog, setCatalog] = useState<AlarmAnalyticsResult['catalog']>({ zones: [], triggers: [], types: [] })
  const generation = useRef(0)
  const tab = tabs.find(([key]) => key === params.get('alarm_tab'))?.[0] ?? 'overview'
  const preset = (presets.find(([key]) => key === params.get('range'))?.[0] ?? 'today') as Preset
  const compare = params.get('compare') !== '0'
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  // Custom range keys are afrom/ato: bare from/to on /alarms are a list scope.
  const rawFrom = params.get('afrom'), rawTo = params.get('ato')
  const custom = useMemo<CustomRange | null>(() => rawFrom && rawTo ? { from: new Date(rawFrom), to: new Date(Date.parse(rawTo) - 1000) } : null, [rawFrom, rawTo])
  const rangeError = rawFrom || rawTo ? !custom || validateCustomRange(custom.from, custom.to) ? '链接中的时间范围无效，请重新选择时间。' : '' : ''
  const end = link?.now ?? now
  const range = useMemo(() => rangeOf(custom && !rangeError ? 'custom' : preset, end, custom), [custom, rangeError, preset, end])
  const rawLocations = params.get('alarm_locations'), locations = useMemo(() => readLocations(rawLocations), [rawLocations])
  const invalidKind = params.has('event_kind') && !isAlarmBusinessKind(params.get('event_kind'))
  const invalid = rangeError || (invalidKind ? '链接中的业务类别无效，请清除筛选。' : '') || (locations === 'invalid' ? params.get('alarm_scope_origin') === 'limit' ? '所选位置超过告警分析上限，请返回客流减少位置，或清除筛选查看全部。' : '链接中的告警位置无效，请清除位置筛选后重试。' : '')
  const rule = triggerId === undefined ? params.get('trigger_id') : triggerId
  const query: AlarmAnalyticsQuery = useMemo(() => ({ from: range.from.toISOString(), to: range.to.toISOString(), timezone, bucket: range.bucket, ...(locations && locations !== 'invalid' ? { locations } : {}), ...(rule ? { trigger_id: rule } : {}), ...(params.get('primary_type') ? { primary_type: params.get('primary_type')! } : {}), ...(params.get('event_kind') ? { event_kind: params.get('event_kind')! } : {}) }), [range, timezone, locations, params, rule])
  const key = JSON.stringify(query)
  // The same question asked up to a later moment: the numbers on screen stay until the new ones arrive.
  const scope = JSON.stringify({ ...query, to: undefined })
  // Beside the list, one business type says nothing as a bar: the trend leads until a view is chosen.
  const chartView = chosenView ?? (compact && (current?.result.business_kinds?.length ?? 0) <= 1 ? 'time' : 'business')
  const view = chartView === 'type' && query.event_kind !== 'spatial' ? 'business' : chartView === 'week' && !compact ? 'business' : chartView
  const data = current?.scope === scope ? current.result : null
  const prior = previous?.scope === scope && compare ? previous.result : null
  const reload = link?.reload ?? 0
  const refresh = () => { if (link) link.refresh(); else { setNow(new Date()); setRevision(n => n + 1) } }
  const update = (changes: Record<string, string | null>) => setParams(old => { const next = new URLSearchParams(old); for (const [key, value] of Object.entries(changes)) value === null ? next.delete(key) : next.set(key, value); return next })
  useEffect(() => {
    const id = ++generation.current, controller = new AbortController()
    setCurrent(old => old?.scope === scope ? old : null); setError(''); setPreviousError(''); setLoading(!invalid)
    if (invalid) return () => controller.abort()
    void alarmAnalyticsService.query(query, controller.signal).then(result => { if (id === generation.current && !controller.signal.aborted) { setCurrent({ key, scope, result }); setCatalog(result.catalog) } }).catch(e => { if (!controller.signal.aborted && id === generation.current) setCurrent(null); if (!controller.signal.aborted && id === generation.current) setError((e as { status?: number }).status === 404 ? '告警统计接口尚未接通，请稍后重试。当前未显示示例数据。' : e instanceof Error ? e.message : '告警统计读取失败') }).finally(() => { if (!controller.signal.aborted && id === generation.current) setLoading(false) })
    return () => controller.abort()
  // The serialized query is the complete scope; tab changes never repeat a query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision, invalid, reload])
  useEffect(() => {
    const controller = new AbortController(); setPrevious(old => old?.scope === scope ? old : null); setPreviousError('')
    if (!compare || invalid) return () => controller.abort()
    void alarmAnalyticsService.query({ ...query, from: range.previous.from.toISOString(), to: range.previous.to.toISOString() }, controller.signal).then(result => { if (!controller.signal.aborted) setPrevious({ scope, result }) }).catch(e => { if (!controller.signal.aborted) setPreviousError(e instanceof Error ? e.message : '对比期读取失败') })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, compare, revision, invalid, reload])
  const exportCsv = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob([alarmAnalyticsCsv(data, query)], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a')
    link.href = url; link.download = '告警统计.csv'; link.click(); URL.revokeObjectURL(url)
  }
  const chooseLocations = (value: NonNullable<AlarmAnalyticsQuery['locations']>) => update({ alarm_locations: value.length ? JSON.stringify(value) : null, alarm_scope_origin: null })
  const selectedLocations = locations === 'invalid' ? [] : locations ?? []
  const allCatalog = Array.from(new Map([...catalog.zones, ...selectedLocations.map(z => ({ ...z, name: catalog.zones.find(c => zoneId(c) === zoneId(z))?.name || z.zone_id }))].map(z => [zoneId(z), z])).values())
  return <main className={'alarm-workspace flex h-full min-h-0 min-w-0 flex-col [&>*]:shrink-0 ' + (compact ? 'overflow-hidden rounded-panel border border-line bg-surface' : 'gap-2 overflow-auto [@container(min-width:56rem)]:overflow-hidden')} aria-label="告警统计分析">
    <header className={'flex items-center gap-2 ' + (compact ? 'flex-nowrap px-3 py-2' : 'flex-wrap')}>{!link && <details className="relative shrink-0" onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } }}><summary className={(compact ? compactButton : button) + ' flex cursor-pointer items-center'}>告警位置 · {locations ? `${selectedLocations.length} 个` : '全部'}</summary><div className="absolute left-0 top-full z-20 mt-1 w-80 max-w-[85vw] rounded-xl border border-line bg-white p-3 shadow-lg"><button className={button} onClick={() => chooseLocations([])}>全部位置（含未关联）</button><div className="mt-2 max-h-64 overflow-auto">{allCatalog.map(z => <label className="flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center gap-2 text-xs" key={zoneId(z)}><input type="checkbox" checked={selectedLocations.some(s => zoneId(s) === zoneId(z))} onChange={e => chooseLocations(e.target.checked ? [...selectedLocations, { channel_id: z.channel_id, zone_id: z.zone_id }] : selectedLocations.filter(s => zoneId(s) !== zoneId(z)))} /><span className="min-w-0 break-all">{z.name}<span className="block text-[10px] text-ink-faint">{z.channel_id}</span></span></label>)}{!allCatalog.length && <p className="py-3 text-xs text-ink-subtle">目录将在真实接口查询成功后显示。</p>}</div></div></details>}
      {!compact && <select className={field} aria-label="告警业务类别" disabled={!catalog.event_kinds && !query.event_kind} value={query.event_kind ?? ''} onChange={e => { setChartView(null); update({ event_kind: e.target.value || null, primary_type: null }) }}><option value="">{catalog.event_kinds ? '全部业务类别' : '业务分类暂不可用'}</option>{Array.from(new Set([...(catalog.event_kinds ?? []), ...(query.event_kind ? [query.event_kind] : [])])).map(kind => <option value={kind} key={kind}>{alarmBusinessName(kind)}</option>)}</select>}
      {query.event_kind === 'spatial' && <select className={field} aria-label="空间行为阶段" value={query.primary_type ?? ''} onChange={e => update({ primary_type: e.target.value || null })}><option value="">全部触发阶段</option>{Array.from(new Set([...catalog.types, ...(query.primary_type ? [query.primary_type] : [])])).map(t => <option value={t} key={t}>{typeNames[t] || t}</option>)}</select>}
      {!compact && <><div className="flex flex-wrap gap-1">{presets.map(([id, label]) => <button key={id} className={button} aria-pressed={!custom && preset === id} onClick={() => { setNow(new Date()); link?.refresh(); update({ range: id, afrom: null, ato: null }) }}>{label}</button>)}<button className={button} aria-label="告警自选时间范围" aria-pressed={!!custom} onClick={() => setPicker({ from: toDatetimeLocalValue(range.from), to: toDatetimeLocalValue(new Date(range.to.getTime() - 1000)) })}><CalendarClock size={14} aria-hidden="true" />自选</button></div>
      <button className={button} aria-pressed={compare} onClick={() => update({ compare: compare ? '0' : '1' })}>对比：{compare ? range.compare : '关闭'}</button></>}{compact && <div role="group" aria-label="分析内容" className={segmented + ' shrink-0'}>{tabs.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => update({ alarm_tab: id === 'overview' ? null : id })} className={compactView}>{label}</button>)}</div>}<div className="ml-auto flex shrink-0 items-center gap-1">{!compact && <button className={button} aria-label="刷新告警统计" disabled={!!picker || editing || loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" /></button>}<button className={compact ? compactButton : button} disabled={!data || loading || !!invalid} onClick={exportCsv}><Download size={14} aria-hidden="true" />导出 CSV</button></div>
    </header>
    {!compact && <div className="flex flex-wrap items-center gap-2"><div role="group" aria-label="分析内容" className={segmented}>{tabs.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => update({ alarm_tab: id === 'overview' ? null : id })} className={viewButton}>{label}</button>)}</div>{!compact && <Link className="ml-auto inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center px-2 text-xs text-primary" to="/alarms?status=pending&range=all">全部时间待审核 ↗</Link>}</div>}
    {params.get('alarm_scope_origin') === 'flow' && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-50 px-3 py-1 text-xs text-ink">沿用客流位置，告警不受统计限制。<button className={button} onClick={() => update({ alarm_locations: null, alarm_scope_origin: null })}>切换全部位置</button></div>}
    {query.primary_type && query.event_kind !== 'spatial' && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-1 text-xs text-ink">沿用历史链接阶段筛选：{typeNames[query.primary_type] || query.primary_type}；统计与下钻均保留此范围。<button className={button} onClick={() => update({ primary_type: null })}>清除阶段筛选</button></div>}
    {invalid ? <div role="alert" className="ui-panel p-5 text-sm">{invalid}<button className={button + ' ml-2'} onClick={() => update({ event_kind: invalidKind ? null : query.event_kind ?? null, ...(rangeError ? { range: 'today', afrom: null, ato: null } : { alarm_locations: null, alarm_scope_origin: null }) })}>清除无效筛选</button></div> : !data && (loading || !error) ? <div role="status" className="ui-panel py-20 text-center text-sm text-ink-subtle">正在查询真实告警统计…</div> : error ? <div role="alert" className="ui-panel p-6"><h2 className="text-sm font-semibold">告警统计暂不可用</h2><p className="my-3 text-sm text-ink-subtle">{error}</p><button className={button} onClick={() => setRevision(n => n + 1)}>重试告警统计</button><Link className="ml-4 text-sm text-primary underline" to={alarmAnalyticsHref(query)}>查看同范围告警列表</Link></div> : data && <>
      {tab === 'quality' ? <QualityKpis result={data} query={query} /> : compact ? <div role="group" aria-label="本时段告警" className="mx-3 grid grid-cols-4 divide-x divide-line rounded-base border border-line">{([['本时段新增', '范围内新增告警', data.total, undefined], ['其中仍待审核', '其中待审核', data.pending, 'pending'], ['人工确认', '人工确认', data.human_confirmed, 'human_confirmed'], ['人工判为误报', '人工判为误报', data.human_false_positive, 'human_false_positive']] as const).map(([shown, label, n, audit]) => <Link key={label} aria-label={`${label} ${n}条`} to={alarmAnalyticsHref({ ...query, ...(audit ? { audit } : {}) })} className="flex min-h-11 min-w-0 items-baseline justify-between gap-2 whitespace-nowrap px-3 py-1.5 hover:bg-amber-50 focus-visible:outline-primary"><span className="truncate text-xs text-ink-subtle">{shown}</span><strong className={'text-lg font-semibold tabular-nums ' + (audit === 'pending' && n ? 'text-danger-700' : 'text-ink')}>{count(Number(n))}</strong></Link>)}</div> : <div className="grid grid-cols-2 gap-2 [@container(min-width:44rem)]:grid-cols-4">{[['范围内新增告警', data.total, undefined], ['其中待审核', data.pending, 'pending'], ['人工确认', data.human_confirmed, 'human_confirmed'], ['人工判为误报', data.human_false_positive, 'human_false_positive']].map(([label, n, audit]) => <Link key={label} aria-label={`${label} ${n}条`} to={alarmAnalyticsHref({ ...query, ...(audit ? { audit: audit as NonNullable<AlarmAnalyticsQuery['audit']> } : {}) })} className="ui-panel flex min-h-[4.1rem] min-w-0 flex-col justify-center px-3 py-2 hover:border-amber-400 focus-visible:outline-primary"><span className="text-[11px] text-ink-subtle">{label}</span><strong className="text-xl font-semibold tabular-nums text-ink">{count(Number(n))}<span className="ml-1 text-xs font-normal text-ink-subtle">条</span></strong></Link>)}</div>}
      {compact ? <div aria-hidden="true" className="mt-1 border-b border-line" /> : <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-subtle"><span>{date(data.from, data.timezone)} — {date(data.to, data.timezone)}（结束不含，{data.timezone}）</span><span>采集覆盖未知</span><span>截至 {date(data.as_of, data.timezone)}</span>{prior && <span>对比期记录 {count(prior.total)} 条；覆盖未知，不计算增长率</span>}{previousError && compare && <span className="text-amber-800">对比期不可用：{previousError}</span>}</div>}
      {data.total === 0 && <p role="status" title="当前范围已记录 0 条告警；采集覆盖未知，不能据此判断没有异常。" className={'rounded-lg bg-amber-50 px-3 text-xs text-amber-900 ' + (compact ? 'mx-3 mt-2 truncate whitespace-nowrap py-1.5' : 'py-2')}>当前范围已记录 0 条告警；采集覆盖未知，不能据此判断没有异常。</p>}
      {/* One screen: the map leads; business or trend, and the weekly pattern sit beside it. The rules column ranks the rules. */}
      {tab === 'overview' && compact && <div className="flex min-h-0 min-w-0 flex-1 !shrink flex-col gap-2 overflow-y-auto px-2 pb-1 pt-2">
        <div className="flex min-w-0 flex-1 flex-col [&>section]:flex-1"><AlarmAnalyticsMap compact result={data} query={query} onEditingChange={setEditing} /></div>
        <Panel className="flex h-[10rem] shrink-0 flex-col" title={view === 'time' ? '告警趋势' : view === 'type' ? '空间行为最高阶段' : view === 'week' ? '星期 × 小时' : '业务类别分布'} extra={<div role="group" aria-label="分布方式" className={segmented}><button className={viewButton} aria-pressed={view === 'business'} onClick={() => setChartView('business')}>业务分类</button><button className={viewButton} aria-pressed={view === 'time'} onClick={() => setChartView('time')}>趋势</button><button className={viewButton} aria-pressed={view === 'week'} onClick={() => setChartView('week')}>星期 × 小时</button>{query.event_kind === 'spatial' && <button className={viewButton} aria-pressed={view === 'type'} onClick={() => setChartView('type')}>空间阶段</button>}</div>}><div className={'min-h-0 flex-1 ' + (view === 'time' ? 'flex flex-col overflow-hidden' : 'overflow-auto')}>{view === 'time' ? <AlarmTrend key={key} result={data} previous={prior} query={query} fit /> : view === 'week' ? <WeekPattern bare result={data} query={query} /> : <TypeDistribution result={data} query={query} spatial={view === 'type'} />}</div></Panel>
      </div>}
      {tab === 'overview' && !compact && <div className="grid min-w-0 gap-2 [@container(min-width:56rem)]:min-h-0 [@container(min-width:56rem)]:flex-1 [@container(min-width:56rem)]:!shrink [@container(min-width:56rem)]:grid-cols-[minmax(0,1.35fr)_minmax(22rem,1fr)] [@container(min-width:56rem)]:grid-rows-[minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col [&>section]:flex-1"><AlarmAnalyticsMap fill result={data} query={query} onEditingChange={setEditing} /></div>
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <Panel className="shrink-0" title={view === 'time' ? '告警趋势' : view === 'type' ? '空间行为最高阶段' : '业务类别分布'} extra={<div role="group" aria-label="分布方式" className={segmented}><button className={viewButton} aria-pressed={view === 'business'} onClick={() => setChartView('business')}>业务分类</button><button className={viewButton} aria-pressed={view === 'time'} onClick={() => setChartView('time')}>趋势</button>{query.event_kind === 'spatial' && <button className={viewButton} aria-pressed={view === 'type'} onClick={() => setChartView('type')}>空间阶段</button>}</div>}>{view === 'time' ? <AlarmTrend key={key} result={data} previous={prior} query={query} /> : <TypeDistribution result={data} query={query} spatial={view === 'type'} />}</Panel>
          <div className="flex min-h-0 flex-1 flex-col [&>section]:flex-1"><WeekPattern result={data} query={query} /></div>
        </div>
      </div>}
      {tab === 'quality' && compact && <div className="min-h-0 min-w-0 flex-1 !shrink overflow-y-auto p-2"><AlarmAnalyticsQuality result={data} query={query} ranking={<TriggerRank rows={data.triggers} query={query} quality />} /></div>}
      {tab === 'quality' && !compact && <AlarmAnalyticsQuality result={data} query={query} ranking={<TriggerRank rows={data.triggers} query={query} quality />} />}
      <footer className={'flex items-center gap-x-3 gap-y-1 border-t border-line pt-1 text-[11px] text-ink-subtle ' + (compact ? 'flex-nowrap whitespace-nowrap px-3 pb-1' : 'flex-wrap')}><Link className="inline-flex min-h-6 [@media(pointer:coarse)]:min-h-11 items-center text-primary underline" to={alarmAnalyticsHref({ ...query, association: 'unassociated' })}>未关联热区 {count(data.association.unassociated)} 条</Link>{compact && <span className="min-w-0 truncate" title={`${date(data.from, data.timezone)} — ${date(data.to, data.timezone)}（结束不含，${data.timezone}）`}>{date(data.from, data.timezone)} — {date(data.to, data.timezone)} · 截至 {date(data.as_of, data.timezone)}{prior && <> · {range.compare} {count(prior.total)}</>}{previousError && compare && <span className="text-amber-800"> · 对比期不可用</span>}</span>}{!compact && <span>保留当前全部筛选条件{query.locations ? '；已选热区时未关联数为 0' : ''}；不分配到虚构热区。</span>}<details className="ml-auto"><summary className="inline-flex min-h-6 [@media(pointer:coarse)]:min-h-11 cursor-pointer items-center">{tab === 'quality' ? '统计说明' : '统计口径与数据提示'}</summary>{compact && <p className="mt-1 max-w-3xl whitespace-normal">采集覆盖未知，数量不代表风险发生率；对比期同样覆盖未知，不计算增长率。未关联热区保留当前全部筛选条件{query.locations ? '，已选热区时为 0' : ''}，不分配到虚构热区。</p>}<p className="mt-1 max-w-3xl whitespace-normal">按首次发生时间筛选，业务类别按每条告警计数一次；空间阶段仅用于空间行为。排名包含历史阶段关联，各行可能交叉。当前审核状态可能变化，查询不是事务一致快照。AI 自动审核不计入人工确认；人工误报占比不是模型准确率。</p>{tab === 'quality' && <QualityNotes result={data} />}<p className="mt-1 max-w-3xl">{data.issues.length ? data.issues.join('；') : '本次查询没有额外的数据提示。'} <Link className="text-primary underline" to="/ai-channels">查看 AI 通道状态</Link></p></details></footer>
    </>}
    {picker && <DateTimeRangePicker open from={picker.from} to={picker.to} validateRange={validateCustomRange} onConfirm={(from, to) => { update({ range: 'custom', afrom: new Date(from).toISOString(), ato: new Date(Date.parse(to) + 1000).toISOString() }); setPicker(null) }} onClose={() => setPicker(null)} />}
  </main>
}
