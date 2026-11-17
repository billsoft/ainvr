import { Eraser } from 'lucide-react'
import type { Counter } from '@/api/flowService'
import type { CounterSelection } from '../Analytics/analyticsLinkContext'
import { passageReason } from './CounterStatistics'

interface Props {
  counter: Counter
  sel: CounterSelection
  zoneName: (zone: { source_id: string; zone_name: string | null }) => string
  onClear: (bindingId: string) => void
}

/** Beside the analysis: the counter's locations to tick in or out, with the analysis's numbers on each. */
export function CounterLocations({ counter, sel, zoneName, onClear }: Props) {
  const mine = sel.counters.find(c => c.counter_id === counter.counter_id)
  if (!mine) return <p className="text-xs text-ink-subtle">已选用 {counter.bindings.length} 个统计位置。当前统计对象不包含它。</p>
  if (!sel.ids.includes(mine.counter_id)) {
    return <p className="text-xs text-ink-subtle">{sel.canSelect(mine.counter_id) ? '勾选“纳入分析”后，可选择统计位置并在这里看到数量。' : '口径与已纳入的计数器不同，不能一起分析。'}</p>
  }
  const item = sel.items?.find(i => i.counter.counter_id === mine.counter_id)
  const outputs = mine.outputs === 'both' ? (['in', 'out'] as const) : (['in'] as const)
  return (
    <section aria-label={`${counter.name} 的统计位置`} className="space-y-1">
      <p className="text-xs text-ink-subtle">
        {sel.range.label}
        {item ? ' · ' + outputs.map(o => `${mine.names[o]} ${item[o]?.occurrences ?? '—'}`).join(' · ') : ' · 正在读取…'}
      </p>
      <ul className="divide-y divide-line rounded-base border border-line">
        {mine.bindings.map(b => {
          const checked = sel.bindings.includes(b.binding_id)
          const z = item?.zones.find(x => x.binding_id === b.binding_id)
          const diagnostic = [z?.in?.diagnostic, z?.out?.diagnostic].filter(d => !!d).sort((x, y) => y!.at.localeCompare(x!.at))[0]
          const name = zoneName(b)
          return (
            <li key={b.binding_id} className="flex flex-wrap items-center gap-x-1 px-2">
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={checked} onChange={() => sel.toggleBinding(b.binding_id)} />
                <span className="min-w-0 break-words">{name}{!b.active ? '（已解绑/历史）' : ''}</span>
              </label>
              {checked && z && outputs.map(o => (
                <button key={o} type="button" disabled={!z[o]} aria-label={`查看 ${name} 的${mine.names[o]}记录`}
                  className="min-h-11 min-w-11 px-1 text-sm font-semibold tabular-nums text-primary hover:underline disabled:text-ink-faint"
                  onClick={() => sel.openRecords(mine.counter_id, b.binding_id, o)}>{mine.names[o]} {z[o]?.occurrences ?? '—'}</button>
              ))}
              {checked && z && (
                <button type="button" aria-label={`清理 ${name} 的所选时段数据`} title="清理所选时段的数据"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-danger-50 hover:text-danger"
                  onClick={() => onClear(b.binding_id)}><Eraser size={14} aria-hidden="true" /></button>
              )}
              {checked && diagnostic && (
                <details className="basis-full pb-1 text-xs text-amber-800">
                  <summary className="cursor-pointer py-1">通行诊断</summary>
                  <p className="py-1 leading-5">{passageReason(diagnostic.reason)}（{new Date(diagnostic.at).toLocaleString('zh-CN')}）。不是已确认的漏计人数。</p>
                </details>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
