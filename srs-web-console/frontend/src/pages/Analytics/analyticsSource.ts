import { periodSlots } from '@/pages/Flow/FlowChart'

/**
 * 统计分析页的数据来源契约。页面只认这里的形状，不关心数字从哪来：
 * `provenance` 决定页面顶部的说明、导出文件的第一行和文件名，接入真实数据后提示会自动消失。
 * 目前只有示例来源（sampleSource）；真实来源要按各面板的“数据来源”标签分别接入。
 */
export type Provenance = 'sample' | 'live'
export type Bucket = 'hour' | 'day'

export interface AnalyticsScope {
  channelIds: string[]
  from: Date
  to: Date
  bucket: Bucket
  previous: { from: Date; to: Date }
  /** 对比期的名称，例如“昨天同时段”，直接写进页面文字。 */
  compareLabel: string
}
export interface Slot { from: string; to: string }
export interface ChannelSeries { channelId: string; in: number[]; out: number[]; coverage: number }
export interface AnalyticsData {
  provenance: Provenance
  bucket: Bucket
  compareLabel: string
  slots: Slot[]
  channels: ChannelSeries[]
  /** null 表示上期没有统计覆盖：不是 0，页面不显示对比。 */
  previous: { in: number; out: number } | null
  /** 7 行（周一到周日）× 24 小时的进入人次。 */
  weekHour: number[][]
  alarms: number
}
export interface AnalyticsSource {
  /** 自动刷新间隔（毫秒）；示例数据不会变化，所以为 null。 */
  refreshMs: number | null
  load(scope: AnalyticsScope): Promise<AnalyticsData>
}

export const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const weekdayOf = (d: Date) => (d.getDay() + 6) % 7

// ---------- 汇总（真实来源同样使用） ----------
export function totalsOf(data: AnalyticsData) {
  const sum = (pick: (c: ChannelSeries) => number[]) => data.channels.reduce((n, c) => n + pick(c).reduce((a, b) => a + b, 0), 0)
  return { in: sum(c => c.in), out: sum(c => c.out) }
}
export function slotTotals(data: AnalyticsData): number[] {
  return data.slots.map((_, i) => data.channels.reduce((n, c) => n + (c.in[i] ?? 0), 0))
}
export function slotLabel(slot: Slot, bucket: Bucket) {
  const d = new Date(slot.from)
  return bucket === 'hour' ? `${d.getHours()}–${d.getHours() + 1} 时` : `${d.getMonth() + 1}/${d.getDate()}（${weekdayNames[weekdayOf(d)]}）`
}
export function peakOf(data: AnalyticsData) {
  const values = slotTotals(data), value = Math.max(0, ...values), index = Math.max(0, values.indexOf(value))
  const total = values.reduce((a, b) => a + b, 0)
  return { index, value, label: data.slots[index] ? slotLabel(data.slots[index]!, data.bucket) : '—', share: total ? Math.round(value / total * 100) : 0 }
}
/** 百分比变化；上期缺失或为 0 时没有可比性，返回 null。 */
export function deltaOf(current: number, previous: number | null): number | null {
  return previous === null || previous <= 0 ? null : (current - previous) / previous * 100
}
export function insightsOf(data: AnalyticsData): string[] {
  const out: string[] = [], totals = totalsOf(data), peak = peakOf(data)
  if (totals.in > 0) out.push(`客流高峰在 ${peak.label}，进入 ${peak.value.toLocaleString('zh-CN')} 人次，占本期 ${peak.share}%。`)
  const delta = deltaOf(totals.in, data.previous?.in ?? null)
  if (delta !== null) out.push(Math.abs(delta) < 1 ? `进入人次与${data.compareLabel}基本持平。` : `进入人次较${data.compareLabel}${delta > 0 ? '增加' : '减少'} ${Math.abs(delta).toFixed(0)}%。`)
  const low = data.channels.filter(c => c.coverage < 95).length
  if (low) out.push(`有 ${low} 个通道的统计覆盖不足 95%，数字可能偏低。`)
  return out
}

// ---------- 导出 ----------
export function toCsv(data: AnalyticsData, names: Record<string, string>): string {
  const lines: string[] = []
  if (data.provenance === 'sample') lines.push('# 示例数据，不代表真实统计')
  lines.push('时段起,通道,进入,离开')
  data.channels.forEach(c => data.slots.forEach((s, i) => lines.push(`${s.from},${(names[c.channelId] ?? c.channelId).replaceAll(',', ' ')},${c.in[i] ?? 0},${c.out[i] ?? 0}`)))
  return '﻿' + lines.join('\r\n')
}

// ---------- 示例来源 ----------
function hash(text: string) { let h = 2166136261; for (const ch of text) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) } return h >>> 0 }
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const bump = (h: number, mid: number, width: number) => Math.exp(-((h - mid) ** 2) / (2 * width * width))
const hourProfile = (h: number) => .12 + bump(h, 8.5, 1.2) + .8 * bump(h, 12.5, 1.4) + 1.1 * bump(h, 18, 1.5)
const dayFactor = (weekday: number) => weekday >= 5 ? .7 : 1
const HISTORY_DAYS = 45

export const sampleSource: AnalyticsSource = {
  refreshMs: null,
  async load(scope) {
    const slots = periodSlots(scope.from, scope.to, scope.bucket)
    const seed = hash(`${scope.channelIds.join(',')}|${scope.from.getTime()}|${scope.bucket}`)
    const channels: ChannelSeries[] = scope.channelIds.map(channelId => {
      const next = rng(seed ^ hash(channelId)), scale = 40 + hash(channelId) % 60
      const inn: number[] = [], out: number[] = []
      for (const s of slots) {
        const start = new Date(s.from), factor = dayFactor(weekdayOf(start))
        const base = scope.bucket === 'hour' ? hourProfile(start.getHours()) : Array.from({ length: 24 }, (_, h) => hourProfile(h)).reduce((a, b) => a + b, 0)
        const value = Math.round(scale * base * factor * (.85 + .3 * next()))
        inn.push(value); out.push(Math.round(value * (.9 + .1 * next())))
      }
      return { channelId, in: inn, out, coverage: Math.round((82 + hash(channelId + 'cov') % 180 / 10) * 10) / 10 }
    })
    const total = channels.reduce((n, c) => n + c.in.reduce((a, b) => a + b, 0), 0)
    const covered = scope.previous.from.getTime() >= Date.now() - HISTORY_DAYS * 86400000
    const previous = covered ? { in: Math.round(total * (.8 + .4 * rng(hash(`prev|${seed}`))())), out: 0 } : null
    if (previous) previous.out = Math.round(previous.in * .96)
    const week = rng(hash(`week|${scope.channelIds.join(',')}`))
    const weekHour = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) =>
      Math.round(scope.channelIds.reduce((n, id) => n + (40 + hash(id) % 60), 0) * hourProfile(h) * dayFactor(d) * 4 * (.85 + .3 * week()))))
    return { provenance: 'sample', bucket: scope.bucket, compareLabel: scope.compareLabel, slots, channels, previous, weekHour, alarms: Math.round(total * .03) }
  },
}
