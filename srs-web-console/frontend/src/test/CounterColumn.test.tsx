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

const counter = (id: string, name: string): Counter => ({
  counter_id: id, name, labels: [{ label_id: 'person', name: 'person' }], method: 'line', outputs: 'both', names: { in: '进', out: '出' }, occupancy: false, max_gap_ms: 1000, state: 'enabled', version: 1,
  bindings: [
    { binding_id: id + '-door', source_id: 'cam', processor_id: 'ai', zone_id: 'z1', zone_name: '门口', active: true, counting: true, direction: { kind: 'line', edge: 'b', in_side: 'inward' } },
    { binding_id: id + '-hall', source_id: 'cam', processor_id: 'ai', zone_id: 'z2', zone_name: '大厅', active: true, counting: true, direction: { kind: 'line', edge: 'b', in_side: 'inward' } },
  ],
})
const a = counter('a', '大门客流'), b = counter('b', '车间客流')
const zone = (id: string, n: number) => ({ ...a.bindings.find(x => x.binding_id === id)!, in: { occurrences: n, tracked_targets: n, coverage: { state: 'complete' }, buckets: [] }, out: { occurrences: n - 1, tracked_targets: n, coverage: { state: 'complete' }, buckets: [] } })
const item = { counter: a, in: { occurrences: 9, buckets: [], coverage: 'complete' }, out: { occurrences: 7, buckets: [], coverage: 'complete' }, zones: [zone('a-door', 5), zone('a-hall', 4)] } as unknown as CounterResult

const selection = (over: Partial<CounterSelection> = {}): CounterSelection => ({
  ids: ['a'], canSelect: id => id === 'a', toggle: vi.fn(), counters: [a, b], bindings: ['a-door'], toggleBinding: vi.fn(), items: [item],
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
  expect(screen.getByText(/数量按“数据分析”里选的时段：今天/)).toBeInTheDocument()
})

it('a ticked counter lists its locations with the analysis numbers; ticking one drives the analysis', async () => {
  const sel = selection()
  mount(link({ selection: sel }))
  const card = await screen.findByRole('article', { name: '大门客流' })
  expect(within(card).getByRole('checkbox', { name: '纳入分析' })).toBeChecked()
  expect(within(card).getByRole('checkbox', { name: /门口/ })).toBeChecked()
  expect(within(card).getByRole('checkbox', { name: /大厅/ })).not.toBeChecked()
  await userEvent.click(within(card).getByRole('checkbox', { name: /大厅/ }))
  expect(sel.toggleBinding).toHaveBeenCalledWith('a-hall')
  await userEvent.click(within(card).getAllByRole('button', { name: /的进记录/ })[0]!)
  expect(sel.openRecords).toHaveBeenCalledWith('a', 'a-door', 'in')
})

it('an incompatible counter explains why it cannot be analysed together and stays disabled', async () => {
  mount(link({ selection: selection() }))
  const card = await screen.findByRole('article', { name: '车间客流' })
  expect(within(card).getByRole('checkbox', { name: '纳入分析' })).toBeDisabled()
  expect(within(card).getByText(/口径与已纳入的计数器不同/)).toBeInTheDocument()
})

it('a counter change tells the analysis to reload its counters', async () => {
  const bump = vi.fn()
  // The save session binds the real service, so the delete path is the one that can be observed here.
  vi.mocked(flowService.remove).mockResolvedValue(undefined as never)
  mount(link({ bump }))
  await screen.findByRole('article', { name: '大门客流' })
  await userEvent.click(screen.getAllByRole('button', { name: /删除/ })[0]!)
  await userEvent.click(await screen.findByRole('button', { name: '删除计数器及历史' }))
  await waitFor(() => expect(bump).toHaveBeenCalled())
})
