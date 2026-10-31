import { flowService, type CounterResult, type Coverage, type ZoneSeries } from '@/api/flowService'
export type Bucket = 'hour' | 'day'
export interface Slot { from: string; to: string }
export const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
export type Location = { counterId: string; bindingId: string }
export type Value = number | null
const vehicleLabels = new Set(['car','truck','bus','motorcycle','bicycle'])
export function counterUnit(counter: { labels: { label_id: string; name?: string }[] }): string {
  const labels = counter.labels.map(l => (l.name || l.label_id).trim().toLowerCase())
  return labels.length === 1 && ['person','people','pedestrian','人','人员','行人'].includes(labels[0]!) ? '人次' : labels.length && labels.every(id => vehicleLabels.has(id)) ? '车次' : '次'
}
export interface Row { result: CounterResult; zone: CounterResult['zones'][number] }
export function selectedRows(items: CounterResult[], selected: Location[]): Row[] {
  return items.flatMap(result => result.zones.filter(z => selected.some(x => x.counterId === result.counter.counter_id && x.bindingId === z.binding_id)).map(zone => ({ result, zone })))
}
export function measured(c: Coverage | undefined): number | null {
  return c && typeof c.ratio === 'number' && Number.isFinite(c.ratio) && c.ratio >= 0 && c.ratio <= 1 ? c.ratio : null
}
type IntervalIndex = { starts: number[]; ends: number[]; prefix: number[] }
const coverageIndexes = new WeakMap<Coverage, { expected: IntervalIndex; observed: IntervalIndex }>()
function merged(intervals: Slot[]): number[][] {
  const parts = intervals.map(i => [Date.parse(i.from),Date.parse(i.to)])
    .filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b! > a!).sort((a,b) => a[0]!-b[0]!)
  const out: number[][] = []
  for (const [a,b] of parts) {
    const last = out.at(-1)
    if (last && a! <= last[1]!) last[1] = Math.max(last[1]!,b!)
    else out.push([a!,b!])
  }
  return out
}
function intervalIndex(parts: number[][]): IntervalIndex {
  const index: IntervalIndex = { starts: [], ends: [], prefix: [0] }
  for (const [a,b] of parts) {
    index.starts.push(a!); index.ends.push(b!); index.prefix.push(index.prefix.at(-1)!+b!-a!)
  }
  return index
}
function elapsed(index: IntervalIndex, from: number, to: number): number {
  if (to <= from || !Number.isFinite(from) || !Number.isFinite(to)) return 0
  const until = (at: number) => {
    let lo = 0, hi = index.starts.length
    while (lo < hi) { const mid = (lo+hi) >>> 1; if (index.starts[mid]! < at) lo = mid+1; else hi = mid }
    const i = lo-1
    return i < 0 ? 0 : index.prefix[i]! + Math.min(index.ends[i]!-index.starts[i]!,at-index.starts[i]!)
  }
  return until(to)-until(from)
}
/** API coverage objects are immutable: merge/intersect once, then read every bucket in logarithmic time. */
function indexedCoverage(c: Coverage | undefined) {
  if (!c?.intervals || !c.expected_intervals) return null
  const cached = coverageIndexes.get(c)
  if (cached) return cached
  const expected = merged(c.expected_intervals), observed = merged(c.intervals), intersection: number[][] = []
  let i = 0, j = 0
  while (i < expected.length && j < observed.length) {
    const a = Math.max(expected[i]![0]!,observed[j]![0]!), b = Math.min(expected[i]![1]!,observed[j]![1]!)
    if (b > a) intersection.push([a,b])
    if (expected[i]![1]! <= observed[j]![1]!) i++; else j++
  }
  const result = { expected: intervalIndex(expected), observed: intervalIndex(intersection) }
  coverageIndexes.set(c,result)
  return result
}
export function bucketCoverage(c: Coverage | undefined, slot: Slot, query: Slot): {ratio:number|null; state:string} {
  const index = indexedCoverage(c)
  if (!index) return {ratio:null,state:'unknown'}
  const from = Math.max(Date.parse(slot.from), Date.parse(query.from)), to = Math.min(Date.parse(slot.to), Date.parse(query.to))
  const expected = elapsed(index.expected, from, to)
  if (expected <= 0) return {ratio:null,state:'not_applicable'}
  const ratio = Math.min(1,elapsed(index.observed, from, to) / expected)
  return {ratio,state:ratio === 1 ? 'complete' : ratio === 0 ? 'no_data' : 'partial'}
}
export function bucketComplete(c: Coverage | undefined, slot: Slot, query: Slot): boolean {
  const start=Math.max(Date.parse(slot.from),Date.parse(query.from)), end=Math.min(Date.parse(slot.to),Date.parse(query.to))
  const index = indexedCoverage(c)
  return !!index && end>start && elapsed(index.expected,start,end) === end-start && elapsed(index.observed,start,end) === end-start
}
export function valueOf(series: ZoneSeries | undefined): Value {
  if (!series) return null
  return series.occurrences > 0 || measured(series.coverage) === 1 ? series.occurrences : null
}
export function bucketValue(series: ZoneSeries | undefined, slot: Slot, query: Slot): Value {
  if (!series) return null
  const count = series.buckets.filter(b => Date.parse(b.from) < Date.parse(slot.to) && Date.parse(b.to) > Date.parse(slot.from)).reduce((n,b) => n+b.occurrences,0)
  return count > 0 || bucketComplete(series.coverage, slot, query) ? count : null
}
export function sumKnown(values: Value[]): Value {
  const present = values.filter((n): n is number => n !== null)
  if (!present.length) return null
  const sum = present.reduce((a,b) => a+b,0)
  return sum === 0 && present.length !== values.length ? null : sum
}
export function complete(rows: Row[], direction: 'in'|'out', query: Slot): boolean {
  const applicable = rows.filter(r => direction === 'in' || r.result.counter.outputs === 'both')
  return applicable.length > 0 && applicable.every(r => bucketComplete(r.zone[direction]?.coverage,query,query))
}
export function totalsOf(rows: Row[], direction: 'in'|'out'): Value {
  return sumKnown(rows.map(r => valueOf(r.zone[direction])))
}
export function weekWindow(now: Date): {from: Date; to: Date} {
  const to = new Date(now); to.setHours(0,0,0,0); to.setDate(to.getDate() - (to.getDay()+6)%7)
  const from = new Date(to); from.setDate(from.getDate()-28)
  return {from,to}
}
export interface WeekCell { value: number | null; samples: number }
export function weekPattern(rows: Row[], from: Date, to: Date): WeekCell[][] {
  const cells: {sum:number; samples:number}[][] = Array.from({length:7},()=>Array.from({length:24},()=>({sum:0,samples:0})))
  const query = {from:from.toISOString(),to:to.toISOString()}
  const groups = new Map<string, Slot[]>()
  const slots:Slot[] = []
  for (let t=from.getTime();t<to.getTime();t+=3600000) slots.push({from:new Date(t).toISOString(),to:new Date(Math.min(t+3600000,to.getTime())).toISOString()})
  for (const slot of slots) {
    const d = new Date(slot.from), key = [d.getFullYear(),d.getMonth(),d.getDate(),d.getHours()].join('-')
    groups.set(key,[...(groups.get(key) ?? []),slot])
  }
  for (const slots of groups.values()) {
    if (!rows.length || !slots.every(s => rows.every(r => bucketComplete(r.zone.in?.coverage,s,query)))) continue
    const d = new Date(slots[0]!.from), cell = cells[(d.getDay()+6)%7]![d.getHours()]!
    cell.sum += slots.reduce((n,s) => n + rows.reduce((a,r)=>a+(bucketValue(r.zone.in,s,query) ?? 0),0),0); cell.samples++
  }
  return cells.map(row => row.map(c => ({value:c.samples ? c.sum/c.samples : null,samples:c.samples})))
}
export async function queryFlow(from: Date, to: Date, bucket: Bucket, counterIds: string[]) {
  return flowService.query({from:from.toISOString(),to:to.toISOString(),bucket,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',counter_ids:counterIds})
}
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value)
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s
  return '"' + s.replaceAll('"','""') + '"'
}
export function toCsv(rows: Row[], slots: Slot[], query: Slot, timezone: string, asOf: string): string {
  const output = [['时间起','时间止','时区','计数器','热区','方向','单位','已记录次数','覆盖状态','覆盖比例','查询截止','口径']]
  for (const r of rows) for (const direction of (r.result.counter.outputs === 'both' ? ['in','out'] : ['in']) as ('in'|'out')[]) for (const s of slots) {
    const series = r.zone[direction], coverage = bucketCoverage(series?.coverage,s,query)
    output.push([new Date(Math.max(Date.parse(s.from),Date.parse(query.from))).toISOString(),new Date(Math.min(Date.parse(s.to),Date.parse(query.to))).toISOString(),timezone,r.result.counter.name,r.zone.zone_name ?? r.zone.zone_id,r.result.counter.names[direction],counterUnit(r.result.counter),
      String(bucketValue(series,s,query) ?? ''),({complete:'完整',partial:'部分覆盖',no_data:'无覆盖',unknown:'未知',not_applicable:'不适用'}[coverage.state]??'未知'),coverage.ratio === null ? '' : String(coverage.ratio),asOf,'按绑定及方向统计；可能重复计数'])
  }
  return '\ufeff' + output.map(line=>line.map(csvCell).join(',')).join('\r\n')
}
