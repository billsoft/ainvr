import { useEffect, useRef, useState } from 'react'
import type { Bucket, Slot } from './analyticsSource'

/** 读取元素实际像素尺寸，图按它排版，文字不会被拉伸，也不会留白。测试环境没有 ResizeObserver 时用默认值。 */
export function useElementSize<T extends HTMLElement>(fallback = { w: 640, h: 200 }) {
  const ref = useRef<T>(null), [size, setSize] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (box && box.width > 0 && box.height > 0) setSize({ w: Math.round(box.width), h: Math.round(box.height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

export interface TrendSeries { name: string; color: string; values: number[] }
interface Props { series: TrendSeries[]; slots: Slot[]; bucket: Bucket; label: string }

function niceStep(max: number) { const raw = max / 4, p = 10 ** Math.floor(Math.log10(Math.max(raw, 1))), n = raw / p; return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p) }
const periodName = (from: string, bucket: Bucket) => { const d = new Date(from); return `${d.getMonth() + 1}/${d.getDate()}${bucket === 'hour' ? ` ${d.getHours()}时` : ''}` }

/** 铺满容器的分组柱状图。点柱子在图上方固定一行读数。 */
export function TrendChart({ series, slots, bucket, label }: Props) {
  const [active, setActive] = useState<number | null>(null), [box, { w, h }] = useElementSize<HTMLDivElement>()
  const max = Math.max(1, ...series.flatMap(s => s.values)), step = niceStep(max), top = Math.ceil(max / step) * step
  const left = 34, bottom = 20, pad = 6, plotW = Math.max(40, w - left - pad), plotH = Math.max(30, h - bottom - pad), slot = plotW / Math.max(1, slots.length)
  const bar = Math.max(2, Math.min(18, (slot - 3) / Math.max(1, series.length)))
  const every = Math.max(1, Math.ceil(slots.length / Math.max(2, Math.floor(plotW / 44))))
  const tick = (s: Slot) => { const d = new Date(s.from); return bucket === 'hour' ? `${d.getHours()}时` : `${d.getMonth() + 1}/${d.getDate()}` }
  const shown = active === null ? null : slots[active]
  return <figure aria-label={label} className="flex min-h-0 flex-1 flex-col gap-1">
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
      {series.map(s => <span key={s.name} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}
      <span className="ml-auto min-h-[1rem] text-ink" aria-live="polite">{shown ? `${periodName(shown.from, bucket)}：${series.map(s => `${s.name} ${s.values[active!] ?? 0}`).join('，')}` : '点柱子查看数值'}</span>
    </div>
    <div ref={box} className="relative min-h-[6rem] flex-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 h-full w-full" role="img" aria-label={`${label}：${series.map(s => `${s.name}共${s.values.reduce((a, b) => a + b, 0)}`).join('，')}`}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => {
          const v = i * step, y = pad + plotH - v / top * plotH
          return <g key={v}><line x1={left} x2={w - pad} y1={y} y2={y} stroke="currentColor" className="text-line" /><text x={left - 5} y={y + 4} textAnchor="end" fontSize="10" className="fill-ink-faint">{v}</text></g>
        })}
        {slots.map((s, i) => {
          const x = left + i * slot, group = bar * series.length, start = x + (slot - group) / 2
          return <g key={s.from} className="cursor-pointer" onClick={() => setActive(i)}>
            <rect x={x} y={pad} width={slot} height={plotH} fill={active === i ? 'rgba(22,119,255,.08)' : 'transparent'} />
            {series.map((ser, j) => { const v = ser.values[i] ?? 0, bh = v / top * plotH; return <rect key={ser.name} x={start + j * bar} y={pad + plotH - bh} width={Math.max(1, bar - 1)} height={Math.max(v ? 1.5 : 0, bh)} rx="1.5" fill={ser.color} /> })}
            {i % every === 0 && <text x={x + slot / 2} y={h - 5} textAnchor="middle" fontSize="10" className="fill-ink-faint">{tick(s)}</text>}
          </g>
        })}
      </svg>
    </div>
  </figure>
}
