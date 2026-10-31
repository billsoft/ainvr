import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DwellPanel } from '@/pages/Analytics/DwellPanel'
import { request } from '@/api/httpClient'

vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
const empty = {
  observed_ms: 0, visits_started: 0, active_visits: 0, checkpoint_at: null, samples: [],
  coverage: 'unknown', semantics: 'lower_bound_observed_checkpoint',
}
const sample = {
  visit_id: 'v1', label_id: 'person', started_at: '2026-10-01T01:00:00Z',
  observed_ms: 2500, active: false, partial: true, end_reason: 'observed_exit',
}
beforeEach(() => { vi.clearAllMocks() })
async function queryPanel(response: object) {
  vi.mocked(request).mockResolvedValue(response)
  render(<DwellPanel locations={[{ channel_id: 'processor', zone_id: 'zone', name: '入口' }]}
    labels={['person']} from="2026-10-01T00:00:00Z" to="2026-10-02T00:00:00Z" bucket="hour" />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('停留位置'), { target: { value: '0' } })
  fireEvent.click(screen.getByText('查询停留'))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.queryByText('正在读取停留观测…')).not.toBeInTheDocument())
}
it('queries the explicit selected category and distinguishes an empty unknown-coverage result', async () => {
  await queryPanel(empty)
  expect(screen.getByText(/不能推断无人停留/)).toBeInTheDocument()
  expect(screen.getByText(/筛选类别：人员/)).toBeInTheDocument()
  const args = vi.mocked(request).mock.calls[0]!
  expect(JSON.parse(args[1]!.body as string)).toMatchObject({
    channel_id: 'processor', zone_id: 'zone', label_ids: ['person'],
  })
  expect(screen.getByText(/不超过 1.5 秒/)).toHaveTextContent('间断时间不计入停留；更长的中断会拆分片段')
})
it('visibly reports capacity suspension and ongoing gaps even when no fragments are returned', async () => {
  await queryPanel({
    ...empty, dwell_status: 'capacity_suspended',
    checkpoint_at: '2026-10-01T12:00:00Z',
    gaps: [{ from: '2026-10-01T11:00:00Z', to: null, reason: 'dwell_capacity' }],
    last_issues: ['dwell_capacity'],
    retention: { mode: 'rolling', history_complete: false, oldest_available_at: '2026-09-30T00:00:00Z' },
  })
  const state = screen.getByRole('status', { name: '停留数据状态' })
  expect(within(state).getByText(/因容量限制已暂停/)).toHaveTextContent('数据不完整')
  expect(within(state).getByText(/缺口尚未结束/)).toBeInTheDocument()
  expect(screen.getByText(/尚未更新到查询结束时间/)).toBeInTheDocument()
  expect(screen.getByText(/返回的历史记录不保证完整/)).toBeInTheDocument()
  expect(screen.getByText(/现存最早片段/)).toHaveTextContent('不代表该时间之后覆盖完整')
  expect(screen.getByText(/不能推断无人停留/)).toBeInTheDocument()
})
it('reports interval-limit truncation from the API and preserves observed lower-bound sample semantics', async () => {
  await queryPanel({
    ...empty, observed_ms: 2500, visits_started: 1, dwell_status: 'active',
    checkpoint_at: '2026-10-02T00:00:00Z', last_issues: ['dwell_interval_limit'],
    samples: [{ ...sample, end_reason: 'interval_limit', observation_gaps: true }],
  })
  const state = screen.getByRole('status', { name: '停留数据状态' })
  expect(within(state).getByText(/相关片段已截断，后续时长未计入/)).toBeInTheDocument()
  expect(screen.getByRole('listitem')).toHaveTextContent('至少 2.5 秒')
  expect(screen.getByRole('listitem')).toHaveTextContent('观测间隔数量达到上限，片段已截断')
  expect(screen.getByRole('listitem')).toHaveTextContent('非完整停留')
  expect(screen.getByRole('listitem')).toHaveTextContent('间断时间未计入')
  expect(screen.queryByText(/尚未更新到查询结束时间/)).not.toBeInTheDocument()
})
it('translates returned duration and restart endings without claiming a complete stay', async () => {
  await queryPanel({
    ...empty, observed_ms: 5000, visits_started: 2, dwell_status: 'active',
    samples: [{ ...sample, end_reason: 'duration_limit' }, { ...sample, visit_id: 'v2', end_reason: 'consumer_restart' }],
  })
  expect(screen.getByRole('status', { name: '停留数据状态' })).toHaveTextContent('观测时长达到上限，相关片段已截断')
  const rows = screen.getAllByRole('listitem')
  expect(rows[0]).toHaveTextContent('观测时长达到上限，片段已截断')
  expect(rows[1]).toHaveTextContent('采集服务重启，片段已结束')
  expect(rows.every(row => row.textContent?.includes('非完整停留'))).toBe(true)
})
it('displays model label names while preserving their original IDs in observation queries',async()=>{
 vi.mocked(request).mockResolvedValue(empty)
 const active=vi.fn()
 const {unmount}=render(<DwellPanel locations={[{channel_id:'p',zone_id:'z',name:'入口'}]} labels={['class:0']}
  labelNames={{'class:0':'person'}} onActiveChange={active} from="2026-10-01T00:00:00Z" to="2026-10-02T00:00:00Z" bucket="hour" />)
 expect(screen.getByText(/筛选类别：人员/)).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('停留位置'),{target:{value:'0'}})
 expect(active).toHaveBeenLastCalledWith(true)
 fireEvent.click(screen.getByRole('button',{name:'查询停留'}))
 await waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
 expect(JSON.parse(vi.mocked(request).mock.calls[0]![1]!.body as string).label_ids).toEqual(['class:0'])
 fireEvent.click(screen.getByRole('tab',{name:'画面热度'}))
 expect(screen.getByText(/筛选类别：人员/)).toBeInTheDocument()
 unmount();expect(active).toHaveBeenLastCalledWith(false)
})
