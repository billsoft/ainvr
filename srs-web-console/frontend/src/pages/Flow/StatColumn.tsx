import { Eraser, Pause, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { methodNames, type Counter, type CounterResult } from '@/api/flowService'
import { labelDisplay } from '@/features/labelNames'
import { changeText, statGroups } from '../Analytics/analyticsSource'
import type { ChoiceSummary, CounterSelection } from '../Analytics/analyticsLinkContext'
import { TrendChart } from '../Analytics/TrendChart'
import { CardMenu } from './CardMenu'
import { CounterLocations } from './CounterLocations'

type ZoneName = (zone: { source_id: string; zone_name: string | null }) => string
interface Props {
  sel: CounterSelection
  list: Counter[]
  zoneName: ZoneName
  busy: string | null
  cardError: Record<string, string>
  onEdit: (c: Counter) => void
  onToggleState: (c: Counter) => void
  onRemove: (c: Counter) => void
  onRetryRemove: (c: Counter) => void
  /** Clear the analysis period's data of one location, or of every location when bindingId is absent. */
  onClear: (c: Counter, r: CounterResult, bindingId?: string) => void
}

const scopeText = (c: Counter) => `${c.labels.map(l => labelDisplay(l.name)).join('、')} · ${methodNames[c.method]} · ${c.outputs === 'both' ? `${c.names.in} / ${c.names.out}` : `只计“${c.names.in}”`}`
const card = (on: boolean) => `rounded-panel border transition-colors ${on ? 'border-primary bg-primary-50/40 shadow-sm' : 'border-line bg-surface hover:border-primary/40'}`

type Change = { in: string | null; out: string | null } | null
const changeTone = (t: string) => t.startsWith('↑') ? 'text-success-700' : t.startsWith('↓') ? 'text-danger-700' : 'text-ink-subtle'
/** The period's numbers; the chosen card shows them large, as the overview of what the analysis shows. */
function Numbers({ c, inn, out, change, large = false }: { c: Counter; inn: number | null; out: number | null; change?: Change; large?: boolean }) {
  const one = (o: 'in' | 'out', n: number | null, color: string) => <span className="flex items-baseline gap-1 text-ink-subtle">{c.names[o]}{' '}
    <strong className={`font-semibold ${color} ${large ? 'text-2xl leading-8' : ''}`}>{n ?? '—'}</strong>
    {change?.[o] && <span className={`text-xs ${changeTone(change[o]!)}`}>{change[o]}</span>}</span>
  return <span className="flex flex-wrap gap-x-4 text-sm tabular-nums">
    {one('in', inn, 'text-success-700')}
    {c.outputs === 'both' && one('out', out, 'text-orange-600')}
  </span>
}
/** Peak and net (or hourly rate) of the chosen statistic: the rest of the overview, on its card. */
function Overview({ summary, c }: { summary: ChoiceSummary; c: Counter }) {
  return <span aria-label="概览" className="grid w-full grid-cols-2 gap-2 pt-1 text-xs">
    <span className="rounded-base bg-surface px-2 py-1.5"><span className="block text-ink-subtle">{summary.peak?.complete === false ? '已记录峰值' : '高峰'}</span>
      <strong className="text-sm font-semibold tabular-nums text-ink">{summary.peak ? summary.peak.label : '—'}</strong>{summary.peak && <span className="ml-1 tabular-nums text-ink-subtle">{c.names.in} {summary.peak.value}</span>}</span>
    {summary.net !== null
      ? <span className="rounded-base bg-surface px-2 py-1.5" title={`${c.names.in}减${c.names.out}，不是实际在场人数`}><span className="block text-ink-subtle">净流入</span><strong className="text-sm font-semibold tabular-nums text-ink">{summary.net > 0 ? '+' : ''}{summary.net}</strong><span className="ml-1 text-ink-faint">非在场人数</span></span>
      : <span className="rounded-base bg-surface px-2 py-1.5"><span className="block text-ink-subtle">平均每小时</span><strong className="text-sm font-semibold tabular-nums text-ink">{summary.perHour === null ? '—' : summary.perHour.toFixed(1)}</strong><span className="ml-1 text-ink-faint">{summary.unit}</span></span>}
  </span>
}

/** The chosen statistic's trend, drawn small on its card; a slot opens its records (one statistic) or shows its reading. */
function CardTrend({ sel }: { sel: CounterSelection }) {
  const t = sel.summary?.trend
  if (!t) return null
  return <div aria-label="通行趋势" className="flex h-44 flex-col [&>figure]:min-h-0">
    <TrendChart key={sel.range.from + '|' + sel.range.to} label={t.label} bucket={t.bucket} slots={t.slots} series={t.series} reference={t.reference} complete={t.complete} onSelect={i => { if (i !== null) sel.openSlot?.(i) }} />
  </div>
}
/** Beside the analysis: every statistic is one choice; the chosen one drives the analysis and shows its locations. */
export function StatColumn({ sel, list, zoneName, busy, cardError, onEdit, onToggleState, onRemove, onRetryRemove, onClear }: Props) {
  const totalOf = (c: Counter) => sel.totals?.find(t => t.counter.counter_id === c.counter_id)
  const sum = (cs: Counter[], o: 'in' | 'out') => { let n = 0; for (const c of cs) { const v = totalOf(c)?.[o]?.occurrences; if (typeof v !== 'number') return null; n += v } return n }
  // Change against the comparison period, only when every statistic is fully covered in both periods.
  const prevOf = (c: Counter) => sel.previousTotals?.find(t => t.counter.counter_id === c.counter_id)
  const changeOf = (cs: Counter[]): Change => {
    if (!sel.previousTotals) return null
    const one = (o: 'in' | 'out') => {
      let now = 0, before = 0
      for (const c of cs) { const a = totalOf(c)?.[o], b = prevOf(c)?.[o]; if (!a || !b || a.coverage !== 'complete' || b.coverage !== 'complete') return null; now += a.occurrences; before += b.occurrences }
      return changeText(now, before)
    }
    return { in: one('in'), out: one('out') }
  }
  const groups = statGroups(list)
  const several = groups.length > 1
  const ids = new Set(groups.flatMap(g => g.counters.map(c => c.counter_id)))
  return <div className="space-y-3">
    <div role="radiogroup" aria-label="选择统计" className="space-y-4">
      {groups.map(g => <section key={g.key} aria-label={several ? scopeText(g.counters[0]!) : undefined} className="space-y-2">
        {several && <h3 className="text-xs font-medium text-ink-subtle">{scopeText(g.counters[0]!)}</h3>}
        {g.counters.length > 1 && (() => {
          const on = sel.choice?.kind === 'total' && sel.choice.key === g.key
          return <article aria-label="合计" className={card(on)}>
            <button type="button" role="radio" aria-checked={on} onClick={() => sel.choose({ kind: 'total', key: g.key })} className="flex w-full flex-col items-start gap-1 rounded-panel px-4 py-3 text-left">
              <span className="flex w-full items-baseline gap-2"><span className="text-base font-semibold text-ink">合计</span><span className="text-xs text-ink-subtle">{g.counters.length} 个统计相加</span></span>
              <Numbers c={g.counters[0]!} inn={sum(g.counters, 'in')} out={sum(g.counters, 'out')} change={on && sel.summary ? sel.summary.change : changeOf(g.counters)} large={on} />
              {on && sel.summary && <Overview summary={sel.summary} c={g.counters[0]!} />}
            </button>
            {on && sel.summary?.trend && <div className="border-t border-line px-3 pb-3 pt-2"><CardTrend sel={sel} /></div>}
          </article>
        })()}
        {g.counters.map(c => {
          const on = sel.choice?.kind === 'counter' && sel.choice.id === c.counter_id
          const t = totalOf(c), error = cardError[c.counter_id]
          const mine = sel.items?.find(i => i.counter.counter_id === c.counter_id)
          return <article key={c.counter_id} aria-label={c.name} className={card(on)}>
            <div className="flex items-start gap-1 pr-1">
              <button type="button" role="radio" aria-checked={on} onClick={() => sel.choose({ kind: 'counter', id: c.counter_id })} className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-1 rounded-panel py-3 pl-4 text-left">
                <span className="flex flex-wrap items-center gap-2 break-words text-base font-semibold leading-6 text-ink">{c.name}{c.state === 'paused' && <span className="rounded-full bg-surface-page px-2 py-0.5 text-xs font-normal text-ink-subtle">已暂停</span>}</span>
                <span className="text-xs text-ink-subtle">{scopeText(c)}</span>
                {c.bindings.length ? <Numbers c={c} inn={t?.in.occurrences ?? null} out={t?.out?.occurrences ?? null} change={on && sel.summary ? sel.summary.change : changeOf([c])} large={on} /> : <span className="text-xs text-ink-faint">还没有选用到热区，暂不计数</span>}
                {on && sel.summary && c.bindings.length > 0 && <Overview summary={sel.summary} c={c} />}
              </button>
              <div className="pt-1.5"><CardMenu label={`${c.name} 更多操作`} items={[
                { label: '编辑', icon: Pencil, onSelect: () => onEdit(c), disabled: busy === c.counter_id },
                { label: c.state === 'enabled' ? '暂停' : '启用', icon: c.state === 'enabled' ? Pause : Play, onSelect: () => onToggleState(c), disabled: busy === c.counter_id },
                ...(t && t.zones.length ? [{ label: '清理本期数据', icon: Eraser, onSelect: () => onClear(c, t) }] : []),
                { label: '删除', icon: Trash2, onSelect: () => onRemove(c), danger: true, disabled: busy === c.counter_id },
              ]} /></div>
            </div>
            {error && <p role="alert" className="px-4 pb-2 text-sm text-danger-700">{error}</p>}
            {on && <div className="space-y-2 border-t border-line px-3 pb-3 pt-2">
              {c.bindings.length > 0 && <CardTrend sel={sel} />}
              {c.bindings.length
                ? <CounterLocations counter={c} sel={sel} zoneName={zoneName} onClear={bindingId => { if (mine) onClear(c, mine, bindingId) }} />
                : <p className="text-sm text-ink-subtle">到实时监看的布防中，把它选用到画面里的热区后开始计数。<Link to="/monitor" className="ml-1 text-primary hover:underline">去实时监看布防</Link></p>}
            </div>}
          </article>
        })}
      </section>)}
      {list.filter(c => !ids.has(c.counter_id)).map(c => <article key={c.counter_id} aria-label={c.name} className="flex flex-col gap-2 rounded-panel border border-warning bg-amber-50 p-4">
        <h3 className="text-base font-semibold text-ink">{c.name}</h3>
        <p className="text-sm text-ink">删除未完成：已停止计数，历史记录尚未清除。</p>
        {cardError[c.counter_id] && <p role="alert" className="text-sm text-danger-700">{cardError[c.counter_id]}</p>}
        <div><button type="button" className="btn-secondary" disabled={busy === c.counter_id} onClick={() => onRetryRemove(c)}><RotateCcw size={16} aria-hidden="true" />重试删除</button></div>
      </article>)}
    </div>
    {groups.some(g => g.counters.length > 1) && <p className="text-xs leading-5 text-ink-faint">合计只包含目标、计数方式和方向都相同的统计；同一目标依次经过多个位置会分别计入。</p>}
  </div>
}
