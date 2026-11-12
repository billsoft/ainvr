/** Bounded display geometry, not a replacement for precise SEI timestamps. */
export function timelineCoveragePath(
  marks: readonly { start: number; end: number }[],
  win: { from: number; to: number },
  width: number,
): string {
  const span = win.to - win.from
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(width) || width <= 0) return ''
  const pixels = Math.min(4096, Math.max(1, Math.ceil(width)))
  // Difference array keeps processing linear even for many overlapping ranges.
  const edges = new Float64Array(pixels + 1)
  for (const mark of marks) {
    if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) continue
    const start = Math.max(win.from, mark.start)
    const end = Math.min(win.to, mark.end)
    if (end <= start) continue
    const left = Math.max(0, Math.floor((start - win.from) / span * pixels))
    const right = Math.min(pixels, Math.ceil((end - win.from) / span * pixels))
    edges[left] = edges[left]! + 1; edges[right] = edges[right]! - 1
  }
  const parts: string[] = []
  let active = 0, start = -1
  const pct = (x: number) => (x / pixels * 100).toFixed(4)
  for (let x = 0; x <= pixels; x++) {
    active += edges[x]!
    if (x < pixels && active > 0) {
      if (start < 0) start = x
    } else if (start >= 0) {
      parts.push(`M${pct(start)} 0H${pct(x)}V24H${pct(start)}Z`)
      start = -1
    }
  }
  return parts.join('')
}
