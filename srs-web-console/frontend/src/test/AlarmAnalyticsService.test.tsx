import { expect, it, vi } from 'vitest'
import { alarmAnalyticsCsv, alarmAnalyticsHref, alarmAnalyticsService, validateAlarmAnalyticsResult, type AlarmAnalyticsQuery, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
import { request } from '@/api/httpClient'
vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
const query: AlarmAnalyticsQuery = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', timezone: 'Asia/Shanghai', bucket: 'hour', locations: [{ channel_id: 'p', zone_id: 'z' }], trigger_id: 't', primary_type: 'region_enter', weekday: 0, hour: 3, association: 'unassociated' }
function valid(): AlarmAnalyticsResult { return { schema_version: '1.0', from: query.from, to: query.to, as_of: query.to, timezone: query.timezone, bucket: query.bucket, total: 0, pending: 0, human_confirmed: 0, human_false_positive: 0, ai_reviewed: 0, unknown_review: 0, trend: [], zones: [], triggers: [], types: [], week: Array.from({ length: 7 }, () => Array(24).fill(0)), quality: { human_reviewed: 0, false_positive_ratio: null, wait: { samples: 0, median_ms: null, p90_ms: null, unknown: 0 }, pending_age: { lt10m: 0, lt1h: 0, gte1h: 0 } }, association: { unassociated: 0 }, catalog: { zones: [], triggers: [], types: [] }, consistency: 'non_transactional', coverage: 'unknown', issues: [] } }
it('accepts real zero while rejecting mismatched ranges, malformed matrices and invalid counts', () => {
  expect(validateAlarmAnalyticsResult(valid(), query).total).toBe(0)
  for (const corrupt of [{ ...valid(), from: query.to }, { ...valid(), total: -1 }, { ...valid(), week: [[]] }, { ...valid(), quality: null }, { ...valid(), catalog: { ...valid().catalog, types: [{ id: 'appearance' }] } }]) expect(() => validateAlarmAnalyticsResult(corrupt, query)).toThrow('响应不完整')
})
it('calls only the independent real endpoint with cancellation and preserves errors', async () => {
  const controller = new AbortController(), error = new Error('unavailable')
  vi.mocked(request).mockRejectedValue(error)
  await expect(alarmAnalyticsService.query(query, controller.signal)).rejects.toBe(error)
  expect(request).toHaveBeenCalledWith('/alarms/events/analytics', { method: 'POST', body: JSON.stringify(query), signal: expect.any(AbortSignal) })
  const merged = vi.mocked(request).mock.calls.at(-1)![1]!.signal!
  expect(merged.aborted).toBe(false)
  controller.abort()
  expect(merged.aborted).toBe(true)
})
it('keeps the 15-second timeout when the caller supplies its own cancellation signal', async () => {
  const controller = new AbortController(), timeout = new AbortController()
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  try {
    vi.mocked(request).mockRejectedValue(new Error('unavailable'))
    await expect(alarmAnalyticsService.query(query, controller.signal)).rejects.toThrow('unavailable')
    expect(spy).toHaveBeenCalledWith(15000)
    const merged = vi.mocked(request).mock.calls.at(-1)![1]!.signal!
    expect(merged.aborted).toBe(false)
    timeout.abort()
    expect(merged.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  } finally { spy.mockRestore() }
})
it('encodes complete paired location, classification, weekday and association drilldowns', () => {
  const href = alarmAnalyticsHref(query), parsed = new URL(href, 'http://localhost')
  expect(parsed.pathname).toBe('/alarms')
  expect(parsed.searchParams.get('status')).toBe('all')
  expect(JSON.parse(parsed.searchParams.get('analytics_scope')!)).toEqual(query)
})
it('exports the successful scope, raw values, weekdays and safe formula names', () => {
  const result = { ...valid(), ...query, as_of: query.to, total: 1, pending: 1, human_confirmed: 0, human_false_positive: 0, trend: [{ from: query.from, to: query.to, total: 1 }], zones: [{ channel_id: 'p', zone_id: 'z', name: '  =SUM(1)', total: 1, pending: 1, human_reviewed: 0, human_false_positive: 0 }], triggers: [], week: Array.from({ length: 7 }, () => Array(24).fill(0)), quality: { ...valid().quality, wait: { median_ms: null, p90_ms: null, samples: 0, unknown: 0 } } } as unknown as AlarmAnalyticsResult
  const csv = alarmAnalyticsCsv(result, query)
  expect(csv.startsWith('\uFEFF')).toBe(true)
  expect(csv).toContain('"\'  =SUM(1)"')
  expect(csv).toContain('"0","23","0"')
  expect(csv).toContain('发生至首次人工审核')
  expect(csv).toContain('""association"":""unassociated""')
})
