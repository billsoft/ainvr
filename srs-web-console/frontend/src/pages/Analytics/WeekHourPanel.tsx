import { useState } from 'react'
import { weekdayNames } from './analyticsSource'
import { DataTag } from './DataTag'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/** 近 4 周按星期 × 小时汇总的进入人次，不随页面的时间筛选变化。读数固定在标题行，点格子查看，不依赖悬停。 */
export function WeekHourPanel({ grid }: { grid: number[][] }) {
  const [active, setActive] = useState<[number, number] | null>(null)
  const max = Math.max(1, ...grid.flat())
  const readout = active ? `${weekdayNames[active[0]]} ${active[1]} 时：${(grid[active[0]]?.[active[1]] ?? 0).toLocaleString('zh-CN')} 人次` : '点格子查看该时段的进入人次'
  return <section className="ui-panel flex min-h-[16rem] flex-col gap-2 p-3 lg:min-h-0" aria-label="星期与小时规律">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">近 4 周：一周里什么时候忙</h2><DataTag kind="ready" />
      <p aria-label="分布读数" aria-live="polite" className="ml-auto text-xs text-ink">{readout}</p>
    </header>
    <div role="group" aria-label="星期与小时分布" className="grid min-h-0 flex-1 gap-[2px] grid-rows-[auto_repeat(7,minmax(1.25rem,1fr))] [@media(pointer:coarse)]:grid-rows-[auto_repeat(7,minmax(1.5rem,1fr))]" style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}>
      <span />{HOURS.map(h => <span key={h} className="text-center text-[10px] leading-4 text-ink-faint">{h % 3 === 0 ? h : ''}</span>)}
      {grid.map((row, d) => <Row key={d} day={d} row={row} max={max} active={active} onPick={setActive} />)}
    </div>
    <p className="text-[11px] text-ink-faint">颜色越深，该时段进入的人次越多，可用来安排值守和巡检。</p>
  </section>
}

function Row({ day, row, max, active, onPick }: { day: number; row: number[]; max: number; active: [number, number] | null; onPick: (cell: [number, number]) => void }) {
  return <>
    <span className="flex items-center justify-end pr-1.5 text-[11px] text-ink-subtle">{weekdayNames[day]}</span>
    {row.map((v, h) => <button key={h} type="button" aria-label={`${weekdayNames[day]} ${h} 时，${v} 人次`}
      className={`h-full w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-primary ${active?.[0] === day && active[1] === h ? 'ring-2 ring-ink' : ''}`}
      style={{ background: `rgba(22,119,255,${(.06 + .94 * v / max).toFixed(3)})` }} onClick={() => onPick([day, h])} />)}
  </>
}
