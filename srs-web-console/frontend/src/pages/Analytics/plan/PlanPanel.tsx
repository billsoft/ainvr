import { Pencil } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createFloorPlanSession } from '@/api/floorPlanService'
import { DataTag } from '../DataTag'
import { FloorPlanEditor } from './FloorPlanEditor'
import { PlanCanvas } from './PlanCanvas'
import type { HeatVariant } from '../RegionHeatPanel'
import {
  activePlan, addPlan, emptyDraft, heatCells, isPlaced, mapValuesForCounter, setActive, unresolvedPlacementKeys,
  type MapCounter, type MapReading, type PlanDraft, type ZoneInfo,
} from './planModel'

const seg = 'btn-secondary !px-2.5 !py-1 text-xs [@media(pointer:coarse)]:min-h-11 aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
interface Props {
  zones: ZoneInfo[]
  counters: MapCounter[]
  readings: MapReading[]
  period: { from: string; to: string; timezone: string }
  loading: boolean
  error: string
  countsFailed: boolean
  onEditingChange?: (editing: boolean) => void
  selectedZone?: string | null
  onSelectZone?: (key: string | null) => void
  sourceHeat?: {zoneKey:string;variant:HeatVariant}|null
}
const figure = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—'

/** Transparent layout outlines with a separate count-derived heat overlay. */
export function PlanPanel({ zones, counters, readings, period, loading, error, countsFailed, onEditingChange, selectedZone, onSelectZone, sourceHeat }: Props) {
  const [draft, setDraft] = useState<PlanDraft>(() => emptyDraft()), [editing, setEditing] = useState(false)
  const [localSelected, setLocalSelected] = useState<string | null>(null), [counterId, setCounterId] = useState('')
  const selected=selectedZone===undefined?localSelected:selectedZone
  const setSelected=(key:string|null)=>{setLocalSelected(key);onSelectZone?.(key)}
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [cold, setCold] = useState(0)
  const [layerMode,setLayerMode]=useState<'count'|'source'>('source')
  const realHeat=layerMode==='source'?sourceHeat:null
  const [session] = useState(() => createFloorPlanSession()), [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setPlanLoading(true); setPlanError('')
    void session.load().then(d => { if (live) setDraft(d) })
      .catch(e => { if (live) setPlanError(e instanceof Error ? e.message : '平面图读取失败') })
      .finally(() => { if (live) setPlanLoading(false) })
    return () => { live = false }
  }, [session, retry])
  useEffect(() => () => session.dispose(), [session])
  useEffect(() => { onEditingChange?.(editing); return () => onEditingChange?.(false) }, [editing, onEditingChange])
  const counter = counters.find(c => c.id === counterId) ?? counters[0]
  const output = counter?.outputs === 'in' ? 'in' : direction
  const outputName = counter?.names?.[output] ?? (output === 'in' ? '进入' : '离开')
  const unit = counter?.unit ?? '次'
  const saved = activePlan(draft)
  const plan = useMemo(() => saved ?? (zones.length ? activePlan(addPlan(emptyDraft(), '', zones)) : null), [saved, zones])
  const unresolved = unresolvedPlacementKeys(plan, zones)
  const shown = useMemo(() => countsFailed || !counter ? {} : mapValuesForCounter(readings, counter.id, output), [countsFailed, counter, readings, output])
  const heat = useMemo(() => plan && !countsFailed ? heatCells(plan, shown, 96, 54) : undefined, [plan, countsFailed, shown])
  const currentReadings = readings.filter(r => r.counterId === counter?.id)
  const ranked = [...currentReadings].sort((a, b) => (b[output] ?? -1) - (a[output] ?? -1))
  const allKnown = ranked.length > 0 && ranked.every(r => r[output] !== null && Number.isFinite(r[output]))
  const sum = ranked.reduce((n, r) => n + (r[output] ?? 0), 0)
  const picked = zones.find(z => z.key === selected)
  const pickedReadings = readings.filter(r => r.zoneKey === selected)
  const readName = (reading: MapReading) => zones.find(z => z.key === reading.zoneKey)?.name ?? reading.zoneKey
  const directionLabel = (id: string, output: 'in' | 'out') => counters.find(c => c.id === id)?.names?.[output] ?? (output === 'in' ? '进入' : '离开')
  const legend = counter ? `${counter.name} · ${outputName} · 单位：${unit}` : '未选择计数器'
  const displayedValues = Object.keys(plan?.placements ?? {}).filter(key => zones.some(z => z.key === key)).map(key => shown[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const displayedMax = displayedValues.length ? Math.max(...displayedValues) : null
  return <section className="ui-panel flex min-h-[22rem] min-w-0 flex-col gap-2 p-3 lg:min-h-0" aria-label="热区分布">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">热区分布</h2><DataTag kind="live" />
      {sourceHeat&&<select aria-label="地图数据图层" className="form-input !w-auto !py-1 text-xs" value={layerMode} onChange={e=>setLayerMode(e.target.value as 'count'|'source')}><option value="source">画面热度嵌图</option><option value="count">通行计数示意</option></select>}
      <select aria-label="地图计数器" value={counter?.id ?? ''} className="form-input !w-auto !py-1 text-xs [@media(pointer:coarse)]:min-h-11" disabled={!counters.length}
        onChange={e => setCounterId(e.target.value)}>
        {!counters.length && <option value="">未选择计数器</option>}
        {counters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {draft.plans.length > 1 && <select aria-label="平面图" value={saved?.id ?? ''} className="form-input !w-auto !py-1 text-xs" onChange={e => setDraft(d => setActive(d, e.target.value))}>{draft.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <div role="group" aria-label="统计方向" className="flex gap-1">{(['in', 'out'] as const).filter(o => o === 'in' || counter?.outputs !== 'in').map(o =>
        <button key={o} type="button" aria-pressed={output === o} className={seg} onClick={() => setDirection(o)}>{counter?.names?.[o] ?? (o === 'in' ? '进入' : '离开')}</button>)}</div>
      <label className="flex items-center gap-1 text-[11px] text-ink-subtle">隐藏冷区<input type="range" min={0} max={90} step={5} value={cold} aria-label="隐藏冷区" className="h-6 w-16 accent-primary [@media(pointer:coarse)]:h-11" onChange={e => setCold(Number(e.target.value))} /></label>
      <button type="button" disabled={planLoading || !!planError} className="btn-secondary ml-auto !px-2.5 !py-1 text-xs [@media(pointer:coarse)]:min-h-11" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" />编辑平面图</button>
    </header>
    {unresolved.length > 0 && <details className="text-xs text-ink-subtle" aria-label="地图未读取引用">
      <summary>失效/未读取引用 {unresolved.length} 个</summary>
      <p>可能在当前筛选之外、已移除或尚未读取，不能据此判断已删除。摆放会保留，可在编辑器中明确移除。</p>
      <ul>{unresolved.map(key => <li key={key}>{key}</li>)}</ul>
    </details>}
    {planError && <p role="alert">服务器平面图读取失败：{planError} <button type="button" className={seg} onClick={() => setRetry(n => n + 1)}>重试</button></p>}
    {planLoading && <p role="status">正在读取服务器平面图…</p>}
    {countsFailed && !loading && <p role="status" className="rounded-base border border-warning bg-amber-50 px-2 py-1 text-xs text-ink">所选时段的计数没有读到，下面只显示热区位置。</p>}
    {error && <p role="alert" className="text-xs text-danger-700">{error}</p>}
    {loading ? <p role="status" className="py-10 text-center text-sm text-ink-subtle">正在读取热区…</p>
      : !zones.length && !Object.keys(plan?.placements ?? {}).length ? <p className="py-10 text-center text-sm text-ink-subtle">还没有热区。到实时监看的布防里画热区，再选用计数器，这里就会显示。</p>
      : <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-h-[12rem] min-w-0 flex-col gap-1 lg:min-h-0">
          <PlanCanvas plan={plan} zones={zones} heat={realHeat?undefined:heat} sourceHeat={realHeat} heatMin={cold / 100} selectedKey={selected} readOnly onSelectZone={setSelected} />
          <div aria-label="热区读数" aria-live="polite" className="max-h-28 overflow-auto text-xs text-ink">
            {picked ? <><p>{picked.name} · 各计数器独立读数</p><ul>{pickedReadings.map((r, i) => <li key={r.counterId + ':' + r.bindingId} title={`统计位置：${r.bindingId}`}>
              {counters.find(c => c.id === r.counterId)?.name ?? r.counterId} · 位置 {i + 1}：
              {directionLabel(r.counterId, 'in')} {figure(countsFailed ? null : r.in)}，
              {directionLabel(r.counterId, 'out')} {figure(countsFailed ? null : r.out)} {counters.find(c => c.id === r.counterId)?.unit ?? '次'}
            </li>)}</ul></> : selected && unresolved.includes(selected) ? <p>失效/未读取引用：{selected}，原摆放仍保留。</p> : <p>点热区查看各计数器的独立读数。</p>}
          </div>
          <p className="text-[11px] text-ink-faint">{saved ? saved.name : '临时布局 · 尚未保存'} · {realHeat?'所选位置的原画面热度嵌图 · 非地面投影':'按热区计数生成的相对分布示意'}</p>
          {realHeat&&!plan?.placements[realHeat.zoneKey]&&<p className="text-xs text-amber-700">所选位置不在本图，请在编辑平面图中规划摆放。</p>}
        </div>
        <div className="min-h-0 overflow-auto">
          <table aria-label="热区排名" className="w-full text-xs">
            <caption className="sr-only">{counter?.name ?? '未选择计数器'} · 按{outputName}已记录量排序</caption>
            <thead><tr className="text-left text-ink-subtle"><th className="py-2 pr-1.5 font-medium">热区</th><th className="pr-1.5 font-medium">{counter?.names?.in ?? '进入'}</th><th className="pr-1.5 font-medium">{counter?.names?.out ?? '离开'}</th><th className="font-medium">占比</th></tr></thead>
            <tbody>{ranked.map((r, i) => <tr key={r.bindingId} aria-current={selected === r.zoneKey ? 'true' : undefined} className={`cursor-pointer border-t border-line [@media(pointer:coarse)]:h-11 ${selected === r.zoneKey ? 'bg-primary-50' : ''}`} onClick={() => setSelected(selected === r.zoneKey ? null : r.zoneKey)}>
              <td className="py-2.5 pr-1.5 text-ink"><button type="button" className="text-left" title={`统计位置：${r.bindingId}`} onClick={e => { e.stopPropagation(); setSelected(r.zoneKey) }}><span className="mr-2 text-ink-faint">{i + 1}</span>{readName(r)}</button>{saved && !isPlaced(saved, r.zoneKey) && <span className="block text-[10px] text-ink-faint">不在本图</span>}</td>
              <td className="pr-1.5 tabular-nums">{figure(countsFailed ? null : r.in)}</td><td className="pr-1.5 tabular-nums">{figure(countsFailed ? null : r.out)}</td>
              <td className="tabular-nums">{!countsFailed && allKnown && sum > 0 ? `${((r[output] ?? 0) / sum * 100).toFixed(0)}%` : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>}
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/60 pt-2 text-[11px] text-ink-subtle">
      <span className="flex items-center gap-1.5">低<span aria-hidden="true" className="h-1.5 w-20 rounded-full" style={{background:'linear-gradient(90deg,#38bdf8,#22c55e,#facc15,#f97316,#ef4444)'}} />高</span>
      <span>{realHeat?'目标·秒 · 原始网格，等比例嵌入规划框':`${outputName} · ${unit} · 相对热度`}</span>
      <details className="ml-auto" aria-label="地图图例"><summary className="cursor-pointer hover:text-primary">数据说明</summary>
        {realHeat&&<p className="mt-1 max-w-prose">当前显示右侧所选版本、所选时段的真实网格，共 {(realHeat.variant.observed_ms/1000).toFixed(2)} 目标·秒。复用同一次查询，不额外采集。网格保持原画面比例，在规划框内作为小图展示；其位置是布局标记，不能当作地面坐标或区内投影。未加载位置不补造热度。下方通行计数说明仅适用于切回计数示意图层。</p>}
        <p className="mt-1 max-w-prose">{legend}；{new Date(period.from).toLocaleString('zh-CN')} — {new Date(period.to).toLocaleString('zh-CN')}（结束不含，{period.timezone}）。颜色仅比较本图该计数器的已记录量，当前最大 {figure(displayedMax)} {unit}。热力图层在热区摆放中心平滑展开，仅表达计数的相对分布，不代表区内真实轨迹、精确密度或摄像头到平面图的投影；覆盖不足可能偏低。区域框保持透明，只用于规划位置与选择，不改检测范围。“—”为未知，0 为已确认零值。同一热区的不同计数器不叠加；同一计数器有多个位置时不合并，请查看明细。</p>
      </details>
    </footer>
    {editing && <FloorPlanEditor zones={zones} counters={counters} counts={shown} countLabel={legend} sourceHeat={realHeat}
      server={{ draft, save: async d => { await session.save(d); setDraft(d) }, reload: async () => { const d = await session.load(); setDraft(d); return d } }}
      onClose={() => setEditing(false)} />}
  </section>
}
