import { expect, it } from 'vitest'
import { assembleZones, type ZoneSource } from '@/pages/Analytics/plan/useRealZones'
import type { Counter, CounterResult } from '@/api/flowService'

const zone = (id: string, name: string): ZoneSource => ({ zone_id: id, name, processor_id: 'p' })
const usage = (zone_id: string, active = true, zone_name: string | null = null) => ({ binding_id: `b-${zone_id}`, source_id: 's', processor_id: 'p', zone_id, zone_name, active, counting: true, direction: { kind: 'line', edge: 'e', in_side: 'inward' } as const })
const counter = (id: string, bindings: ReturnType<typeof usage>[]): Counter => ({ counter_id: id, name: `计数器${id}`, labels: [], method: 'line', outputs: 'both', names: { in: '进', out: '出' }, occupancy: false, max_gap_ms: 0, state: 'enabled', version: 1, bindings })
const result = (c: Counter, rows: { zone_id: string; in?: number; out?: number }[]): CounterResult => ({ counter: c, in: { occurrences: 0, buckets: [], coverage: 'complete' },
  zones: rows.map(r => ({ ...usage(r.zone_id), in: r.in === undefined ? undefined : { occurrences: r.in, tracked_targets: 0, coverage: { state: 'complete' as const }, buckets: [] }, out: r.out === undefined ? undefined : { occurrences: r.out, tracked_targets: 0, coverage: { state: 'complete' as const }, buckets: [] } })) })

it('lists the zones drawn in arming with every counter that uses them, keeps counters with no zone, and ignores stopped bindings', () => {
  const c1 = counter('1', [usage('za'), usage('zc')]), c2 = counter('2', [usage('zc'), usage('zb', false)]), c3 = counter('3', [])
  const { zones, counters } = assembleZones([zone('za', '一厅A口'), zone('zb', '二厅B口'), zone('zc', '共用通道'), zone('za', '一厅A口')], [c1, c2, c3], null)
  expect(counters.map(c => c.id)).toEqual(['1', '2', '3'])
  expect(zones.map(z => z.zoneId)).toEqual(['za', 'zb', 'zc'])
  expect(zones.find(z => z.zoneId === 'zc')!.counters.map(c => c.id)).toEqual(['1', '2'])
  expect(zones.find(z => z.zoneId === 'zb')!.counters).toEqual([])
  expect(zones.every(z => z.key === z.zoneId)).toBe(true)
})
it('never loses a zone that a counter is actually using, even when the arming document could not be read', () => {
  const c = counter('1', [usage('boarding', true, '登船口')])
  const { zones } = assembleZones([], [c], null)
  expect(zones.map(z => [z.zoneId, z.name, z.counters.map(k => k.name)])).toEqual([['boarding', '登船口', ['计数器1']]])
  const named = assembleZones([zone('boarding', '登船口（新名）')], [c], null).zones
  expect(named).toHaveLength(1); expect(named[0]!.name).toBe('登船口（新名）')
  expect(assembleZones([], [counter('2', [usage('x', true, null)])], null).zones[0]!.name).toBe('热区')
})
it('adds up entries and exits of a zone across counters and leaves counts empty when the query failed', () => {
  const c1 = counter('1', [usage('za')]), c2 = counter('2', [usage('za')])
  const zones = [zone('za', 'A'), zone('zb', 'B')]
  const out = assembleZones(zones, [c1, c2], [result(c1, [{ zone_id: 'za', in: 10, out: 4 }]), result(c2, [{ zone_id: 'za', in: 5 }])])
  expect(out.counts).toEqual({ za: { in: 15, out: 4 } })
  expect(assembleZones(zones, [c1, c2], null).counts).toEqual({})
})
