import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { request } from '@/api/httpClient'
import { heatCsv, RegionHeatPanel } from '@/pages/Analytics/RegionHeatPanel'

vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
const location = { channel_id: 'processor', zone_id: 'zone', name: '=入口' }
const from = '2026-10-30T01:00:10Z', to = '2026-10-30T01:03:20Z'
function response() {
  const values = Array<number>(144).fill(0); values[0] = 1000; values[1] = 2000
  return {
    effective_from: '2026-10-30T01:01:00Z', effective_to: '2026-10-30T01:03:00Z',
    checkpoint_at: '2026-10-30T01:03:20Z', semantics: 'lower_bound_observed_target_time',
    coverage: 'unknown', status: 'recorded', session_scope: 'compatible_source_geometry',
    variants: [{ input_stream_id: '3a17d1f4-5e1a-447a-95ef-0f03c2b0c1d9', geometry_revision: 'g', view_epoch: null,
      zone_version: 1, source_width: 1920, source_height: 1080, columns: 16, rows: 9,
      values_ms: values, observed_ms: 3000, from: '2026-10-30T01:01:00Z', to: '2026-10-30T01:02:00Z' }],
  }
}
function mount(zone = location) {
  return render(<MemoryRouter><RegionHeatPanel location={zone} from={from} to={to} labels={['person']} /></MemoryRouter>)
}
it('parent refresh reloads an active heat query and visual thresholds never alter raw exports',async()=>{
 const value=response();vi.mocked(request).mockResolvedValue(value)
 const page=render(<MemoryRouter><RegionHeatPanel location={location} from={from} to={to} labels={['person']} autoLoad revision={0}/></MemoryRouter>)
 await screen.findByRole('img',{name:/原画面坐标/})
 fireEvent.change(screen.getByLabelText('画面隐藏冷区'),{target:{value:'95'}})
 expect(heatCsv('test',value,value.variants[0]!)).toContain('"1"')
 page.rerender(<MemoryRouter><RegionHeatPanel location={location} from={from} to={to} labels={['person']} autoLoad revision={1}/></MemoryRouter>)
 await waitFor(()=>expect(request).toHaveBeenCalledTimes(2))
})
beforeEach(() => vi.clearAllMocks())
it('requires an explicit query and displays real time-integrated cells with precise scope and source', async () => {
  vi.mocked(request).mockResolvedValue(response()); mount()
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '查询画面热度' }))
  await screen.findByRole('img', { name: /原画面坐标的观测时长网格/ })
  expect(JSON.parse(vi.mocked(request).mock.calls[0]![1]!.body as string)).toEqual({
    channel_id: 'processor', zone_id: 'zone', from, to, label_ids: ['person'],
  })
  expect(screen.getByText(/已排除边缘不足一分钟/)).toBeInTheDocument()
  expect(screen.getByText(/最高格累计分配 2 目标·秒/)).toBeInTheDocument()
  expect(screen.getByText(/不进行跨会话人员去重/)).toBeInTheDocument()
  expect(heatCsv(location.name,response(),response().variants[0]!)).toContain('同一来源坐标和类别版本的各会话累计')
  fireEvent.change(screen.getByLabelText('热度网格读数'), { target: { value: '1' } })
  expect(screen.getByRole('status')).toHaveTextContent('累计分配 2 目标·秒；覆盖未知')
  expect(screen.getByRole('link', { name: '查看该时段录像' })).toHaveAttribute('href',
    '/playback/3a17d1f4-5e1a-447a-95ef-0f03c2b0c1d9?from=1793322060000&to=1793322180000')
})
it('shows different source geometry separately instead of adding incompatible coordinates', async () => {
  const value = response(); value.variants.push({ ...value.variants[0]!, zone_version: 2, source_width: 1280, source_height: 720 })
  vi.mocked(request).mockResolvedValue(value); mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  await screen.findByRole('combobox', { name: '热度画面版本' })
  expect(screen.getByText(/区域版本 1 · 原画面 1920×1080/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('热度画面版本'), { target: { value: '1' } })
  expect(screen.getByText(/区域版本 2 · 原画面 1280×720/)).toBeInTheDocument()
  expect(screen.getByText(/没有合并到同一坐标图/)).toBeInTheDocument()
})
it('does not display an invalid or fabricated heat grid', async () => {
  const value = response(); value.variants[0]!.values_ms[0] = Infinity
  vi.mocked(request).mockResolvedValue(value); mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  expect(await screen.findByRole('alert')).toHaveTextContent('网格无效')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('explains empty suspended collection rather than implying no activity', async () => {
  vi.mocked(request).mockResolvedValue({ ...response(), variants: [], status: 'capacity_suspended', gaps: [{ from, to: null }] }); mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  expect(await screen.findByText(/因容量限制已暂停/)).toBeInTheDocument()
  expect(screen.getByText(/不能推断无人或恢复更早的热度/)).toBeInTheDocument()
  expect(screen.getByText(/有 1 段采集缺口/)).toBeInTheDocument()
})
it('explains a sub-minute request without inventing bounds or a heat grid', async () => {
  vi.mocked(request).mockResolvedValue({ ...response(), variants: [], effective_from: null, effective_to: null, status: 'no_complete_minutes', issues: ['partial_edges_discarded'] }); mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  expect(await screen.findByText(/所选时段没有完整分钟/)).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('shows normal publication lag without describing excluded minute edges as a collection failure', async () => {
  vi.mocked(request).mockResolvedValue({ ...response(), issues: ['partial_edges_discarded','open_minute_lag'] }); mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  expect(await screen.findByText(/仍在采集的分钟尚未发布/)).toBeInTheDocument()
  expect(screen.queryByText(/最近的热度采集存在异常/)).not.toBeInTheDocument()
})
it('does not attach a late previous-location result to the next location', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  vi.mocked(request).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const { rerender } = mount()
  fireEvent.click(screen.getByText('查询画面热度'))
  rerender(<MemoryRouter><RegionHeatPanel location={{ ...location, zone_id: 'next' }} from={from} to={to} labels={['person']} /></MemoryRouter>)
  await act(async () => finish(response()))
  await waitFor(() => expect(screen.getByText('查询画面热度')).not.toBeDisabled())
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('exports the same observed seconds and applies existing CSV injection protection', () => {
  const result = response(), text = heatCsv('=入口', result, result.variants[0]!)
  expect(text.split('\r\n')).toHaveLength(145)
  expect(text).toContain('"\'=入口"')
  expect(text.split('\r\n')[1]).toContain('"1","1","1","未知"')
  expect(text).toContain('零表示未记录时长，不证明无人')
})
