import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { AlarmAnalyticsMap } from '@/pages/Analytics/AlarmAnalyticsMap'
import type { AlarmAnalyticsQuery, AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
import type { PlanDraft } from '@/pages/Analytics/plan/planModel'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), dispose: vi.fn(), canvas: vi.fn(), editor: vi.fn() }))
vi.mock('@/api/floorPlanService', () => ({ createFloorPlanSession: () => mocks }))
vi.mock('@/pages/Analytics/plan/PlanCanvas', () => ({ PlanCanvas: (props: unknown) => { mocks.canvas(props); return <div data-testid="shared-canvas" /> } }))
vi.mock('@/pages/Analytics/plan/FloorPlanEditor', () => ({ FloorPlanEditor: (props: unknown) => { mocks.editor(props); return <div role="dialog">共用编辑器</div> } }))
const query: AlarmAnalyticsQuery = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', timezone: 'Asia/Shanghai', bucket: 'hour', trigger_id: 't' }
const zone = { channel_id: 'p1', zone_id: 'z', name: '入口', total: 8, pending: 2, human_reviewed: 4, human_false_positive: 1 }
const draft: PlanDraft = { version: 2, activeId: 'floor', plans: [{ id: 'floor', name: '一层', image: null, shapes: [], placements: { z: { x: 300, y: 200, w: 200, h: 100 } } }] }
function result(zones = [zone]) { return { zones, catalog: { zones, triggers: [], types: [] } } as unknown as AlarmAnalyticsResult }
beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue(draft); mocks.save.mockResolvedValue(undefined) })

it('uses the server plan and shared independent alarm heat layer; no counter or number overlay', async () => {
  render(<MemoryRouter><AlarmAnalyticsMap result={result()} query={query} /></MemoryRouter>)
  await screen.findByTestId('shared-canvas')
  const props = mocks.canvas.mock.calls.at(-1)![0]
  expect(props).toMatchObject({ heatPalette: 'alarm', readOnly: true, plan: { id: 'floor' } })
  expect(props.heat.flat().some((n: number) => n > 0)).toBe(true)
  expect(props.zoneValues).toBeUndefined()
  expect(props.zones[0].counters).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: /入口/ }))
  const link = screen.getByRole('link', { name: '查看告警' })
  expect(JSON.parse(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('analytics_scope')!)).toEqual({ ...query, locations: [{ channel_id: 'p1', zone_id: 'z' }] })
  fireEvent.click(screen.getByRole('button', { name: '编辑平面图' }))
  expect(mocks.editor.mock.calls.at(-1)![0]).toMatchObject({ context: 'alarm', counters: [], counts: { z: 8 } })
  expect(mocks.save).not.toHaveBeenCalled()
})
it('never combines duplicated zone IDs across channels into a planned box', async () => {
  render(<MemoryRouter><AlarmAnalyticsMap result={result([zone, { ...zone, channel_id: 'p2', total: 23 }])} query={query} /></MemoryRouter>)
  await screen.findByTestId('shared-canvas')
  const props = mocks.canvas.mock.calls.at(-1)![0]
  expect(props.zones).toEqual([])
  expect(props.plan.placements).toEqual({})
  expect(props.heat.flat().every((n: number) => n === 0)).toBe(true)
  expect(screen.getByText(/跨通道重复热区编号/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '入口 p1 8条告警' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '入口 p2 23条告警' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '编辑平面图' })).toBeDisabled()
})
it('uses a labeled unsaved layout only after the server confirms no saved plan', async () => {
  mocks.load.mockResolvedValue({ version: 2, plans: [], activeId: null })
  render(<MemoryRouter><AlarmAnalyticsMap result={result()} query={query} /></MemoryRouter>)
  await screen.findByText('临时布局 · 尚未保存')
  expect(mocks.save).not.toHaveBeenCalled()
})
it('failed server reads stay errors and do not fall back to local drafts', async () => {
  mocks.load.mockRejectedValueOnce(new Error('连接失败'))
  render(<MemoryRouter><AlarmAnalyticsMap result={result()} query={query} /></MemoryRouter>)
  expect(await screen.findByRole('alert')).toHaveTextContent('连接失败')
  expect(screen.queryByTestId('shared-canvas')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试平面图' }))
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
  expect(await screen.findByTestId('shared-canvas')).toBeInTheDocument()
})
it('selecting an out-of-scope catalog location never widens the drilldown link', async () => {
  const elsewhere = { ...zone, channel_id: 'other', zone_id: 'outside', name: '后门' }
  const value = { ...result(), catalog: { zones: [zone, elsewhere], triggers: [], types: [] } } as AlarmAnalyticsResult
  render(<MemoryRouter><AlarmAnalyticsMap result={value} query={{ ...query, locations: [{ channel_id: 'p1', zone_id: 'z' }] }} /></MemoryRouter>)
  await screen.findByTestId('shared-canvas')
  fireEvent.click(screen.getByRole('button', { name: /入口/ }))
  expect(screen.getByRole('link', { name: '查看告警' })).toBeInTheDocument()
  const props = mocks.canvas.mock.calls.at(-1)![0]
  const { act } = await import('@testing-library/react')
  act(() => props.onSelectZone('outside'))
  expect(screen.getByText(/筛选外位置/)).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '查看告警' })).not.toBeInTheDocument()
})
