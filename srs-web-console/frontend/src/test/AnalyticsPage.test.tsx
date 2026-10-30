import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import AnalyticsPage from '@/pages/Analytics'
import { channelService } from '@/api/channelService'
import { aiChannelService } from '@/api/aiChannelService'
import { alarmTriggerService } from '@/api/alarmTriggerService'
import { alarmArmingService } from '@/api/alarmArmingService'
import { flowService } from '@/api/flowService'
import {
  deltaOf, insightsOf, peakOf, sampleSource, slotTotals, toCsv, totalsOf,
  type AnalyticsData, type AnalyticsScope,
} from '@/pages/Analytics/analyticsSource'

vi.mock('@/api/channelService', () => ({ channelService: { list: vi.fn() } }))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { list: vi.fn() } }))
vi.mock('@/api/alarmTriggerService', () => ({ alarmTriggerService: { source: vi.fn() } }))
vi.mock('@/api/alarmArmingService', () => ({ alarmArmingService: { read: vi.fn() } }))
vi.mock('@/api/flowService', async original => ({ ...await original<typeof import('@/api/flowService')>(), flowService: { list: vi.fn(), query: vi.fn() } }))
vi.mock('@/pages/Analytics/plan/PlanCanvas', () => ({ PlanCanvas: (p: { heat?: number[][]; readOnly?: boolean }) => <div data-testid="plan-canvas" data-heat={p.heat ? p.heat.flat().reduce((a, b) => a + b, 0).toFixed(3) : 'none'} /> }))
const zoneOf = (id: string, name: string) => ({ zone_id: id, name, points: [], edge_ids: [], version: 1 })
const usage = (zone_id: string) => ({ binding_id: `b-${zone_id}`, source_id: 's', processor_id: 'p', zone_id, zone_name: null, active: true, counting: true, direction: { kind: 'line', edge: 'e', in_side: 'inward' } })
const counterOf = (id: string, name: string, zone: string) => ({ counter_id: id, name, labels: [], method: 'line', outputs: 'both', names: { in: '进', out: '出' }, occupancy: false, max_gap_ms: 0, state: 'enabled', version: 1, bindings: [usage(zone)] })
const series = (n: number) => ({ occurrences: n, tracked_targets: 0, coverage: { state: 'complete' }, buckets: [] })

const day = 86400000
function scope(over: Partial<AnalyticsScope> = {}): AnalyticsScope {
  const to = new Date(2026, 9, 30, 12, 0, 0), from = new Date(2026, 9, 24, 0, 0, 0)
  return { channelIds: ['a', 'b'], from, to, bucket: 'day', compareLabel: '前 7 天',
    previous: { from: new Date(from.getTime() - 7 * day), to: new Date(to.getTime() - 7 * day) }, ...over }
}
const renderPage = (url = '/analytics') => render(<MemoryRouter initialEntries={[url]}><AnalyticsPage /></MemoryRouter>)
beforeEach(() => {
  vi.mocked(channelService.list).mockResolvedValue([
    { id: 'a', name: '后门8K全景AI输出' }, { id: 'b', name: '大门口' }, { id: 'c', name: '小门' },
  ] as never)
  vi.mocked(aiChannelService.list).mockResolvedValue([{ id: 'ai1', name: '后门' }] as never)
  vi.mocked(alarmTriggerService.source).mockResolvedValue({ channel_id: 'ai1', input_stream_id: 'in1' } as never)
  vi.mocked(alarmArmingService.read).mockResolvedValue({ arming: { source_id: 'in1', processor_id: 'ai1', zones: [zoneOf('za', '一厅A口'), zoneOf('zb', '二厅B口')], assignments: [] } } as never)
  const c1 = counterOf('c1', '一厅人数', 'za'), c2 = counterOf('c2', '二厅人数', 'zb')
  vi.mocked(flowService.list).mockResolvedValue({ items: [c1, c2] } as never)
  vi.mocked(flowService.query).mockResolvedValue({ from: '', to: '', items: [
    { counter: c1, in: series(30), out: series(10), zones: [{ ...usage('za'), in: series(30), out: series(10) }] },
    { counter: c2, in: series(5), out: series(5), zones: [{ ...usage('zb'), in: series(5), out: series(5) }] },
  ] } as never)
  localStorage.clear()
})

