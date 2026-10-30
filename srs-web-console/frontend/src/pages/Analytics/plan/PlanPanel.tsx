import { Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DataTag } from '../DataTag'
import { FloorPlanEditor } from './FloorPlanEditor'
import { PlanCanvas } from './PlanCanvas'
import { activePlan, addPlan, emptyDraft, heatCells, isPlaced, setActive, type ZoneInfo } from './planModel'
import { loadDraft } from './planStorage'
import type { ZoneCount } from './useRealZones'

const seg = 'btn-secondary !px-2.5 !py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
interface Props { zones: ZoneInfo[]; counters: { id: string; name: string }[]; counts: Record<string, ZoneCount>; loading: boolean; error: string; countsFailed: boolean }

/** 热区分布：把真实的热区摆在平面图上，按所选时段的真实计数着色，并给出热区排名。 */
export function PlanPanel({ zones, counters, counts, loading, error, countsFailed }: Props) {
  const [draft, setDraft] = useState(() => loadDraft().draft), [editing, setEditing] = useState(false), [selected, setSelected] = useState<string | null>(null), [direction, setDirection] = useState<'total' | 'in' | 'out'>('total'), [cold, setCold] = useState(0)
  const saved = activePlan(draft)
  // 还没有保存过平面图时，临时按网格排开，让热区一眼可见；这只是显示，不会写入草稿。
  const plan = useMemo(() => saved ?? (zones.length ? activePlan(addPlan(emptyDraft(), '', zones)) : null), [saved, zones])
  const totals = useMemo(() => Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, c.in + c.out])), [counts])
  const shown = useMemo(() => Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, direction === 'in' ? c.in : direction === 'out' ? c.out : c.in + c.out])), [counts, direction])
  const heat = useMemo(() => !plan || countsFailed ? undefined : heatCells(plan, shown), [plan, shown, countsFailed])
  const picked = zones.find(z => z.key === selected)
  const rows = useMemo(() => {
    const sum = Object.values(totals).reduce((a, b) => a + b, 0)
    return [...zones].map(z => ({ z, total: totals[z.key] ?? 0, share: sum ? (totals[z.key] ?? 0) / sum * 100 : 0 })).sort((a, b) => b.total - a.total || a.z.name.localeCompare(b.z.name, 'zh-CN'))
  }, [zones, totals])
  const figure = (n: number | undefined) => countsFailed || n === undefined ? '—' : n.toLocaleString('zh-CN')
  return <section className="ui-panel flex min-h-[22rem] flex-col gap-2 p-3 lg:min-h-0" aria-label="热区分布">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">热区分布</h2><DataTag kind="live" />
      {draft.plans.length > 1 && <select aria-label="平面图" value={saved?.id ?? ''} className="form-input !w-auto !py-1 text-xs" onChange={e => setDraft(d => setActive(d, e.target.value))}>{draft.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <div role="group" aria-label="统计方向" className="flex gap-1">{([['total', '合计'], ['in', '进'], ['out', '出']] as const).map(([id, name]) => <button key={id} type="button" aria-pressed={direction === id} className={seg} onClick={() => setDirection(id)}>{name}</button>)}</div>
      <label className="flex items-center gap-1.5 text-xs text-ink-subtle">隐藏冷区<input type="range" min={0} max={90} step={5} value={cold} aria-label="隐藏冷区" className="h-6 w-24 accent-primary" onChange={e => setCold(Number(e.target.value))} /></label>
      <button type="button" className="btn-secondary ml-auto !px-2.5 !py-1 text-xs" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" />编辑平面图</button>
    </header>
    {countsFailed && !loading && <p role="status" className="rounded-base border border-warning bg-amber-50 px-2 py-1 text-xs text-ink">所选时段的计数没有读到，下面只显示热区位置。</p>}
    {error && <p role="alert" className="text-xs text-danger-700">{error}</p>}
    {loading ? <p role="status" className="py-10 text-center text-sm text-ink-subtle">正在读取热区…</p>
      : !zones.length ? <p className="py-10 text-center text-sm text-ink-subtle">还没有热区。到实时监看的布防里画热区，再选用计数器，这里就会显示。</p>
      : <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-h-[12rem] min-w-0 flex-col gap-1">
          <PlanCanvas plan={plan} zones={zones} heat={heat} heatMin={cold / 100} selectedKey={selected} readOnly onSelectZone={setSelected} />
          <p aria-label="热区读数" aria-live="polite" className="min-h-[1rem] text-xs text-ink">{picked ? `${picked.name}：进 ${figure(counts[picked.key]?.in)}，出 ${figure(counts[picked.key]?.out)}` : '点热区查看进出人次'}</p>
          <p className="text-[11px] text-ink-faint">{saved ? `平面图：${saved.name}。` : '还没有保存平面图，热区暂按网格排开。'}颜色越深，所选时段经过的人次越多。</p>
        </div>
        <div className="min-h-0 overflow-auto">
          <table aria-label="热区排名" className="w-full text-xs">
            <thead><tr className="text-left text-ink-subtle"><th className="py-1 pr-1.5 font-medium">排名</th><th className="pr-1.5 font-medium">热区</th><th className="pr-1.5 font-medium">计数器</th><th className="pr-1.5 font-medium">进</th><th className="pr-1.5 font-medium">出</th><th className="font-medium">占比</th></tr></thead>
            <tbody>{rows.map(({ z, share }, i) => <tr key={z.key} aria-current={selected === z.key ? 'true' : undefined} className={`cursor-pointer border-t border-line [@media(pointer:coarse)]:h-11 ${selected === z.key ? 'bg-primary-50' : ''}`} onClick={() => setSelected(selected === z.key ? null : z.key)}>
              <td className="py-1.5 pr-1.5 text-ink-subtle">{i + 1}</td>
              <td className="pr-1.5 text-ink">{z.name}{saved && !isPlaced(saved, z.key) && <span className="ml-1 text-[11px] text-ink-faint">（不在本图）</span>}</td>
              <td className="pr-1.5 text-ink-subtle">{z.counters.length ? z.counters.map(c => c.name).join('、') : '未关联'}</td>
              <td className="pr-1.5 tabular-nums">{figure(counts[z.key]?.in)}</td><td className="pr-1.5 tabular-nums">{figure(counts[z.key]?.out)}</td>
              <td className="tabular-nums">{countsFailed ? '—' : `${share.toFixed(0)}%`}</td></tr>)}</tbody>
          </table>
        </div>
      </div>}
    <p className="flex items-center gap-1.5 text-[11px] text-ink-faint"><DataTag kind="needs" />停留时长和区内连续热度，需要先新增采集。</p>
    {editing && <FloorPlanEditor zones={zones} counters={counters} counts={totals} onClose={() => { setDraft(loadDraft().draft); setEditing(false) }} />}
  </section>
}
