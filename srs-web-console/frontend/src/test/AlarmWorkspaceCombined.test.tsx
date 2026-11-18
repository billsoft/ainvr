import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AlarmWorkspace from '@/pages/AlarmCenter/AlarmWorkspace'
import { AlarmLinkContext, drillSearch, type AlarmRuleLink } from '@/pages/AlarmCenter/alarmLink'

const listProps = vi.fn(), analysisProps = vi.fn()
vi.mock('@/pages/AlarmCenter/AlarmListPage', () => ({ default: (p: Record<string, unknown>) => { listProps(p); return <section aria-label="告警列表区">list</section> } }))
vi.mock('@/pages/Analytics/AlarmAnalyticsPage', () => ({ default: (p: Record<string, unknown>) => { analysisProps(p); return <section aria-label="告警分析区"><a href="/alarms?status=all&analytics_scope=%7B%22trigger_id%22%3A%22door%22%7D">drill</a></section> } }))

function Where() { const l = useLocation(); return <output aria-label="地址">{l.search}</output> }
const link = (over: Partial<AlarmRuleLink> = {}): AlarmRuleLink => ({
  rule: 'door', choose: vi.fn(), periodLabel: '近 7 天', counts: null, countsError: '', columnOpen: true, reload: 0, bump: vi.fn(),
  now: new Date('2026-11-18T08:00:00Z'), refresh: vi.fn(), locations: null, setLocations: vi.fn(), ...over,
})
const show = (width: number, search = '?rule=door&range=7d', l = link()) => render(<MemoryRouter initialEntries={['/alarms' + search]}>
  <AlarmLinkContext.Provider value={l}><AlarmWorkspace layoutWidth={width} /><Where /></AlarmLinkContext.Provider></MemoryRouter>)

beforeEach(() => { listProps.mockClear(); analysisProps.mockClear() })

it('on a wide screen the list and the analysis share one page, without a view switch', () => {
  show(1300)
  expect(screen.getByRole('region', { name: '告警列表区' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '告警分析区' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: '告警视图' })).toBeNull()
  // The list follows the page period for handled alarms, compact, and tells the page when it changed alarms.
  const p = listProps.mock.calls.at(-1)![0]
  expect(p.compact).toBe(true)
  expect(p.period).toMatchObject({ label: '近 7 天' })
  expect(p.rule).toBe('door')
  expect(analysisProps.mock.calls.at(-1)![0]).toMatchObject({ triggerId: 'door', compact: true })
})

it('even an old link to the analysis view shows both on a wide screen', () => {
  show(1300, '?rule=door&view=analysis')
  expect(screen.getByRole('region', { name: '告警列表区' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '告警分析区' })).toBeInTheDocument()
})

it('on a narrower screen the switch stays and shows one view at a time', () => {
  show(900)
  expect(screen.getByRole('group', { name: '告警视图' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '告警列表区' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '告警分析区' })).toBeNull()
  expect(listProps.mock.calls.at(-1)![0].compact).toBeFalsy()
})

it('a drill-down from the analysis filters the list beside it and keeps the rule and the period', async () => {
  show(1300, '?rule=door&range=7d&compare=0')
  fireEvent.click(screen.getByRole('link', { name: 'drill' }))
  await waitFor(() => expect(screen.getByRole('status', { name: '地址' }).textContent).toContain('analytics_scope'))
  const p = new URLSearchParams(screen.getByRole('status', { name: '地址' }).textContent!)
  expect(p.get('rule')).toBe('door')
  expect(p.get('range')).toBe('7d')
  expect(p.get('compare')).toBe('0')
  expect(p.get('status')).toBe('all')
  expect(JSON.parse(p.get('analytics_scope')!)).toEqual({ trigger_id: 'door' })
})

it('drill-down search: only the list scope keys change; other pages and new-tab clicks are left alone', () => {
  const old = new URLSearchParams('rule=door&range=7d&afrom=a&ato=b&from=x&to=y&locations=z&view=analysis')
  const next = drillSearch(old, '/alarms?status=all&analytics_scope=%7B%7D')!
  expect(Object.fromEntries(next)).toEqual({ rule: 'door', range: '7d', afrom: 'a', ato: 'b', status: 'all', analytics_scope: '{}' })
  expect(drillSearch(old, '/channels')).toBeNull()
  expect(drillSearch(old, '/alarms?rule=x')).toBeNull()
})

it('the page has one toolbar: period, comparison and business type, and the list follows the business type', async () => {
  show(1300, '?rule=door&range=7d')
  const bar = screen.getByRole('toolbar', { name: '告警分析条件' })
  expect(within(bar).getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(within(bar).getByRole('combobox', { name: '告警业务类别' }), { target: { value: 'fire_smoke' } })
  await waitFor(() => expect(new URLSearchParams(screen.getByRole('status', { name: '地址' }).textContent!).get('event_kind')).toBe('fire_smoke'))
  expect(listProps.mock.calls.at(-1)![0].businessKind).toBe('fire_smoke')
})
