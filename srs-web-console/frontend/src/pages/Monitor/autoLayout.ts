/** Automatic capacity; large catalogues remain one scrollable grid, never truncated. */
export function autoMonitorCapacity(count: number): number {
  const n = Math.max(0, Math.ceil(Number.isFinite(count) ? count : 0))
  for (const size of [4, 6, 8, 10, 16]) if (n <= size) return size
  return Math.ceil(n / 2) * 2
}
