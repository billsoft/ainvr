import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { PlanPanel } from '@/pages/Analytics/plan/PlanPanel'
import type { PlanCanvasProps } from '@/pages/Analytics/plan/PlanCanvas'
import type { MapAnnotation } from '@/pages/Analytics/plan/mapLabels'
import type { MapReading, PlanDraft, ZoneInfo } from '@/pages/Analytics/plan/planModel'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/api/floorPlanService', () => ({ createFloorPlanSession: () => ({ load, save: vi.fn(), dispose: vi.fn() }) }))
vi.mock('@/pages/Analytics/plan/PlanCanvas', () => ({
  PlanCanvas: (props: PlanCanvasProps) => <div>
    <output data-testid="map-heat">{props.heat?.some(row => row.some(value => value > 0)) ? '有热度' : '无热度'}</output>
    <output data-testid="map-threshold">{props.heatMin}</output>
    <output data-testid="placements">{JSON.stringify(props.plan?.placements)}</output>
    <output data-testid="map-annotations">{JSON.stringify(props.annotations ?? {})}</output>
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
function annotations(): Record<string, MapAnnotation> {
  return JSON.parse(screen.getByTestId('map-annotations').textContent ?? '{}')
}
it('derives an independent heat layer from one counter and exposes each binding reading', async () => {
  mount()
  await waitFor(() => expect(screen.queryByText('正在读取服务器平面图…')).not.toBeInTheDocument())
  expect(screen.queryByRole('table', { name: '热区排名' })).not.toBeInTheDocument()
  expect(annotations().shared?.summary).toBe('进入 5 · 离开 2 · 100%')
  expect(annotations().shared?.detail).toContain('人员入口')
  expect(annotations().shared?.detail).toContain('单位次')
  expect(screen.getByTestId('map-heat')).toHaveTextContent('有热度')
  fireEvent.change(screen.getByRole('slider', { name: '隐藏冷区' }), { target: { value: '50' } })
  expect(screen.getByTestId('map-threshold')).toHaveTextContent('0.5')
  const legend = screen.getByLabelText('地图图例')
  expect(legend).toHaveTextContent('人员入口 · 进入 · 单位：次')
  expect(legend).toHaveTextContent('Asia/Shanghai')
  expect(legend).toHaveTextContent('颜色仅比较本图该计数器')
  fireEvent.click(screen.getByText('选择共享热区'))
  const details = screen.getByLabelText('热区读数')
  expect(details).toHaveTextContent('人员入口 · 位置 1：进入 5，离开 2 次')
  expect(details).toHaveTextContent('人员穿越 · 位置 2：进入 70，离开 — 次')
  expect(within(details).getByTitle('统计位置：b1')).toHaveTextContent('人员入口')
  expect(within(details).getByTitle('统计位置：b2')).toHaveTextContent('人员穿越')
  fireEvent.change(screen.getByLabelText('地图计数器'), { target: { value: 'c2' } })
  expect(annotations().shared?.summary).toBe('进入 70 · 离开 — · 100%')
  expect(annotations().shared?.detail).toContain('人员穿越')
  expect(legend).toHaveTextContent('人员穿越 · 进入')
  expect(annotations().shared?.summary).not.toContain('75')
})
it('keeps a confirmed zero distinct from an unsupported or unknown direction', async () => {
  mount([{ counterId: 'c1', bindingId: 'b1', zoneKey: 'shared', in: 0, out: null }])
  await waitFor(() => expect(screen.queryByText('正在读取服务器平面图…')).not.toBeInTheDocument())
  expect(annotations().shared?.summary).toBe('进入 0 · 离开 — · —')
  expect(screen.getByTestId('map-heat')).toHaveTextContent('无热度')
  fireEvent.click(screen.getByRole('button', { name: '离开' }))
  expect(screen.getByTestId('map-heat')).toHaveTextContent('无热度')
  expect(screen.getByLabelText('地图图例')).toHaveTextContent('当前最大 — 次')
  expect(screen.getByLabelText('地图图例')).toHaveTextContent('“—”为未知，0 为已确认零值')
  expect(annotations().shared?.detail).toContain('占比按离开，单位次')
})
it('toggles map labels without changing heat, geometry, or independent binding details', async () => {
  mount()
  await waitFor(() => expect(screen.queryByText('正在读取服务器平面图…')).not.toBeInTheDocument())
  const initialAnnotations = annotations()
  const placements = screen.getByTestId('placements').textContent
  const toggle = screen.getByRole('button', { name: '数据标签' })
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(annotations()).toEqual({})
  expect(screen.getByTestId('map-heat')).toHaveTextContent('有热度')
  expect(screen.getByTestId('placements').textContent).toBe(placements)
  fireEvent.click(screen.getByRole('button', { name: '选择共享热区' }))
  expect(screen.getByLabelText('热区读数')).toHaveTextContent('进入 5，离开 2 次')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(annotations()).toEqual(initialAnnotations)
})
it('keeps multiple bindings of the same counter separate instead of summing map labels or heat', async () => {
  mount([
    readings[0]!,
    { counterId: 'c1', bindingId: 'b3', zoneKey: 'shared', in: 8, out: 0 },
    readings[1]!,
  ])
  await waitFor(() => expect(screen.queryByText('正在读取服务器平面图…')).not.toBeInTheDocument())
  expect(annotations().shared?.summary).toBe('2 个统计位置 · 点击查看')
  expect(screen.getByTestId('map-heat')).toHaveTextContent('无热度')
  expect(screen.getByLabelText('地图图例')).toHaveTextContent('当前最大 — 次')
  fireEvent.click(screen.getByRole('button', { name: '选择共享热区' }))
  const details = screen.getByLabelText('热区读数')
  expect(within(details).getByTitle('统计位置：b1')).toHaveTextContent('进入 5，离开 2 次')
  expect(within(details).getByTitle('统计位置：b3')).toHaveTextContent('进入 8，离开 0 次')
  expect(within(details).getByTitle('统计位置：b2')).toHaveTextContent('进入 70，离开 — 次')
  fireEvent.change(screen.getByLabelText('地图计数器'), { target: { value: 'c2' } })
  expect(annotations().shared?.summary).toBe('进入 70 · 离开 — · 100%')
  expect(screen.getByTestId('map-heat')).toHaveTextContent('有热度')
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
