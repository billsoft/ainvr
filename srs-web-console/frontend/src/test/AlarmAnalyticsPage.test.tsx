import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import AlarmAnalyticsPage from '@/pages/Analytics/AlarmAnalyticsPage'
import { alarmAnalyticsService, type AlarmAnalyticsQuery, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'

vi.mock('@/api/alarmAnalyticsService', async original => ({ ...await original<typeof import('@/api/alarmAnalyticsService')>(), alarmAnalyticsService: { query: vi.fn() } }))
vi.mock('@/pages/Analytics/AlarmAnalyticsMap', () => ({ AlarmAnalyticsMap: () => <div aria-label="fixture map">地图组件另行测试</div> }))
vi.mock('@/components/ui/DateTimeRangePicker', () => ({ DateTimeRangePicker: ({ onConfirm, onClose }: { onConfirm: (a: string, b: string) => void; onClose: () => void }) => <div role="dialog"><button onClick={() => onConfirm('2026-10-01T08:00:00', '2026-10-01T08:59:59')}>确认测试日期</button><button onClick={onClose}>取消测试日期</button></div> }))
const from = '2026-10-01T00:00:00.000Z', to = '2026-10-02T00:00:00.000Z'
const scope = { channel_id: 'processor', zone_id: 'zone' }
function fixture(query?: AlarmAnalyticsQuery): AlarmAnalyticsResult {
  const a = query?.from ?? from, b = query?.to ?? to
  return { schema_version: '1.0', from: a, to: b, as_of: to, timezone: query?.timezone ?? 'Asia/Shanghai', bucket: query?.bucket ?? 'hour', total: 12, pending: 4, human_confirmed: 3, human_false_positive: 1, ai_reviewed: 2, unknown_review: 2,
    trend: [{ from: a, to: b, total: 12 }], zones: [], triggers: [{ trigger_id: 'trigger', name: '入口规则', total: 12, pending: 4, human_reviewed: 4, human_false_positive: 1, rule_versions: [1, 2] }], types: [{ id: 'region_enter', total: 12 }], week: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => day === 0 && hour === 9 ? 12 : 0)), quality: { human_reviewed: 4, false_positive_ratio: .25, wait: { samples: 4, median_ms: 90000, p90_ms: 3600000, unknown: 0 }, pending_age: { lt10m: 1, lt1h: 1, gte1h: 2 } }, association: { unassociated: query?.locations ? 0 : 2 }, catalog: { zones: [{ ...scope, name: '入口' }], triggers: [{ trigger_id: 'trigger', name: '入口规则' }], types: ['region_enter'] }, consistency: 'non_transactional', coverage: 'unknown', issues: [] }
}
function Location() { const location = useLocation(); return <output data-testid="url">{location.search}</output> }
function mount(extra = '') { return render(<MemoryRouter initialEntries={['/analytics?subject=alarms&range=custom&from=' + from + '&to=' + to + '&compare=0' + extra]}><AlarmAnalyticsPage /><Location /></MemoryRouter>) }
function linkQuery(element: HTMLElement) { return JSON.parse(new URL(element.getAttribute('href')!, 'http://localhost').searchParams.get('analytics_scope')!) as AlarmAnalyticsQuery }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(alarmAnalyticsService.query).mockImplementation(async q => fixture(q)) })

