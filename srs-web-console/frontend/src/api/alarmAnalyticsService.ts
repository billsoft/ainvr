import { request } from './httpClient'

export interface AlarmAnalyticsLocation { channel_id: string; zone_id: string }
export type AlarmAnalyticsAudit = 'pending' | 'human_confirmed' | 'human_false_positive' | 'ai_reviewed' | 'unknown'
export interface AlarmAnalyticsQuery {
  from: string
  to: string
  timezone: string
  bucket: 'hour' | 'day'
  locations?: AlarmAnalyticsLocation[]
  trigger_id?: string
  primary_type?: string
  audit?: AlarmAnalyticsAudit
  weekday?: number
  hour?: number
  association?: 'unassociated'
}
export interface AlarmAnalyticsZone extends AlarmAnalyticsLocation {
  name: string; total: number; pending: number; human_reviewed: number; human_false_positive: number
}
export interface AlarmAnalyticsTrigger {
  trigger_id: string; name: string; total: number; pending: number; human_reviewed: number; human_false_positive: number; rule_versions: number[]
}
export interface AlarmAnalyticsResult {
  schema_version: '1.0'
  from: string; to: string; as_of: string; timezone: string; bucket: 'hour' | 'day'
  total: number; pending: number; human_confirmed: number; human_false_positive: number; ai_reviewed: number; unknown_review: number
  trend: { from: string; to: string; total: number }[]
  zones: AlarmAnalyticsZone[]
  triggers: AlarmAnalyticsTrigger[]
  types: { id: string; total: number }[]
  week: number[][]
  quality: {
    human_reviewed: number
    false_positive_ratio: number | null
    wait: { samples: number; median_ms: number | null; p90_ms: number | null; unknown: number }
    pending_age: { lt10m: number; lt1h: number; gte1h: number }
  }
  association: { unassociated: number }
  catalog: {
    zones: (AlarmAnalyticsLocation & { name: string })[]
    triggers: { trigger_id: string; name: string }[]
    types: string[]
  }
  consistency: 'non_transactional'
  coverage: 'unknown'
  issues: string[]
}

/** Uses the authenticated BFF. Missing APIs and failed queries never become demo data. */
export const alarmAnalyticsService = {
  async query(query: AlarmAnalyticsQuery, signal?: AbortSignal): Promise<AlarmAnalyticsResult> {
    const result = await request<unknown>('/alarms/events/analytics', {
      method: 'POST', body: JSON.stringify(query), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })
    return validateAlarmAnalyticsResult(result, query)
  },
}

/** Reject malformed or mismatched responses rather than displaying plausible partial totals. */
export function validateAlarmAnalyticsResult(value: unknown, query: AlarmAnalyticsQuery): AlarmAnalyticsResult {
  const d = value as AlarmAnalyticsResult
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024
  const list = (v: unknown, max = 5000): v is unknown[] => Array.isArray(v) && v.length <= max
  const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
  const counts = (row: { total: number; pending: number; human_reviewed: number; human_false_positive: number }) => [row.total, row.pending, row.human_reviewed, row.human_false_positive].every(number)
  try {
    if (!d || d.schema_version !== '1.0' || d.consistency !== 'non_transactional' || d.coverage !== 'unknown' || !time(d.from) || !time(d.to) || !time(d.as_of) || Date.parse(d.from) !== Date.parse(query.from) || Date.parse(d.to) !== Date.parse(query.to) || d.timezone !== query.timezone || d.bucket !== query.bucket) throw Error()
    if (![d.total, d.pending, d.human_confirmed, d.human_false_positive, d.ai_reviewed, d.unknown_review, d.association.unassociated].every(number)) throw Error()
    if (!list(d.trend, 1500) || !d.trend.every(r => time(r.from) && time(r.to) && Date.parse(r.to) > Date.parse(r.from) && Date.parse(r.from) >= Date.parse(d.from) && Date.parse(r.to) <= Date.parse(d.to) && number(r.total))) throw Error()
    if (!list(d.zones) || !d.zones.every(r => text(r.channel_id) && text(r.zone_id) && typeof r.name === 'string' && counts(r)) || !list(d.triggers) || !d.triggers.every(r => text(r.trigger_id) && typeof r.name === 'string' && counts(r) && list(r.rule_versions) && r.rule_versions.every(number))) throw Error()
    if (!list(d.types, 100) || !d.types.every(r => text(r.id) && number(r.total)) || !list(d.week, 7) || d.week.length !== 7 || !d.week.every(row => Array.isArray(row) && row.length === 24 && row.every(number))) throw Error()
    const q = d.quality, wait = q.wait
    if (![q.human_reviewed, wait.samples, wait.unknown, ...Object.values(q.pending_age)].every(number) || ![q.pending_age.lt10m, q.pending_age.lt1h, q.pending_age.gte1h].every(number) || ![wait.median_ms, wait.p90_ms].every(n => n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0) || !(q.false_positive_ratio === null || typeof q.false_positive_ratio === 'number' && Number.isFinite(q.false_positive_ratio) && q.false_positive_ratio >= 0 && q.false_positive_ratio <= 1)) throw Error()
    if (!list(d.catalog.zones) || !d.catalog.zones.every(r => text(r.channel_id) && text(r.zone_id) && typeof r.name === 'string') || !list(d.catalog.triggers) || !d.catalog.triggers.every(r => text(r.trigger_id) && typeof r.name === 'string') || !list(d.catalog.types, 100) || !d.catalog.types.every(text) || !list(d.issues, 100) || !d.issues.every(r => typeof r === 'string')) throw Error()
    return d
  } catch { throw new Error('告警统计响应不完整或与当前范围不一致，请重试；未显示部分结果。') }
}

