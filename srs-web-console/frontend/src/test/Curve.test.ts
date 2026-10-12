import { describe, it, expect } from 'vitest'
import { computeRangeStats, computeRecentStats, type DataPoint } from '../pages/Dashboard/Curve'

describe('computeRangeStats', () => {
  const base = 1_700_000_000_000
  const pts = (vals: (number | null)[]): DataPoint[] =>
    vals.map((v, i) => ({ ts: base + i * 10_000, value: v }))

  it('空数组返回 null', () => {
    expect(computeRangeStats([], base, base + 100_000)).toBeNull()
  })

  it('全是 null 返回 null', () => {
    expect(computeRangeStats(pts([null, null, null]), base, base + 100_000)).toBeNull()
  })

  it('range 内无点返回 null', () => {
    expect(computeRangeStats(pts([10, 20, 30]), base + 100_000, base + 200_000)).toBeNull()
  })

  it('单点返回该值且 samples=1', () => {
    const r = computeRangeStats(pts([42]), base, base + 10_000)
    expect(r).toEqual({ latest: 42, avg: 42, max: 42, min: 42, samples: 1 })
  })

  it('多点正确计算 avg/max/min/latest', () => {
    const r = computeRangeStats(pts([10, 20, 30, 20, 10]), base, base + 40_000)
    expect(r).toEqual({ latest: 10, avg: 18, max: 30, min: 10, samples: 5 })
  })

  it('range 裁剪：只统计区间内的点', () => {
    const r = computeRangeStats(pts([10, 20, 30, 40, 50]), base + 15_000, base + 35_000)
    // 落在 [15s, 35s] 内的是 ts=20s(val=30), ts=30s(val=40)
    expect(r).toEqual({ latest: 40, avg: 35, max: 40, min: 30, samples: 2 })
  })

  it('闭区间边界：端点包含', () => {
    const r = computeRangeStats(pts([10, 20, 30]), base + 10_000, base + 20_000)
    expect(r).toEqual({ latest: 30, avg: 25, max: 30, min: 20, samples: 2 })
  })

  it('混合 null 值只统计有效点', () => {
    const r = computeRangeStats(pts([10, null, 30, null, 50]), base, base + 50_000)
    expect(r).toEqual({ latest: 50, avg: 30, max: 50, min: 10, samples: 3 })
  })

  it('latest 取区间内最后一个点，不是全量最后一个', () => {
    const r = computeRangeStats(pts([10, 20, 30, 40, 50]), base, base + 20_000)
    expect(r!.latest).toBe(30)
    expect(r!.samples).toBe(3)
  })
})

describe('computeRecentStats', () => {
  const base = 1_700_000_000_000
  const pts = (vals: (number | null)[]): DataPoint[] =>
    vals.map((v, i) => ({ ts: base + i * 10_000, value: v }))
  const nowTs = base + 90_000 // 第10个点之后

  it('空数组返回 null', () => {
    expect(computeRecentStats([], 60_000, nowTs)).toBeNull()
  })

  it('全是 null 返回 null', () => {
    expect(computeRecentStats(pts([null, null]), 60_000, nowTs)).toBeNull()
  })

  it('窗口内无点返回 null', () => {
    expect(computeRecentStats(pts([10, 20]), 10_000, base - 100_000)).toBeNull()
  })

  it('单点返回该值', () => {
    const r = computeRecentStats(pts([42]), 60_000, base + 10_000)
    expect(r).toEqual({ latest: 42, avg: 42, max: 42, min: 42, samples: 1 })
  })

  it('多点正确计算 avg/max/min/latest', () => {
    // 10个点: ts=0..90s, values=10..100, 每个间隔10s, nowTs=base+90s
    const vals = Array.from({ length: 10 }, (_, i) => (i + 1) * 10)
    const r = computeRecentStats(pts(vals), 60_000, nowTs)
    // 最近 60s: ts=30s..90s → values 40,50,60,70,80,90,100 (7个点)
    expect(r!.samples).toBe(7)
    expect(r!.latest).toBe(100)
    expect(r!.avg).toBe((40 + 50 + 60 + 70 + 80 + 90 + 100) / 7)
    expect(r!.max).toBe(100)
    expect(r!.min).toBe(40)
  })

  it('窗口左边界为开区间（< rangeStart 停止），最新的等于 rangeStart 时也包含', () => {
    // nowTs = base + 30s, window = 30s → rangeStart = base
    const r = computeRecentStats(pts([10, 20, 30, 40]), 30_000, base + 30_000)
    // ts=0,10,20,30 都 >= rangeStart=base（反扫过程中 ts >= rangeStart 都被计入）
    expect(r!.samples).toBe(4)
    expect(r!.latest).toBe(40)
  })

  it('混合 null 值只统计有效点', () => {
    const r = computeRecentStats(pts([10, null, 30, null, 50]), 60_000, base + 50_000)
    expect(r).toEqual({ latest: 50, avg: 30, max: 50, min: 10, samples: 3 })
  })

  it('从尾部反扫，遇到窗口外立即 break', () => {
    // 100 个点，只取最后几个，验证不会遍历全部
    const vals = Array.from({ length: 100 }, (_, i) => i)
    const r = computeRecentStats(pts(vals), 30_000, base + 990_000)
    expect(r!.samples).toBe(4) // ts=960,970,980,990 → 4个点
    expect(r!.latest).toBe(99)
  })

  it('latest 是窗口内最新的点（数组最后一个）', () => {
    const r = computeRecentStats(pts([5, 3, 8, 2, 7]), 60_000, base + 50_000)
    expect(r!.latest).toBe(7)
  })
})
