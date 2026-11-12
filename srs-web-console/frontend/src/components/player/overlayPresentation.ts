/** Shared live/replay presentation policy; never changes detection facts. */
export function overlayHoldMs(intervals: number[]): number {
  const sorted = intervals.filter(n => Number.isFinite(n) && n > 0 && n <= 1000).sort((a, b) => a - b)
  return Math.min(1000, Math.max(300, (sorted[Math.floor(sorted.length / 2)] ?? 100) * 3))
}
export function overlayOpacity(ageMs: number, holdMs: number): number {
  return ageMs <= 150 ? 1 : Math.max(0.25, 1 - 0.75 * (ageMs - 150) / (Math.max(300, holdMs) - 150))
}
