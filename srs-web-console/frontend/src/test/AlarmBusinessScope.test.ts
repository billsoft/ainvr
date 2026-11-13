import { expect, it } from 'vitest'
import { alarmAnalyticsHref, validateAlarmAnalyticsResult, type AlarmAnalyticsQuery } from '@/api/alarmAnalyticsService'
import { parseAlarmListScope, alarmInScope } from '@/pages/AlarmCenter/alarmListScope'
import type { AlarmEvent } from '@/api/alarmEventService'

const query: AlarmAnalyticsQuery = { from: '2026-11-12T00:00:00Z', to: '2026-11-13T00:00:00Z', timezone: 'Asia/Shanghai', bucket: 'hour', event_kind: 'fire_smoke' }
it('keeps business category through drilldown and rejects unknown categories', () => {
  const scope = parseAlarmListScope(new URL(alarmAnalyticsHref(query), 'http://localhost').search)
  expect(scope.kind).toBe('valid')
  if (scope.kind !== 'valid') throw Error('invalid scope')
  const event = { occurred_at: '2026-11-12T01:00:00Z', channel_id: 'channel', behavior: 'appearance', rule: { id: 'rule' }, event_kind: 'fire_smoke' } as unknown as AlarmEvent
  expect(alarmInScope(event, scope)).toBe(true)
  expect(alarmInScope({ ...event, event_kind: 'spatial' } as AlarmEvent, scope)).toBe(false)
  expect(parseAlarmListScope(new URL(alarmAnalyticsHref({ ...query, event_kind: 'made_up' }), 'http://localhost').search).kind).toBe('invalid')
})
it('rejects a server which silently ignores the business category', () => {
  expect(() => validateAlarmAnalyticsResult({ event_kind: 'spatial' }, query)).toThrow('响应不完整')
  expect(() => validateAlarmAnalyticsResult({}, query)).toThrow('响应不完整')
})