export function alarmAnalyticsHref(query: AlarmAnalyticsQuery): string {
  return '/alarms?status=all&analytics_scope=' + encodeURIComponent(JSON.stringify(query))
}

/** Export exactly the successful response's scope; names cannot execute spreadsheet formulas. */
export function alarmAnalyticsCsv(result: AlarmAnalyticsResult, query: AlarmAnalyticsQuery): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '')
    return '"' + (/^[\s]*[=+\-@]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"'
  }
  const rows: unknown[][] = [
    ['告警统计', '发生时间 [from,to)', result.from, result.to, result.timezone],
    ['查询条件', JSON.stringify(query)],
    ['查询截止', result.as_of, '当前状态可变化，非事务一致快照', '采集覆盖未知'],
    ['指标', '数量'], ['新增告警', result.total], ['其中待审核', result.pending], ['人工确认', result.human_confirmed], ['人工判为误报', result.human_false_positive], ['AI 已审核', result.ai_reviewed], ['审核主体/结论未知', result.unknown_review], ['未关联热区', result.association.unassociated],
    ['当前最高阶段', '告警数'], ...result.types.map(row => [row.id, row.total]),
    ['趋势起点', '趋势终点（不含）', '告警数'], ...result.trend.map(row => [row.from, row.to, row.total]),
    ['通道', '热区', '名称', '涉及告警', '其中待审核', '人工已审核', '人工判为误报'], ...result.zones.map(row => [row.channel_id, row.zone_id, row.name, row.total, row.pending, row.human_reviewed, row.human_false_positive]),
    ['触发器', '名称', '涉及告警', '其中待审核', '人工已审核', '人工判为误报', '执行规则版本'], ...result.triggers.map(row => [row.trigger_id, row.name, row.total, row.pending, row.human_reviewed, row.human_false_positive, row.rule_versions.join(' / ')]),
    ['星期（周一=0）', '小时', '告警数'], ...result.week.flatMap((hours, day) => hours.map((count, hour) => [day, hour, count])),
    ['发生至首次人工审核（毫秒，含采集入库延迟）', '中位数', 'P90', '有效样本', '未知'], ['', result.quality.wait.median_ms, result.quality.wait.p90_ms, result.quality.wait.samples, result.quality.wait.unknown],
    ['人工误报占比（非模型准确率）', result.quality.false_positive_ratio, '人工明确结论样本', result.quality.human_reviewed],
    ['当前待审核年龄', '不足10分钟', '10分钟—1小时', '至少1小时'], ['', result.quality.pending_age.lt10m, result.quality.pending_age.lt1h, result.quality.pending_age.gte1h],
    ['数据提示', ...result.issues],
  ]
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