// ---- 数据口径：示例数字必须互相对得上 ----
it('overview totals equal the sum of the trend and the peak equals its maximum', async () => {
  const data = await sampleSource.load(scope())
  const slots = slotTotals(data), totals = totalsOf(data)
  expect(slots.reduce((n, v) => n + v, 0)).toBe(totals.in)
  const peak = peakOf(data)
  expect(peak.value).toBe(Math.max(...slots))
  expect(slots[peak.index]).toBe(peak.value)
  expect(insightsOf(data).join('\n')).toContain(peak.label)
})
it('is deterministic for the same scope and differs between channels', async () => {
  const one = await sampleSource.load(scope()), again = await sampleSource.load(scope())
  expect(again).toEqual(one)
  const other = await sampleSource.load(scope({ channelIds: ['b', 'c'] }))
  expect(totalsOf(other).in).not.toBe(totalsOf(one).in)
})
it('never compares with a previous period that has no coverage and names the comparison period', async () => {
  const old = await sampleSource.load(scope({ previous: { from: new Date(2020, 0, 1), to: new Date(2020, 0, 8) } }))
  expect(old.previous).toBeNull()
  expect(deltaOf(100, old.previous?.in ?? null)).toBeNull()
  expect(deltaOf(120, 100)).toBeCloseTo(20)
  expect(deltaOf(5, 0)).toBeNull()
  expect(insightsOf(old).join('')).not.toMatch(/较/)
  const covered = await sampleSource.load(scope({ previous: { from: new Date(Date.now() - 8 * day), to: new Date(Date.now() - day) } }))
  expect(insightsOf(covered).join('')).toMatch(/较前 7 天/)
})
it('marks sample exports from the data source and not from the page', async () => {
  const data = await sampleSource.load(scope())
  const names = { a: '后门', b: '大门口' }
  const csv = toCsv(data, names)
  expect(csv.split(/\r?\n/)[0]).toContain('示例数据')
  expect(csv).toContain('时段起,通道,进入,离开')
  const live: AnalyticsData = { ...data, provenance: 'live' }
  expect(toCsv(live, names)).not.toContain('示例数据')
})

