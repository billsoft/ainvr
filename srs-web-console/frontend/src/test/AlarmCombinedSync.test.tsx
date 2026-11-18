import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import AlarmAnalyticsPage from '@/pages/Analytics/AlarmAnalyticsPage'
import { AlarmLinkContext, type AlarmRuleLink } from '@/pages/AlarmCenter/alarmLink'
import { alarmEventService, type AlarmEvent } from '@/api/alarmEventService'
import { alarmAnalyticsService, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'

vi.mock('@/api/alarmEventService', () => ({ alarmEventService: { list: vi.fn(), get: vi.fn(), summary: vi.fn().mockResolvedValue({}), confirm: vi.fn() } }))
vi.mock('@/api/alarmAnalyticsService', async original => ({ ...await original<typeof import('@/api/alarmAnalyticsService')>(), alarmAnalyticsService: { query: vi.fn() } }))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/api/alarmTriggerService', () => ({ alarmTriggerService: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/alarmDefinitionService', () => ({ alarmDefinitionService: { list: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/api/alarmArmingService', () => ({ alarmArmingService: { read: vi.fn() } }))
vi.mock('@/api/behaviorStatisticsService', () => ({ behaviorStatisticsService: { query: vi.fn().mockResolvedValue({ items: [] }) } }))
vi.mock('@/components/PtzProtectionNotice', () => ({ PtzProtectionNotice: () => null }))
vi.mock('@/pages/AlarmCenter/AlarmRow', () => ({ AlarmRow: ({ alarm }: { alarm: AlarmEvent }) => <article>{alarm.alarm_id}</article> }))
vi.mock('@/pages/Analytics/AlarmAnalyticsMap', () => ({ AlarmAnalyticsMap: () => <div>map</div> }))

const at = '2026-11-18T08:00:00Z'
const alarm = (id: string): AlarmEvent => ({ alarm_id: id, trigger_id: 'door', channel_id: 'a', occurred_at: at, last_seen_at: at, behavior: 'region_enter', rule: { id: 'door@2', name: 'r' }, severity: 'warning', lifecycle: { state: 'ended' }, handling: { state: 'unacknowledged', revision: 0 }, stages: [] } as unknown as AlarmEvent)
// A period running up to now has no end: the list neither reloads each minute nor misses new alarms.
const period = { from: '2026-11-11T00:00:00.000Z', label: '近 7 天' }
const yesterday = { from: '2026-11-17T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z', label: '昨天' }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(alarmEventService.list).mockResolvedValue({ items: [], next_cursor: null, as_of: 'now' }) })

it('beside the analysis, handled alarms follow the page period; pending ones are never hidden by the clock', async () => {
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact period={period} /></MemoryRouter>)
  await waitFor(() => expect(alarmEventService.list).toHaveBeenCalled())
  expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]).not.toHaveProperty('from')
  expect(screen.queryByRole('combobox', { name: '时间' })).toBeNull()
  expect(screen.getByTitle('所有未审核告警，不受时段限制')).toHaveTextContent(/积压 .*条 · 不限时间/)
  fireEvent.click(screen.getByRole('button', { name: '已人工审核' }))
  await waitFor(() => expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![0]).toBe('human'))
  const filters = vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]!
  expect(filters.from).toBe(period.from)
  expect(filters).not.toHaveProperty('to')
  expect(screen.getByText(/近 7 天/)).toBeInTheDocument()
})

it('a period that already ended bounds handled alarms at both ends', async () => {
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact period={yesterday} /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '已人工审核' }))
  await waitFor(() => expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]).toMatchObject({ from: yesterday.from, to: yesterday.to }))
})

it('for one rule, handled alarms use the page period as the rule scope', async () => {
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact period={yesterday} rule="door" ruleName="门口" /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '全部' }))
  await waitFor(() => expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![0]).toBe('all'))
  const scope = JSON.parse(vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]!.analytics!)
  expect(scope).toMatchObject({ from: yesterday.from, to: yesterday.to, trigger_id: 'door' })
})

