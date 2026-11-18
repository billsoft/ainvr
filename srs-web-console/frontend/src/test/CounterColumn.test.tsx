import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Counter, CounterResult } from '@/api/flowService'
import { AnalyticsLinkContext, type AnalyticsLink, type CounterSelection } from '@/pages/Analytics/analyticsLinkContext'

vi.mock('@/api/flowService', async original => ({ ...(await original<typeof import('@/api/flowService')>()), flowService: { list: vi.fn(), save: vi.fn(), query: vi.fn(), records: vi.fn(), live: vi.fn(), remove: vi.fn() } }))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/api/channelService', () => ({ channelService: { list: vi.fn().mockResolvedValue([]) } }))
const { flowService } = await import('@/api/flowService')
const { default: FlowPage } = await import('@/pages/Flow')

const counter = (id: string, name: string, processor = 'ai', labels = [{ label_id: 'person', name: 'person' }]): Counter => ({
  counter_id: id, name, labels, method: 'line', outputs: 'both', names: { in: '进', out: '出' }, occupancy: false, max_gap_ms: 1000, state: 'enabled', version: 1,
  bindings: [
    { binding_id: id + '-door', source_id: 'cam', processor_id: processor, zone_id: 'z1', zone_name: '门口', active: true, counting: true, direction: { kind: 'line', edge: 'b', in_side: 'inward' } },
    { binding_id: id + '-hall', source_id: 'cam', processor_id: processor, zone_id: 'z2', zone_name: '大厅', active: true, counting: true, direction: { kind: 'line', edge: 'b', in_side: 'inward' } },
  ],
})
// Same target, method and directions on another camera: still the same measure, so it can be totalled.
const a = counter('a', '大门客流'), b = counter('b', '车间客流', 'other-camera'), car = counter('car', '车辆进出', 'ai', [{ label_id: 'car', name: 'car' }])
const zone = (c: Counter, id: string, n: number) => ({ ...c.bindings.find(x => x.binding_id === id)!, in: { occurrences: n, tracked_targets: n, coverage: { state: 'complete' }, buckets: [] }, out: { occurrences: n - 1, tracked_targets: n, coverage: { state: 'complete' }, buckets: [] } })
const total = (c: Counter, inn: number, out: number) => ({ counter: c, in: { occurrences: inn, buckets: [], coverage: 'complete' }, out: { occurrences: out, buckets: [], coverage: 'complete' }, zones: [zone(c, c.counter_id + '-door', 5), zone(c, c.counter_id + '-hall', 4)] }) as unknown as CounterResult
const item = total(a, 9, 7)

const selection = (over: Partial<CounterSelection> = {}): CounterSelection => ({
  ids: ['a'], choice: { kind: 'counter', id: 'a' }, choose: vi.fn(), counters: [a, b], bindings: ['a-door'], toggleBinding: vi.fn(), items: [item],
  totals: [item, total(b, 21, 15)], previousTotals: null, compareLabel: null, summary: null,
  range: { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z', label: '今天' }, openRecords: vi.fn(), ...over,
})
const link = (over: Partial<AnalyticsLink> = {}): AnalyticsLink => ({ reload: 0, bump: vi.fn(), selection: null, publish: vi.fn(), columnOpen: true, ...over })
const mount = (value: AnalyticsLink) => render(<MemoryRouter><AnalyticsLinkContext.Provider value={value}><FlowPage variant="manage" /></AnalyticsLinkContext.Provider></MemoryRouter>)

beforeEach(() => {
  vi.mocked(flowService.list).mockReset().mockResolvedValue({ items: [a, b] } as never)
  vi.mocked(flowService.query).mockReset().mockResolvedValue({ items: [] } as never)
})

it('beside the analysis it never queries numbers or offers its own time range', async () => {
  mount(link({ selection: selection() }))
  expect(await screen.findByRole('article', { name: '大门客流' })).toBeInTheDocument()
  expect(flowService.query).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: '时间范围' })).toBeNull()
  expect(screen.getByText(/数量按“统计分析”里选的时段：今天/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /新建统计/ })).toBeInTheDocument()
  expect(screen.queryByText(new RegExp('计数'+'器'))).toBeNull()
})

it('every statistic is one choice with its own period numbers; picking one drives the analysis', async () => {
  const sel = selection()
  mount(link({ selection: sel }))
  const group = await screen.findByRole('radiogroup', { name: '选择统计' })
  const mine = within(group).getByRole('radio', { name: /大门客流/ })
  expect(mine).toHaveAttribute('aria-checked', 'true')
  expect(mine).toHaveTextContent('进 9')
  const other = within(group).getByRole('radio', { name: /车间客流/ })
  expect(other).toHaveAttribute('aria-checked', 'false')
  expect(other).toHaveTextContent('进 21')
  expect(other).toHaveTextContent('出 15')
  await userEvent.click(other)
  expect(sel.choose).toHaveBeenCalledWith({ kind: 'counter', id: 'b' })
  expect(screen.queryByRole('checkbox', { name: '纳入分析' })).toBeNull()
})