it('queries the true API contract and links all four KPI scopes without mixing AI and human', async () => {
  mount('&alarm_locations=' + encodeURIComponent(JSON.stringify([scope])) + '&trigger_id=trigger&primary_type=region_enter')
  const kpi = await screen.findByRole('link', { name: '范围内新增告警 12条' })
  const q = linkQuery(kpi)
  expect(q).toMatchObject({ from, to, trigger_id: 'trigger', primary_type: 'region_enter', locations: [scope] })
  expect(linkQuery(screen.getByRole('link', { name: '其中待审核 4条' }))).toEqual({ ...q, audit: 'pending' })
  expect(linkQuery(screen.getByRole('link', { name: '人工确认 3条' }))).toEqual({ ...q, audit: 'human_confirmed' })
  expect(linkQuery(screen.getByRole('link', { name: '人工判为误报 1条' }))).toEqual({ ...q, audit: 'human_false_positive' })
  expect(linkQuery(screen.getByRole('link', { name: '未关联热区 0 条' }))).toEqual({ ...q, association: 'unassociated' })
  expect(screen.getByText(/保留当前全部筛选条件/)).toHaveTextContent('已选热区时未关联数为 0')
  expect(alarmAnalyticsService.query).toHaveBeenCalledTimes(1)
})
it('switches all four views with URL state and preserves unrelated flow choices without refetch', async () => {
  mount('&counters=%5B%22original%22%5D')
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  fireEvent.click(screen.getByRole('button', { name: '规律' }))
  const cell = screen.getByRole('link', { name: '周一 9时 12条告警' })
  expect(linkQuery(cell)).toMatchObject({ weekday: 0, hour: 9, from, to })
  fireEvent.click(screen.getByRole('button', { name: '审核质量' }))
  expect(screen.getByRole('region', { name: '发生至首次人工审核' })).toHaveTextContent('有效样本 4')
  const summary = screen.getByText('统计说明')
  expect(summary.closest('details')).not.toHaveAttribute('open')
  fireEvent.click(summary)
  expect(summary.closest('details')).toHaveTextContent('包含采集入库延迟')
  expect(summary.closest('details')).toHaveTextContent('样本少，仅供参考')
  expect(screen.getByText('1.5 分钟')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '人工结论分布' })).toHaveTextContent('样本少，不作优劣比较')
  fireEvent.click(screen.getByRole('button', { name: '热区' }))
  expect(screen.getByLabelText('fixture map')).toBeInTheDocument()
  expect(screen.getByTestId('url')).toHaveTextContent('alarm_tab=heat')
  expect(screen.getByTestId('url')).toHaveTextContent('counters=%5B%22original%22%5D')
  expect(alarmAnalyticsService.query).toHaveBeenCalledTimes(1)
})
it('keeps bucket clipping and trigger IDs in drilldown; picker keeps half-open inclusive-second conversion', async () => {
  mount()
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  fireEvent.change(screen.getByLabelText('告警趋势时段'), { target: { value: '0' } })
  expect(linkQuery(screen.getByRole('link', { name: '查看该时段' }))).toMatchObject({ from, to })
  expect(linkQuery(within(screen.getByRole('table', { name: '触发器排名' })).getByRole('link', { name: /入口规则/ }))).toMatchObject({ trigger_id: 'trigger' })
  fireEvent.click(screen.getByLabelText('告警自选时间范围'))
  expect(screen.getByLabelText('刷新告警统计')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '确认测试日期' }))
  await waitFor(() => expect(alarmAnalyticsService.query).toHaveBeenCalledTimes(2))
  const q = vi.mocked(alarmAnalyticsService.query).mock.calls.at(-1)![0]
  expect(Date.parse(q.to) - Date.parse(q.from)).toBe(3600000)
})
it('does not fetch invalid URLs or silently widen them to all locations', async () => {
  mount('&alarm_locations=[]')
  expect(screen.getByRole('alert')).toHaveTextContent('告警位置无效')
  expect(alarmAnalyticsService.query).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '清除无效筛选' }))
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  expect(vi.mocked(alarmAnalyticsService.query).mock.calls[0]![0].locations).toBeUndefined()
})
it('a missing backend shows an unavailable state and never synthesizes KPI values', async () => {
  vi.mocked(alarmAnalyticsService.query).mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('接口尚未接通')
  expect(screen.queryByText('范围内新增告警')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '导出 CSV' })).toBeDisabled()
})
it('invalidates old scope and aborts obsolete requests, even if they finish late', async () => {
  let finish!: (value: AlarmAnalyticsResult) => void
  vi.mocked(alarmAnalyticsService.query).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  mount()
  await waitFor(() => expect(alarmAnalyticsService.query).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(alarmAnalyticsService.query).mock.calls[0]![1]!
  fireEvent.click(screen.getByRole('button', { name: '昨天' }))
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ ...fixture(), total: 999 }))
  expect(screen.queryByRole('link', { name: '范围内新增告警 999条' })).not.toBeInTheDocument()
})
it('failed refresh clears previously successful results instead of relabeling them as fresh', async () => {
  mount()
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  vi.mocked(alarmAnalyticsService.query).mockRejectedValue(new Error('容量超限，请缩短范围'))
  fireEvent.click(screen.getByLabelText('刷新告警统计'))
  expect(await screen.findByRole('alert')).toHaveTextContent('容量超限')
  expect(screen.queryByRole('link', { name: '范围内新增告警 12条' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '导出 CSV' })).toBeDisabled()
})
it('shows real zero and unknown coverage, with independent primary-type drilldowns', async () => {
  mount()
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  fireEvent.click(screen.getByRole('button', { name: '主类型' }))
  expect(linkQuery(screen.getByRole('link', { name: /进入\s*12/ }))).toMatchObject({ primary_type: 'region_enter', from, to })
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async q => ({ ...fixture(q), total: 0, pending: 0, human_confirmed: 0, human_false_positive: 0, ai_reviewed: 0, unknown_review: 0, trend: [], types: [], triggers: [], week: Array.from({ length: 7 }, () => Array(24).fill(0)) }))
  fireEvent.click(screen.getByLabelText('刷新告警统计'))
  expect(await screen.findByText(/当前范围已记录 0 条告警/)).toHaveTextContent('不能据此判断没有异常')
})
it('clearing inherited flow locations queries all alarm positions but preserves flow filters', async () => {
  mount('&alarm_scope_origin=flow&alarm_locations=' + encodeURIComponent(JSON.stringify([scope])) + '&bindings=%5B%22flow-binding%22%5D')
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  fireEvent.click(screen.getByRole('button', { name: '切换全部位置' }))
  await waitFor(() => expect(alarmAnalyticsService.query).toHaveBeenCalledTimes(2))
  expect(vi.mocked(alarmAnalyticsService.query).mock.calls.at(-1)![0].locations).toBeUndefined()
  expect(screen.getByTestId('url')).toHaveTextContent('bindings=%5B%22flow-binding%22%5D')
})
it('resets the selected trend bucket when the actual time range changes', async () => {
  mount()
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  fireEvent.change(screen.getByLabelText('告警趋势时段'), { target: { value: '0' } })
  expect(screen.getByRole('link', { name: '查看该时段' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '昨天' }))
  await screen.findByRole('link', { name: '范围内新增告警 12条' })
  expect(screen.getByLabelText('告警趋势时段')).toHaveValue('')
  expect(screen.queryByRole('link', { name: '查看该时段' })).not.toBeInTheDocument()
})
it('measures the chart viewport and keeps tick fonts stable across narrow and wide containers', async () => {
  let resize!: (width: number, height: number) => void
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resize = (width, height) => callback([{ contentRect: { width, height } }] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
    }
    observe() {}
    disconnect = disconnect
  })
  try {
    const view = mount()
    const chart = await screen.findByRole('img', { name: '告警时间趋势' })
    act(() => resize(360, 146))
    expect(chart).toHaveAttribute('viewBox', '0 0 360 146')
    expect(chart.querySelectorAll('text').length).toBeGreaterThan(0)
    for (const tick of chart.querySelectorAll('text')) expect(tick).toHaveAttribute('font-size', '10.5')
    expect(chart.querySelector('line')).toHaveAttribute('x2', '348')
    act(() => resize(980, 220))
    expect(chart).toHaveAttribute('viewBox', '0 0 980 220')
    for (const tick of chart.querySelectorAll('text')) expect(tick).toHaveAttribute('font-size', '10.5')
    expect(chart.querySelector('line')).toHaveAttribute('x2', '968')
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
