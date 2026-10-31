import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { PlanPanel } from '@/pages/Analytics/plan/PlanPanel'
import type { PlanCanvasProps } from '@/pages/Analytics/plan/PlanCanvas'
import type { MapReading, PlanDraft, ZoneInfo } from '@/pages/Analytics/plan/planModel'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/api/floorPlanService', () => ({ createFloorPlanSession: () => ({ load, save: vi.fn(), dispose: vi.fn() }) }))
vi.mock('@/pages/Analytics/plan/PlanCanvas', () => ({
  PlanCanvas: (props: PlanCanvasProps) => <div>
    <output data-testid="map-heat">{props.heat?.some(row => row.some(value => value > 0)) ? '有热度' : '无热度'}</output>
    <output data-testid="map-threshold">{props.heatMin}</output>
    <output data-testid="placements">{JSON.stringify(props.plan?.placements)}</output>
    <button onClick={() => props.onSelectZone('shared')}>选择共享热区</button>
  </div>,
}))
const counters = [
  { id: 'c1', name: '人员入口', names: { in: '进入', out: '离开' }, outputs: 'both' as const, unit: '次' },
  { id: 'c2', name: '人员穿越', names: { in: '进入', out: '离开' }, outputs: 'both' as const, unit: '次' },
]
const zones: ZoneInfo[] = [{ key: 'shared', zoneId: 'shared', channelId: 'p', name: '共享入口', counters }]
const readings: MapReading[] = [
  { counterId: 'c1', bindingId: 'b1', zoneKey: 'shared', in: 5, out: 2 },
  { counterId: 'c2', bindingId: 'b2', zoneKey: 'shared', in: 70, out: null },
]
const draft: PlanDraft = { version: 2, activeId: 'p1', plans: [{
  id: 'p1', name: '一层', image: null, shapes: [],
  placements: { shared: { x: 0, y: 0, w: 200, h: 100 }, missing: { x: 300, y: 0, w: 100, h: 100 } },
}] }
const period = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', timezone: 'Asia/Shanghai' }
beforeEach(() => { vi.clearAllMocks(); load.mockResolvedValue(draft) })
function mount(data = readings, currentZones = zones) {
  return render(<MemoryRouter><PlanPanel zones={currentZones} counters={counters} readings={data} period={period}
    loading={false} error="" countsFailed={false} /></MemoryRouter>)
}
it('derives an independent heat layer from one counter and exposes each binding reading', async () => {
  mount()
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(within(screen.getByRole('table',{name:'热区排名'})).getByRole('cell',{name:'5'})).toBeInTheDocument()
  expect(screen.getByTestId('map-heat')).toHaveTextContent('有热度')
  fireEvent.change(screen.getByRole('slider', { name: '隐藏冷区' }), { target: { value: '50' } })
  expect(screen.getByTestId('map-threshold')).toHaveTextContent('0.5')
  const legend = screen.getByLabelText('地图图例')
  expect(legend).toHaveTextContent('人员入口 · 进入 · 单位：次')
  expect(legend).toHaveTextContent('Asia/Shanghai')
  expect(legend).toHaveTextContent('颜色仅比较本图该计数器')
  fireEvent.click(screen.getByText('选择共享热区'))
  const details = screen.getByLabelText('热区读数')
  expect(details).toHaveTextContent('人员入口 · 位置 1：进入 5，离开 2')
  expect(details).toHaveTextContent('人员穿越 · 位置 2：进入 70，离开 —')
  expect(within(details).getByTitle('统计位置：b1')).toHaveTextContent('人员入口')
  expect(within(details).getByTitle('统计位置：b2')).toHaveTextContent('人员穿越')
  fireEvent.change(screen.getByLabelText('地图计数器'), { target: { value: 'c2' } })
  expect(within(screen.getByRole('table',{name:'热区排名'})).getByRole('cell',{name:'70'})).toBeInTheDocument()
  expect(legend).toHaveTextContent('人员穿越 · 进入')
  expect(within(screen.getByRole('table',{name:'热区排名'})).queryByRole('cell',{name:'75'})).not.toBeInTheDocument()
})
it('keeps a confirmed zero distinct from an unsupported or unknown direction', async () => {
  mount([{ counterId: 'c1', bindingId: 'b1', zoneKey: 'shared', in: 0, out: null }])
  await waitFor(() => expect(screen.queryByText('正在读取服务器平面图…')).not.toBeInTheDocument())
  expect(within(screen.getByRole('table',{name:'热区排名'})).getByRole('cell',{name:'0'})).toBeInTheDocument()
  expect(screen.getByTestId('map-heat')).toHaveTextContent('无热度')
  fireEvent.click(screen.getByRole('button', { name: '离开' }))
  expect(screen.getByTestId('map-heat')).toHaveTextContent('无热度')
  expect(screen.getByLabelText('地图图例')).toHaveTextContent('当前最大 — 次')
  expect(screen.getByLabelText('地图图例')).toHaveTextContent('“—”为未知，0 为已确认零值')
})
it('lists stored unresolved references and keeps rendering their saved geometry even without loaded zones', async () => {
  mount([], [])
  const references = await screen.findByLabelText('地图未读取引用')
  expect(references).toHaveTextContent('失效/未读取引用 2 个')
  expect(references).toHaveTextContent('shared')
  expect(references).toHaveTextContent('missing')
  expect(references).toHaveTextContent('不能据此判断已删除')
  expect(screen.getByTestId('placements')).toHaveTextContent('"missing":{"x":300')
  expect(draft.plans[0]!.placements.missing).toEqual({ x: 300, y: 0, w: 100, h: 100 })
})