it('confirming alarms tells the page, so the numbers beside the list change with it', async () => {
  vi.mocked(alarmEventService.list).mockResolvedValue({ items: [alarm('x1')], next_cursor: null, as_of: 'now' })
  vi.mocked(alarmEventService.confirm).mockResolvedValue({ items: [{ alarm_id: 'x1', outcome: 'succeeded' }] } as never)
  const changed = vi.fn()
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact period={period} onChanged={changed} /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /全部确认/ }))
  fireEvent.click(screen.getByRole('button', { name: '确认这 1 条' }))
  await waitFor(() => expect(changed).toHaveBeenCalled())
})

const result = (total: number) => ({ schema_version: '1.0', from: at, to: at, as_of: at, timezone: 'Asia/Shanghai', bucket: 'hour', total, pending: 0, human_confirmed: 0, human_false_positive: 0, ai_reviewed: 0, unknown_review: 0, trend: [], zones: [], triggers: [], types: [], business_kinds: [], week: Array.from({ length: 7 }, () => Array(24).fill(0)), quality: { human_reviewed: 0, false_positive_ratio: null, wait: { samples: 0, median_ms: null, p90_ms: null, unknown: 0 }, pending_age: { lt10m: 0, lt1h: 0, gte1h: 0 } }, association: { unassociated: 0 }, catalog: { zones: [], triggers: [], types: [] }, consistency: 'non_transactional', coverage: 'unknown', issues: [] }) as unknown as AlarmAnalyticsResult
const link = (over: Partial<AlarmRuleLink>): AlarmRuleLink => ({ rule: null, choose: vi.fn(), periodLabel: '今天', counts: null, countsError: '', columnOpen: true, reload: 0, bump: vi.fn(), now: new Date('2026-11-18T08:00:00Z'), refresh: vi.fn(), locations: null, setLocations: vi.fn(), ...over })

it('the analysis counts up to the same moment as the rules column and refreshes with it, keeping its numbers on screen', async () => {
  vi.mocked(alarmAnalyticsService.query).mockResolvedValue(result(5))
  const page = (l: AlarmRuleLink) => <MemoryRouter initialEntries={['/alarms?range=today&compare=0']}><AlarmLinkContext.Provider value={l}><AlarmAnalyticsPage triggerId={null} compact /></AlarmLinkContext.Provider></MemoryRouter>
  const { rerender } = render(page(link({})))
  await screen.findByRole('link', { name: /范围内新增告警 5条/ })
  expect(vi.mocked(alarmAnalyticsService.query).mock.calls[0]![0].to).toBe('2026-11-18T08:00:00.000Z')
  vi.mocked(alarmAnalyticsService.query).mockResolvedValue(result(6))
  rerender(page(link({ reload: 1, now: new Date('2026-11-18T08:01:00Z') })))
  // While the new numbers load, the old ones stay instead of a loading screen.
  expect(screen.queryByText(/正在查询/)).toBeNull()
  await screen.findByRole('link', { name: /范围内新增告警 6条/ })
  expect(vi.mocked(alarmAnalyticsService.query).mock.calls.at(-1)![0].to).toBe('2026-11-18T08:01:00.000Z')
})

it('beside the list the analysis carries no second period or business control', async () => {
  vi.mocked(alarmAnalyticsService.query).mockResolvedValue(result(5))
  render(<MemoryRouter initialEntries={['/alarms?range=today']}><AlarmLinkContext.Provider value={link({})}><AlarmAnalyticsPage triggerId={null} compact /></AlarmLinkContext.Provider></MemoryRouter>)
  await screen.findByRole('link', { name: /范围内新增告警 5条/ })
  expect(screen.queryByRole('button', { name: '今天' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '告警业务类别' })).toBeNull()
  expect(screen.getByRole('button', { name: '导出 CSV' })).toBeInTheDocument()
})

it('with the page business type the list has no business filter of its own and asks for that type', async () => {
  render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage compact period={period} businessKind="fire_smoke" /></MemoryRouter>)
  await waitFor(() => expect(vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]).toMatchObject({ event_kind: 'fire_smoke' }))
  expect(screen.queryByRole('combobox', { name: '告警业务类型' })).toBeNull()
})