// ---- 页面：仪表盘 ----
it('keeps the sample marker always visible and tags each panel with where real data comes from', async () => {
  renderPage()
  expect(await screen.findByRole('heading', { name: '统计分析' })).toBeInTheDocument()
  const note = await screen.findByRole('note', { name: '数据来源说明' })
  expect(note).toHaveTextContent('示例数据')
  expect(note.getAttribute('title')).toMatch(/不代表真实客流/)
  expect(screen.getAllByText('可接入现有计数').length).toBeGreaterThan(0)
  expect(await screen.findByText('真实计数')).toBeInTheDocument()
  expect(screen.getByText('需新增采集')).toBeInTheDocument()
  expect(screen.getByText('待验证')).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/海康|大华/)
})
it('shows every panel on the overview tab and moves detail into tabs instead of scrolling', async () => {
  renderPage()
  const tabs = await screen.findByRole('tablist', { name: '统计视图' })
  expect(within(tabs).getAllByRole('tab').map(t => t.textContent)).toEqual(['总览', '客流', '热区', '规律'])
  expect(within(tabs).getByRole('tab', { name: '总览' })).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByRole('region', { name: '客流趋势' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '热区分布' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '星期与小时规律' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '统计覆盖' })).toBeInTheDocument()
  fireEvent.click(within(tabs).getByRole('tab', { name: '规律' }))
  expect(await screen.findByRole('region', { name: '星期与小时规律' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '热区分布' })).not.toBeInTheDocument()
  fireEvent.click(within(tabs).getByRole('tab', { name: '热区' }))
  expect(await screen.findByRole('region', { name: '热区分布' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '客流趋势' })).not.toBeInTheDocument()
})
it('restores the tab and period from the address', async () => {
  renderPage('/analytics?tab=heat&range=7d')
  expect(await screen.findByRole('tab', { name: '热区' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
})
it('names the comparison period and the freshness instead of a generic refresh', async () => {
  renderPage()
  const card = await screen.findByRole('group', { name: '进入人次' })
  await waitFor(() => expect(card.textContent).toMatch(/较昨天同时段|昨天同时段无统计覆盖/))
  expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  expect(screen.getByText(/更新于 \d{2}:\d{2}/)).toBeInTheDocument()
})
it('switching the period updates the overview and asks the counters again for the new range', async () => {
  renderPage()
  const peak = await screen.findByLabelText('高峰时段')
  expect(peak.textContent).toMatch(/时/)
  const before = vi.mocked(flowService.query).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '近 7 天' }))
  expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(screen.getByLabelText('高峰时段').textContent).toMatch(/周[一二三四五六日]/))
  await waitFor(() => expect(vi.mocked(flowService.query).mock.calls.length).toBeGreaterThan(before))
})
it('ranks the real zones by their counted passages with the counters that use them, and highlights a tapped row', async () => {
  renderPage()
  const table = await screen.findByRole('table', { name: '热区排名' })
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows.map(r => r.querySelectorAll('td')[1]!.textContent)).toEqual(['一厅A口', '二厅B口'])
  const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map(c => c.textContent)
  expect(cells(rows[0]!)).toEqual(['1', '一厅A口', '一厅人数', '30', '10', '80%'])
  expect(cells(rows[1]!)).toEqual(['2', '二厅B口', '二厅人数', '5', '5', '20%'])
  fireEvent.click(rows[1]!)
  expect(rows[1]).toHaveAttribute('aria-current', 'true')
  expect(rows[0]).not.toHaveAttribute('aria-current')
})
it('still shows the zones and says so when the counts could not be read', async () => {
  vi.mocked(flowService.query).mockRejectedValue(new Error('boom'))
  renderPage()
  const table = await screen.findByRole('table', { name: '热区排名' })
  expect(await screen.findByText(/计数没有读到/)).toBeInTheDocument()
  expect([...within(table).getAllByRole('row')[1]!.querySelectorAll('td')].slice(3).map(c => c.textContent)).toEqual(['—', '—', '—'])
})
it('explains how to get zones when none are drawn yet', async () => {
  vi.mocked(alarmArmingService.read).mockResolvedValue({ arming: null } as never)
  vi.mocked(flowService.list).mockResolvedValue({ items: [] } as never)
  renderPage()
  expect(await screen.findByText(/还没有热区/)).toBeInTheDocument()
})
it('opens the plan editor from the panel and picks up a saved plan afterwards', async () => {
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '编辑平面图' }))
  const dialog = screen.getByRole('dialog', { name: '平面图编辑' })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存草稿' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '热区分布' })).toHaveTextContent('平面图：平面图 1')
})
it('reads a week-hour cell from a fixed line on tap and says the grid is always the last four weeks', async () => {
  renderPage()
  await screen.findByRole('group', { name: '星期与小时分布' })
  expect(screen.getByRole('region', { name: '星期与小时规律' })).toHaveTextContent('近 4 周')
  const readout = screen.getByLabelText('分布读数')
  expect(readout).toHaveTextContent('点格子查看')
  fireEvent.click(screen.getByRole('button', { name: /^周三 8 时/ }))
  expect(readout.textContent).toMatch(/周三 8 时.*人次/)
})
it('selects channels from a dropdown that says how many are chosen, and the ranking view needs two or more', async () => {
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '排名' }))
  expect(await screen.findByRole('list', { name: '通道排名' })).toBeInTheDocument()
  const opener = screen.getByRole('button', { name: /^通道/ })
  expect(opener).toHaveTextContent('3')
  fireEvent.click(opener)
  const group = screen.getByRole('group', { name: '统计通道' })
  const boxes = within(group).getAllByRole('checkbox')
  expect(boxes).toHaveLength(3); boxes.forEach(b => expect(b).toBeChecked())
  fireEvent.click(boxes[0]!); fireEvent.click(boxes[1]!)
  await waitFor(() => expect(screen.queryByRole('button', { name: '排名' })).not.toBeInTheDocument())
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('group', { name: '统计通道' })).not.toBeInTheDocument()
})
it('keeps appearance statistics as an honest placeholder without any chart', async () => {
  renderPage()
  const panel = await screen.findByRole('region', { name: '外观属性统计' })
  expect(panel).toHaveTextContent('待验证')
  expect(panel.querySelector('svg')).toBeNull()
  expect(panel.textContent).not.toMatch(/\d+%/)
})
it('draws the counts as heat over the plan instead of numbers on the zone boxes, and follows the chosen direction', async () => {
  renderPage()
  const canvas = await screen.findByTestId('plan-canvas')
  await waitFor(() => expect(canvas.getAttribute('data-heat')).not.toBe('none'))
  const total = canvas.getAttribute('data-heat')
  const group = screen.getByRole('group', { name: '统计方向' })
  expect(within(group).getByRole('button', { name: '合计' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(within(group).getByRole('button', { name: '出' }))
  expect(within(group).getByRole('button', { name: '出' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('plan-canvas').getAttribute('data-heat')).not.toBe(total)
  fireEvent.click(within(group).getByRole('button', { name: '合计' }))
  expect(screen.getByTestId('plan-canvas').getAttribute('data-heat')).toBe(total)
  expect(screen.getByRole('slider', { name: '隐藏冷区' })).toBeInTheDocument()
})
it('reads out the tapped zone on one fixed line instead of putting numbers on the boxes', async () => {
  renderPage()
  const table = await screen.findByRole('table', { name: '热区排名' })
  const readout = screen.getByLabelText('热区读数')
  expect(readout).toHaveTextContent('点热区查看')
  fireEvent.click(within(table).getAllByRole('row')[1]!)
  expect(readout).toHaveTextContent('一厅A口：进 30，出 10')
})
it('shows no heat at all when the counts query fails', async () => {
  vi.mocked(flowService.query).mockRejectedValue(new Error('boom'))
  renderPage()
  const canvas = await screen.findByTestId('plan-canvas')
  expect(canvas).toHaveAttribute('data-heat', 'none')
})
