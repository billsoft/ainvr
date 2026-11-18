import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { RuleColumn, ruleZones } from '@/pages/AlarmCenter/RuleColumn'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import { chooseRuleSearch, drillSearch, type AlarmRuleLink } from '@/pages/AlarmCenter/alarmLink'
import { alarmEventService } from '@/api/alarmEventService'
import type { TriggerDefinition } from '@/features/alarmDefinitions'

vi.mock('@/api/alarmEventService', () => ({ alarmEventService: { list: vi.fn(), get: vi.fn(), summary: vi.fn().mockResolvedValue({}), confirm: vi.fn() } }))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { list: vi.fn().mockResolvedValue([{ id: 'a', name: 'A' }]) } }))
vi.mock('@/api/alarmTriggerService', () => ({ alarmTriggerService: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/alarmDefinitionService', () => ({ alarmDefinitionService: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/alarmArmingService', () => ({ alarmArmingService: { read: vi.fn() } }))
vi.mock('@/api/behaviorStatisticsService', () => ({ behaviorStatisticsService: { query: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/components/PtzProtectionNotice', () => ({ PtzProtectionNotice: () => null }))

const usage = (assignment: string, processor: string, zone: string | null, name: string | null) => ({ assignment_id: assignment, source_id: 's-' + processor, processor_id: processor, zone_id: zone, zone_name: name })
const door = { trigger_id: 'door', name: '门口闯入', state: 'enabled', behavior: 'region_enter', labels: [], version: 1,
  usages: [usage('1', 'gate-ai', 'z1', '热区 2'), usage('2', 'gate-ai', 'z1', '热区 2'), usage('3', 'yard-ai', 'z2', '热区 2'), usage('4', 'yard-ai', null, null)] } as unknown as TriggerDefinition
const link = (over: Partial<AlarmRuleLink> = {}): AlarmRuleLink => ({ rule: 'door', choose: vi.fn(), periodLabel: '今天', counts: null, countsError: '', columnOpen: true, reload: 0, bump: vi.fn(),
  now: new Date(), refresh: vi.fn(), locations: null, setLocations: vi.fn(), ...over })
const names: Record<string, string> = { 'gate-ai': '大门', 'yard-ai': '后院' }

beforeEach(() => { vi.clearAllMocks(); vi.mocked(alarmEventService.list).mockResolvedValue({ items: [], next_cursor: null, as_of: 'now' }) })

it('a rule lists each zone it watches once, named with its channel; a whole-frame use is not a zone', () => {
  expect(ruleZones(door)).toEqual({ zones: [{ channel_id: 'gate-ai', zone_id: 'z1', name: '热区 2' }, { channel_id: 'yard-ai', zone_id: 'z2', name: '热区 2' }], wholeFrame: 1 })
})

it('the chosen rule opens its zones, all ticked; unticking narrows both halves to the rest, ticking all again clears it', () => {
  const l = link()
  const { rerender } = render(<RuleColumn link={l} rules={[door]} details={() => null} menu={() => null} channelName={id => names[id] ?? id} />)
  const group = screen.getByRole('group', { name: '门口闯入 的热区' })
  const boxes = within(group).getAllByRole('checkbox')
  expect(boxes.map(b => (b as HTMLInputElement).checked)).toEqual([true, true])
  expect(group).toHaveTextContent('大门'); expect(group).toHaveTextContent('后院')
  expect(screen.getByRole('article', { name: '门口闯入' })).toHaveTextContent('整个画面 1 处')
  fireEvent.click(boxes[0]!)
  expect(l.setLocations).toHaveBeenCalledWith([{ channel_id: 'yard-ai', zone_id: 'z2' }])
  const narrowed = link({ locations: [{ channel_id: 'yard-ai', zone_id: 'z2' }] })
  rerender(<RuleColumn link={narrowed} rules={[door]} details={() => null} menu={() => null} channelName={id => names[id] ?? id} />)
  const again = within(screen.getByRole('group', { name: '门口闯入 的热区' })).getAllByRole('checkbox')
  expect(again.map(b => (b as HTMLInputElement).checked)).toEqual([false, true])
  fireEvent.click(again[0]!)
  expect(narrowed.setLocations).toHaveBeenCalledWith(null)
})

it('choosing another rule leaves the zones of the last one', () => {
  const next = chooseRuleSearch(new URLSearchParams('rule=door&alarm_locations=x&alarm_scope_origin=flow&range=7d&analytics_scope=y'), 'gate')
  expect(Object.fromEntries(next)).toEqual({ rule: 'gate', range: '7d' })
  expect(chooseRuleSearch(new URLSearchParams('rule=door'), null).has('rule')).toBe(false)
})

it('a zone drill-down chooses that zone for the whole page instead of freezing a list scope', () => {
  const scope = { from: 'a', to: 'b', timezone: 'Asia/Shanghai', bucket: 'hour', trigger_id: 'door', locations: [{ channel_id: 'gate-ai', zone_id: 'z1' }] }
  const next = drillSearch(new URLSearchParams('rule=door&range=7d'), '/alarms?status=all&analytics_scope=' + encodeURIComponent(JSON.stringify(scope)))!
  expect(JSON.parse(next.get('alarm_locations')!)).toEqual(scope.locations)
  expect(next.has('analytics_scope')).toBe(false)
  expect(next.get('range')).toBe('7d')
  // A time slot is not a zone: it still scopes the list.
  const slot = drillSearch(new URLSearchParams('rule=door'), '/alarms?status=all&analytics_scope=' + encodeURIComponent(JSON.stringify({ ...scope, locations: undefined, weekday: 1, hour: 9 })))!
  expect(slot.has('analytics_scope')).toBe(true)
})

it('the list follows the chosen zones and has no channel filter of its own', async () => {
  const locations = [{ channel_id: 'yard-ai', zone_id: 'z2' }]
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact locations={locations} /></MemoryRouter>)
  await waitFor(() => expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]).toMatchObject({ locations }))
  expect(screen.queryByRole('combobox', { name: '通道' })).toBeNull()
})
