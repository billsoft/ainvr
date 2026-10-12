/**
 * 时间范围快捷预设 + 格式化——识别历史页、录像回放页共用同一套（2026-09-17
 * 从识别历史页私有的 pages/RecognitionHistory/timeRange.ts 提到这里）：
 * 两个页面都是"时间轴/记录列表配一个起止范围"的同一种交互，不该各写一套
 * 时间格式化逻辑，那样迟早会在某个时区/月末边界上悄悄对不上。
 *
 * RANGE_PRESETS/DEFAULT_PRESET 是识别历史页的默认全量预设（10分~6月）；
 * 录像回放页用的是自己的子集 PLAYBACK_RANGE_PRESETS（见
 * utils/recording.ts，本机录像循环覆盖只存 1~2 天，周/月级预设没有数据，
 * 故意不放进去）——预设列表本身不共用，共用的是 RangeUnit/subtractRangeUnit
 * 这套运算逻辑和 DateTimeRangePicker 弹窗组件。
 */

export type RangeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month'

export interface RangePreset {
  label: string
  unit: RangeUnit
  n: number
}

/** 进入页面的默认搜索范围——"10分"预设，跟快捷按钮点击走同一份数据，
 * 不是页面里另起一份 magic number。单独声明再放进数组第一项，而不是
 * 反过来用 RANGE_PRESETS[0]：tsconfig 开了 noUncheckedIndexedAccess，
 * 数组下标访问的类型永远带 | undefined，索引不出常量。 */
export const DEFAULT_PRESET: RangePreset = { label: '10分', unit: 'minute', n: 10 }

/** 语义都是"此刻往前 N"。month 用日历月而不是固定 30 天数——
 * "3个月前"应该是日历上的同一天，不是模糊的 90 天。 */
export const RANGE_PRESETS: RangePreset[] = [
  DEFAULT_PRESET,
  { label: '时', unit: 'hour', n: 1 },
  { label: '2时', unit: 'hour', n: 2 },
  { label: '3时', unit: 'hour', n: 3 },
  { label: '8时', unit: 'hour', n: 8 },
  { label: '天', unit: 'day', n: 1 },
  { label: '2天', unit: 'day', n: 2 },
  { label: '3天', unit: 'day', n: 3 },
  { label: '周', unit: 'week', n: 1 },
  { label: '2周', unit: 'week', n: 2 },
  { label: '月', unit: 'month', n: 1 },
  { label: '2月', unit: 'month', n: 2 },
  { label: '3月', unit: 'month', n: 3 },
  { label: '6月', unit: 'month', n: 6 },
]

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 精确到秒的本地时间字符串（'YYYY-MM-DDTHH:mm:ss'）——不能用
 * toISOString()，那个转的是 UTC，会跟用户本地时区对不上。曾经只精确到
 * 分钟（对齐 <input type="datetime-local"> 的默认粒度），弹窗改成 iOS
 * 风格滚轮选择器、秒也能选之后，格式跟着扩到秒，否则用户选的秒会在
 * 序列化时被悄悄吃掉。 */
export function toDatetimeLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** toDatetimeLocalValue 的逆运算。'YYYY-MM-DDTHH:mm[:ss]' 没带时区偏移，
 * JS 按本地时间解析（ECMA-262 Date Time String Format），秒可以省略
 * （老格式/测试 fixture 传分钟精度的字符串时秒按 0 处理）。空串/非法值
 * 返回 null。 */
export function parseDatetimeLocalValue(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function subtractRangeUnit(d: Date, unit: RangeUnit, n: number): Date {
  const next = new Date(d)
  switch (unit) {
    case 'minute': next.setMinutes(next.getMinutes() - n); break
    case 'hour': next.setHours(next.getHours() - n); break
    case 'day': next.setDate(next.getDate() - n); break
    case 'week': next.setDate(next.getDate() - n * 7); break
    case 'month': next.setMonth(next.getMonth() - n); break
  }
  return next
}

/** 预设按钮点击 与 页面默认初始值 共用的同一份计算：范围永远是
 * "now 往前推 preset"，没有第二条路径。 */
export function presetRange(preset: RangePreset, now: Date = new Date()): { from: string; to: string } {
  const from = subtractRangeUnit(now, preset.unit, preset.n)
  return { from: toDatetimeLocalValue(from), to: toDatetimeLocalValue(now) }
}

/** 范围展示触发器用的短格式（不带秒）："09-17 16:25"——页面上那个按钮
 * 只是给个大概范围的一瞥，秒级精度加进去只会变吵，真要看多精确进弹窗
 * 底部摘要看 formatRangeFull。 */
export function formatRangeShort(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 弹窗底部摘要用的完整格式（带秒）："09-17 16:25:30"——弹窗里秒是
 * 用户能实际选的一个维度，摘要必须如实带出来，不能悄悄只显示到分钟。 */
export function formatRangeFull(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 时长人类可读格式，用于弹窗底部"共 X"摘要，帮用户一眼看出选反了
 * 日期（比如结果显示"共 -3 天"这种明显不对的数）。 */
export function formatDurationShort(ms: number): string {
  if (ms < 0) return `负 ${formatDurationShort(-ms)}`
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
}
