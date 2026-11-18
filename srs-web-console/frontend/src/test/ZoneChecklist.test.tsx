import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ZoneChecklist } from '@/components/ZoneChecklist'
import { RuleColumn } from '@/pages/AlarmCenter/RuleColumn'
import AlarmWorkspace from '@/pages/AlarmCenter/AlarmWorkspace'
import { AlarmLinkContext, type AlarmRuleLink } from '@/pages/AlarmCenter/alarmLink'
import type { TriggerDefinition } from '@/features/alarmDefinitions'

vi.mock('@/pages/AlarmCenter/AlarmListPage', () => ({ default: () => <section>list</section> }))
vi.mock('@/pages/Analytics/AlarmAnalyticsPage', () => ({ default: () => <section>analysis</section> }))

const options = Array.from({ length: 8 }, (_, i) => ({ key: 'k' + i, name: '热区 ' + i, group: i < 4 ? '大门' : '后院' }))

it('a card picks its zones itself: all, several, or only one, and never none', () => {
  const change = vi.fn()
  const { rerender } = render(<ZoneChecklist label="门口 的热区" hint="关联热区" options={options.slice(0, 3)} chosen={new Set(['k0', 'k1', 'k2'])} onChange={change} />)
  const group = screen.getByRole('group', { name: '门口 的热区' })
  expect(group).toHaveTextContent('已选 3 / 3')
  expect(within(group).queryByRole('button', { name: '全选' })).toBeNull()
  fireEvent.click(within(group).getByRole('button', { name: '只看 热区 1' }))
  expect(change).toHaveBeenLastCalledWith(['k1'])
  fireEvent.click(within(group).getByRole('checkbox', { name: '热区 0' }))
  expect(change).toHaveBeenLastCalledWith(['k1', 'k2'])
  rerender(<ZoneChecklist label="门口 的热区" hint="关联热区" options={options.slice(0, 3)} chosen={new Set(['k1'])} onChange={change} />)
  // The last ticked zone stays: an empty choice would silently mean everything again.
  expect(within(group).getByRole('checkbox', { name: '热区 1' })).toBeDisabled()
  expect(within(group).queryByRole('button', { name: '只看 热区 1' })).toBeNull()
  fireEvent.click(within(group).getByRole('button', { name: '全选' }))
  expect(change).toHaveBeenLastCalledWith(['k0', 'k1', 'k2'])
})

it('many zones show six and fold the rest; zones are grouped by channel; a choice made elsewhere is named', () => {
  const clear = vi.fn()
  render(<ZoneChecklist label="全部规则 的热区" hint="热区" options={options} chosen={new Set(['k7'])} onChange={vi.fn()} outside={{ count: 2, clear }} />)
  const group = screen.getByRole('group', { name: '全部规则 的热区' })
  expect(within(group).getAllByRole('checkbox')).toHaveLength(6)
  expect(group).toHaveTextContent('大门'); expect(group).toHaveTextContent('后院')
  fireEvent.click(within(group).getByRole('button', { name: '展开其余 2 个' }))
  expect(within(group).getAllByRole('checkbox')).toHaveLength(8)
  expect(group).toHaveTextContent('另有 2 个已选位置')
  fireEvent.click(within(group).getByRole('button', { name: '清除其他已选位置' }))
  expect(clear).toHaveBeenCalled()
})

const usage = (a: string, p: string, z: string | null, n: string | null) => ({ assignment_id: a, source_id: 's', processor_id: p, zone_id: z, zone_name: n })
const rule = (id: string, name: string, usages: ReturnType<typeof usage>[]) => ({ trigger_id: id, name, state: 'enabled', behavior: 'region_enter', labels: [], version: 1, usages }) as unknown as TriggerDefinition
const door = rule('door', '门口闯入', [usage('1', 'gate', 'z1', '门口')])
const yard = rule('yard', '后院徘徊', [usage('2', 'yard', 'z2', '后院'), usage('3', 'gate', 'z1', '门口')])
const link = (over: Partial<AlarmRuleLink> = {}): AlarmRuleLink => ({ rule: null, choose: vi.fn(), periodLabel: '今天', counts: null, countsError: '', columnOpen: true, reload: 0, bump: vi.fn(), now: new Date(), refresh: vi.fn(), locations: null, setLocations: vi.fn(), ...over })

it('every rule at once offers the zones of every rule, even ones the rule-type filter hides', () => {
  const l = link()
  render(<RuleColumn link={l} rules={[door]} allRules={[door, yard]} details={() => null} menu={() => null} channelName={id => ({ gate: '大门', yard: '后院' }[id] ?? id)} />)
  const group = screen.getByRole('group', { name: '全部规则 的热区' })
  expect(within(group).getAllByRole('checkbox').map(b => b.getAttribute('aria-label') ?? b.closest('label')?.textContent)).toHaveLength(2)
  fireEvent.click(within(group).getByRole('button', { name: '只看 后院' }))
  expect(l.setLocations).toHaveBeenCalledWith([{ channel_id: 'yard', zone_id: 'z2' }])
})

const page = (l: AlarmRuleLink) => render(<MemoryRouter initialEntries={['/alarms']}><AlarmLinkContext.Provider value={l}><AlarmWorkspace layoutWidth={1300} /></AlarmLinkContext.Provider></MemoryRouter>)

it('with the rules column open, zones are picked on the cards; the page only says how many and offers to clear', () => {
  const l = link({ locations: [{ channel_id: 'gate', zone_id: 'z1' }] })
  page(l)
  expect(screen.queryByRole('group', { name: /告警位置/ })).toBeNull()
  expect(document.querySelector('summary[aria-label^="告警位置"]')).toBeNull()
  const chip = screen.getByRole('status', { name: '已选热区' })
  expect(chip).toHaveTextContent('已选 1 个热区')
  fireEvent.click(within(chip).getByRole('button', { name: '清除热区选择' }))
  expect(l.setLocations).toHaveBeenCalledWith(null)
})

it('with the rules column folded away, the page offers the zone choice itself', () => {
  page(link({ columnOpen: false }))
  expect(document.querySelector('summary[aria-label^="告警位置"]')).not.toBeNull()
})
