export type DataPoint = { ts: number; value: number | null }

/** 全量区间统计（O(n)，range 区间不定时用） */
export function computeRangeStats(points: DataPoint[], rangeStart: number, rangeEnd: number) {
  const inRange: number[] = []
  for (const p of points) {
    if (p.value === null) continue
    if (p.ts < rangeStart || p.ts > rangeEnd) continue
    inRange.push(p.value)
  }
  if (inRange.length === 0) return null
  const sum = inRange.reduce((s, v) => s + v, 0)
  return {
    latest: inRange[inRange.length - 1]!,
    avg: sum / inRange.length,
    max: Math.max(...inRange),
    min: Math.min(...inRange),
    samples: inRange.length,
  }
}

/**
 * 最近窗口统计（从数组尾部反扫，O(k)，k 为窗口内点数）。
 * points 必须按 ts 升序排列。只统计 [nowTs - windowMs, nowTs] 区间内的点。
 */
export function computeRecentStats(points: DataPoint[], windowMs: number, nowTs: number) {
  const rangeStart = nowTs - windowMs
  const recent: number[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]
    if (!p) continue
    if (p.ts < rangeStart) break
    if (p.ts > nowTs) continue
    if (p.value === null) continue
    recent.push(p.value)
  }
  if (recent.length === 0) return null
  // recent 是倒序的，latest 是第一个元素（最新的）
  const latest = recent[0] as number
  let max = latest, min = latest, sum = 0
  for (const v of recent) {
    sum += v
    if (v > max) max = v
    if (v < min) min = v
  }
  return {
    latest,
    avg: sum / recent.length,
    max,
    min,
    samples: recent.length,
  }
}

/** 迷你趋势曲线（无坐标轴），用于卡片内嵌展示近期走势 */
export function Sparkline({ points, color, width = 120, height = 32, scale }: {
  points: DataPoint[]
  color: string
  width?: number
  height?: number
  /** Y 轴上限；不传则自适应（数据最大值 * 1.1）；百分比类指标建议固定 100 */
  scale?: number
}) {
  const valid = points.filter(p => p.value !== null)
  if (valid.length < 2) {
    return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="text-slate-200" aria-hidden="true">
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke="currentColor" strokeDasharray="3 4" />
    </svg>
  }
  const t0 = valid[0]!.ts
  const t1 = valid[valid.length - 1]!.ts
  const span = Math.max(1, t1 - t0)
  const upper = scale ?? Math.max(1, ...valid.map(p => p.value!)) * 1.1
  const innerH = height - 4
  let path = ''
  let first = true
  for (const p of valid) {
    const x = ((p.ts - t0) / span) * (width - 2) + 1
    const y = 2 + innerH - (p.value! / upper) * innerH
    path += `${first ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `
    first = false
  }
  return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
    <line x1="1" x2={width - 1} y1={height - 1.5} y2={height - 1.5} stroke="#e2e8f0" strokeWidth="1" />
    <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

export function Curve({ title, points, unit, color, range, scale, digits = 1 }: {
  title: string
  points: DataPoint[]
  unit: string
  color: string
  range?: [number, number]
  scale?: number
  digits?: number
}) {
  const valid = points.filter(p => p.value !== null)
  const min = range?.[0] ?? points[0]?.ts ?? 0
  const max = range?.[1] ?? points.at(-1)?.ts ?? 1
  const upper = scale ?? Math.max(unit === '%' ? 100 : 1, ...valid.map(p => p.value!)) * 1.05

  const stats = computeRangeStats(points, min, max)
  const fmt = (v: number) => v.toFixed(digits)

  let path = ''
  let previous: number | null = null
  const typical = points.length > 1 ? (max - min) / (points.length - 1) : 10000
  for (const point of points) {
    if (point.value === null) { previous = null; continue }
    const x = 12 + ((point.ts - min) / Math.max(1, max - min)) * 436
    const y = 112 - point.value / upper * 100
    path += `${previous === null || point.ts - previous > Math.max(60000, typical * 2.5) ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `
    previous = point.ts
  }

  return <figure className="rounded-xl border border-slate-200 bg-white p-4">
    <figcaption className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-slate-500">{stats ? <>最新 <strong className="text-slate-700">{fmt(stats.latest)} {unit}</strong></> : '暂无采样'}</span>
      </div>
      {stats && stats.samples > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 tabular-nums">
          <span>平均 <strong className="text-slate-700">{fmt(stats.avg)} {unit}</strong></span>
          <span>峰值 <strong className="text-rose-600">{fmt(stats.max)} {unit}</strong></span>
          <span>最低 <strong className="text-slate-600">{fmt(stats.min)} {unit}</strong></span>
          <span className="text-slate-400">{stats.samples} 个采样</span>
        </div>
      )}
    </figcaption>
    {valid.length ? <svg viewBox="0 0 460 135" role="img" aria-label={`${title}历史曲线`} className="mt-3 w-full">
      {[12, 62, 112].map(y => <line key={y} x1="12" x2="448" y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 4" />)}
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      <text x="448" y="10" textAnchor="end" fontSize="9" fill="#64748b">{upper.toFixed(0)} {unit}</text>
      <text x="448" y="111" textAnchor="end" fontSize="9" fill="#64748b">0</text>
      {valid.length === 1 && <circle cx="12" cy={112 - valid[0]!.value! / upper * 100} r="3" fill={color} />}
      <text x="12" y="132" fontSize="9" fill="#64748b">{new Date(min).toLocaleString()}</text>
      <text x="448" y="132" textAnchor="end" fontSize="9" fill="#64748b">{new Date(max).toLocaleString()}</text>
    </svg> : <div className="flex h-36 items-center justify-center text-sm text-slate-400">服务端尚未采集到有效数据</div>}
  </figure>
}
