import { Eraser } from 'lucide-react'
import type { Counter } from '@/api/flowService'
import { ZoneChecklist } from '@/components/ZoneChecklist'
import type { CounterSelection } from '../Analytics/analyticsLinkContext'
import { passageReason } from './CounterStatistics'

interface Props {
  counter: Counter
  sel: CounterSelection
  zoneName: (zone: { source_id: string; zone_name: string | null }) => string
  onClear: (bindingId: string) => void
}

/**
 * The chosen statistic's locations, picked on its card the same way as an alarm rule's zones: tick several, 只看 one,
 * or 全选; the analysis's numbers sit on each row.
 */
export function CounterLocations({ counter, sel, zoneName, onClear }: Props) {
  const mine = sel.counters.find(c => c.counter_id === counter.counter_id)
  if (!mine) return <p className="text-xs text-ink-subtle">已选用 {counter.bindings.length} 个统计位置。</p>
  const item = sel.items?.find(i => i.counter.counter_id === mine.counter_id)
  const outputs = mine.outputs === 'both' ? (['in', 'out'] as const) : (['in'] as const)
  const own = new Set(mine.bindings.map(b => b.binding_id))
  // Other statistics' locations (a total of several) are not this card's to change.
  const others = sel.bindings.filter(id => !own.has(id))
  const change = (keys: string[]) => sel.setBindings([...others, ...keys])
  return (
    <section aria-label={`${counter.name} 的统计位置`} className="space-y-1">
      <ZoneChecklist label={`${counter.name} 的统计位置`} hint={`统计位置 · 只统计勾选的${item ? '' : ' · 正在读取…'}`}
        options={mine.bindings.map(b => ({ key: b.binding_id, name: zoneName(b), ...(!b.active ? { note: '已解绑/历史' } : {}) }))}
        chosen={new Set(sel.bindings)} onChange={change}
        extra={(o, checked) => {
          const z = item?.zones.find(x => x.binding_id === o.key)
          if (!checked || !z) return null
          const diagnostic = [z.in?.diagnostic, z.out?.diagnostic].filter(d => !!d).sort((x, y) => y!.at.localeCompare(x!.at))[0]
          return <>
            {outputs.map(out => (
              <button key={out} type="button" disabled={!z[out]} aria-label={`查看 ${o.name} 的${mine.names[out]}记录`}
                className="min-h-9 min-w-9 px-1 text-sm font-semibold tabular-nums text-primary hover:underline disabled:text-ink-faint [@media(pointer:coarse)]:min-h-11"
                onClick={() => sel.openRecords(mine.counter_id, o.key, out)}>{mine.names[out]} {z[out]?.occurrences ?? '—'}</button>
            ))}
            <button type="button" aria-label={`清理 ${o.name} 的所选时段数据`} title="清理所选时段的数据"
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-base text-ink-subtle hover:bg-danger-50 hover:text-danger [@media(pointer:coarse)]:min-h-11"
              onClick={() => onClear(o.key)}><Eraser size={14} aria-hidden="true" /></button>
            {diagnostic && (
              <details className="basis-full pb-1 text-xs text-amber-800">
                <summary className="cursor-pointer py-1">通行诊断</summary>
                <p className="py-1 leading-5">{passageReason(diagnostic.reason)}（{new Date(diagnostic.at).toLocaleString('zh-CN')}）。不是已确认的漏计人数。</p>
              </details>
            )}
          </>
        }} />
    </section>
  )
}