it('same measures on different cameras can be totalled; the total sums their numbers', async () => {
  const sel = selection()
  mount(link({ selection: sel }))
  const sum = await screen.findByRole('radio', { name: /合计/ })
  expect(sum).toHaveTextContent('2 个统计')
  expect(sum).toHaveTextContent('进 30')
  expect(sum).toHaveTextContent('出 22')
  await userEvent.click(sum)
  expect(sel.choose).toHaveBeenCalledWith(expect.objectContaining({ kind: 'total' }))
})

it('a different target is never folded into another total', async () => {
  mount(link({ selection: selection({ counters: [a, car], totals: [item, total(car, 3, 2)] }) }))
  await screen.findByRole('radio', { name: /车辆进出/ })
  expect(screen.queryByRole('radio', { name: /合计/ })).toBeNull()
})

it('only the chosen statistic lists its locations with the analysis numbers', async () => {
  const sel = selection()
  mount(link({ selection: sel }))
  const card = await screen.findByRole('article', { name: '大门客流' })
  expect(within(card).getByRole('checkbox', { name: /门口/ })).toBeChecked()
  expect(within(card).getByRole('checkbox', { name: /大厅/ })).not.toBeChecked()
  await userEvent.click(within(card).getByRole('checkbox', { name: /大厅/ }))
  expect(sel.toggleBinding).toHaveBeenCalledWith('a-hall')
  await userEvent.click(within(card).getAllByRole('button', { name: /的进记录/ })[0]!)
  expect(sel.openRecords).toHaveBeenCalledWith('a', 'a-door', 'in')
  const other = screen.getByRole('article', { name: '车间客流' })
  expect(within(other).queryByRole('checkbox')).toBeNull()
})

it('management actions sit in a per-card menu and a change tells the analysis to reload', async () => {
  const bump = vi.fn()
  vi.mocked(flowService.remove).mockResolvedValue(undefined as never)
  mount(link({ bump, selection: selection() }))
  const card = await screen.findByRole('article', { name: '大门客流' })
  expect(within(card).queryByRole('button', { name: /^删除$/ })).toBeNull()
  await userEvent.click(within(card).getByRole('button', { name: '大门客流 更多操作' }))
  expect(within(card).getByRole('menuitem', { name: /编辑/ })).toBeInTheDocument()
  expect(within(card).getByRole('menuitem', { name: /暂停/ })).toBeInTheDocument()
  await userEvent.click(within(card).getByRole('menuitem', { name: /删除/ }))
  await userEvent.click(await screen.findByRole('button', { name: '删除统计及历史' }))
  await waitFor(() => expect(bump).toHaveBeenCalled())
})

it('the chosen card carries the overview: large numbers, change, peak and net; other cards show their change too', async () => {
  mount(link({ selection: selection({
    previousTotals: [total(a, 9, 7), total(b, 20, 15)], compareLabel: '昨天同时段',
    summary: { peak: { label: '08:00–09:00', value: 5, complete: true }, net: 2, perHour: null, unit: '人次', change: { in: '↑ 12.5%', out: null },
      trend: { bucket: 'hour', slots: [{ from: '2026-11-18T00:00:00Z', to: '2026-11-18T01:00:00Z' }], label: '进与出趋势', complete: [true], reference: null, series: [{ name: '进', color: '#16a34a', values: [5] }] } },
  }) }))
  const mine = await screen.findByRole('radio', { name: /大门客流/ })
  expect(within(mine).getByLabelText('概览')).toHaveTextContent('高峰08:00–09:00')
  expect(within(mine).getByLabelText('概览')).toHaveTextContent('净流入+2')
  expect(mine).toHaveTextContent('↑ 12.5%')
  const other = screen.getByRole('radio', { name: /车间客流/ })
  expect(other).toHaveTextContent('↑ 5.0%')
  expect(within(other).queryByLabelText('概览')).toBeNull()
  expect(screen.getByText(/箭头为较昨天同时段/)).toBeInTheDocument()
  // The trend moved from the middle onto the chosen card; other cards stay compact.
  expect(within(screen.getByRole('article', { name: '大门客流' })).getByLabelText('通行趋势')).toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: '车间客流' })).queryByLabelText('通行趋势')).toBeNull()
})
