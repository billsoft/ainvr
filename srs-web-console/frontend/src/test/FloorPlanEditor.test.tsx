import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FloorPlanEditor } from '@/pages/Analytics/plan/FloorPlanEditor'
import { DRAFT_KEY } from '@/pages/Analytics/plan/planStorage'
import type { Plan, PlanDraft, ZoneInfo } from '@/pages/Analytics/plan/planModel'

// 画布由成熟的绘图库负责，这里只验证编辑器的逻辑；画布用一个能触发回调的替身。
vi.mock('@/pages/Analytics/plan/PlanCanvas', () => ({
  PlanCanvas: (p: { plan: Plan | null; zones: ZoneInfo[]; readOnly?: boolean; heat?: number[][]; tool?: string; grid?: boolean; snap?: number; view?: { zoom: number }; imageOpacity?: number
    onSelectZone: (k: string | null) => void; onChangeZone: (k: string, v: { x: number; y: number; w: number; h: number }) => void
    onCreateShape: (s: { kind: 'room'; x: number; y: number; w: number; h: number; name: string } | { kind: 'line'; points: [number, number, number, number] }) => void }) =>
    <div data-testid="plan-canvas" data-readonly={p.readOnly ? 'true' : 'false'} data-heat={p.heat?.some(row => row.some(v => v > 0)) ? 'true' : 'false'} data-placed={p.plan ? Object.keys(p.plan.placements).length : -1} data-shapes={p.plan?.shapes.length ?? -1}
      data-tool={p.tool} data-grid={String(!!p.grid)} data-snap={p.snap ?? 0} data-zoom={p.view?.zoom ?? ''} data-opacity={p.imageOpacity ?? ''}>
      <button type="button" onClick={() => p.onSelectZone('za')}>画布点选一厅A口</button>
      <button type="button" onClick={() => p.onChangeZone('za', { x: 700, y: 400, w: 180, h: 90 })}>画布拖动一厅A口</button>
      <button type="button" onClick={() => p.onCreateShape({ kind: 'room', x: 10, y: 10, w: 300, h: 200, name: '新房间' })}>画布画一个房间</button>
      <button type="button" onClick={() => p.onCreateShape({ kind: 'line', points: [0, 0, 100, 0] })}>画布画一段墙</button>
    </div>,
}))

const counters = [{ id: 'c1', name: '一厅人数' }, { id: 'c2', name: '二厅人数' }]
const zones: ZoneInfo[] = [
  { key: 'za', channelId: 'ch1', zoneId: 'za', name: '一厅A口', counters: [counters[0]!] },
  { key: 'zb', channelId: 'ch1', zoneId: 'zb', name: '二厅B口', counters: [counters[1]!] },
  { key: 'zc', channelId: 'ch2', zoneId: 'zc', name: '共用通道', counters },
  { key: 'zd', channelId: 'ch2', zoneId: 'zd', name: '还没关联的区域', counters: [] },
]
const mount = (onClose = vi.fn()) => ({ onClose, ...render(<MemoryRouter><FloorPlanEditor zones={zones} counters={counters} counts={{ za: 120, zb: 30 }} onClose={onClose} /></MemoryRouter>) })
const list = () => screen.getByRole('navigation', { name: '热区列表' })
const canvas = () => screen.getByTestId('plan-canvas')
const plans = () => screen.getByRole('region', { name: '平面图列表' })
const planNames = () => within(plans()).getAllByRole('button').filter(b => b.hasAttribute('aria-pressed')).map(b => b.querySelector('[data-plan-name]')?.textContent)
const currentPlan = () => within(plans()).getByRole('button', { pressed: true }).querySelector('[data-plan-name]')?.textContent
const menu = (item: string) => { fireEvent.click(screen.getByRole('button', { name: '更多操作' })); fireEvent.click(screen.getByRole('menuitem', { name: item })) }
const tools = () => screen.getByRole('toolbar', { name: '绘图工具' })
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('says plainly that the plan is a local draft and only moves the picture, not the detection range', () => {
  mount()
  const dialog = screen.getByRole('dialog', { name: '平面图编辑' })
  expect(dialog).toHaveTextContent('本机草稿 · 未上传服务器')
  expect(dialog).toHaveTextContent('拖动只改摆放位置，不影响计数和检测范围')
})
it('starts with one plan that already holds every zone so the first screen is not empty', () => {
  mount()
  expect(currentPlan()).toBe('平面图 1')
  expect(canvas()).toHaveAttribute('data-placed', '4')
  expect(screen.queryByRole('region', { name: '开始绘制' })).not.toBeInTheDocument()
})
it('previews the same draft with the independent data layer without saving or changing its geometry', () => {
  mount()
  const placed = canvas().getAttribute('data-placed')
  fireEvent.click(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name: '预览' }))
  expect(canvas()).toHaveAttribute('data-readonly', 'true')
  expect(canvas()).toHaveAttribute('data-heat', 'true')
  expect(canvas()).toHaveAttribute('data-placed', placed!)
  expect(screen.queryByRole('toolbar', { name: '绘图工具' })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '热区列表' })).not.toBeInTheDocument()
  expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  fireEvent.click(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name: '编辑' }))
  expect(canvas()).toHaveAttribute('data-readonly', 'false')
  expect(canvas()).toHaveAttribute('data-heat', 'false')
  expect(tools()).toBeInTheDocument()
})
it('lists zones by counter, with a shared zone under each counter and loose zones last, or by zone', () => {
  mount()
  expect(within(list()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['一厅人数', '二厅人数', '未关联统计'])
  expect(within(list()).getAllByRole('button', { name: /共用通道/ })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '按热区' }))
  expect(screen.getByRole('button', { name: '按热区' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(list()).queryAllByRole('heading', { level: 3 })).toHaveLength(0)
  expect(within(list()).getAllByRole('button')).toHaveLength(4)
  expect(within(list()).getByRole('button', { name: /共用通道/ })).toHaveTextContent('一厅人数')
  expect(within(list()).getByRole('button', { name: /共用通道/ })).toHaveTextContent('二厅人数')
})
it("shows a zone's counters and sends shape, name and counter changes to the arming editor", () => {
  mount()
  fireEvent.click(within(list()).getAllByRole('button', { name: /共用通道/ })[0]!)
  const panel = screen.getByRole('region', { name: '热区属性' })
  expect(panel).toHaveTextContent('共用通道'); expect(panel).toHaveTextContent('一厅人数'); expect(panel).toHaveTextContent('二厅人数')
  expect(within(panel).getByRole('link', { name: /在布防中修改形状和名称/ })).toHaveAttribute('href', '/monitor')
  expect(panel).toHaveTextContent('名称、形状和关联的统计在布防里改')
})
it('moves a zone by dragging on the canvas or typing numbers, and keeps both in step', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: '画布点选一厅A口' }))
  const x = screen.getByRole('spinbutton', { name: 'X 位置' }) as HTMLInputElement
  fireEvent.click(screen.getByRole('button', { name: '画布拖动一厅A口' }))
  expect(x.value).toBe('700'); expect(screen.getByRole('spinbutton', { name: '宽度' })).toHaveValue(180)
  fireEvent.change(x, { target: { value: '9999' } })
  expect(Number(x.value)).toBe(1600 - 180)
  expect(screen.getByText('有未保存的修改')).toBeInTheDocument()
})
it('keeps several plans as a page list and lets one zone sit on more than one of them', () => {
  mount()
  fireEvent.click(within(plans()).getByRole('button', { name: '新建平面图' }))
  expect(currentPlan()).toBe('平面图 2')
  expect(canvas()).toHaveAttribute('data-placed', '0')
  const row = () => within(list()).getAllByRole('button', { name: /一厅A口/ })[0]!
  expect(row()).toHaveTextContent('不在本平面图')
  fireEvent.click(screen.getByRole('button', { name: '画布点选一厅A口' }))
  fireEvent.click(within(screen.getByRole('region', { name: '热区属性' })).getByRole('button', { name: '加入本平面图' }))
  expect(canvas()).toHaveAttribute('data-placed', '1')
  expect(screen.getByRole('region', { name: '热区属性' })).toHaveTextContent('出现在 2 张平面图')
  fireEvent.click(within(plans()).getByRole('button', { name: /平面图 1/ }))
  expect(currentPlan()).toBe('平面图 1')
  expect(canvas()).toHaveAttribute('data-placed', '4')
})
it('removing a zone from one plan only removes its place there', () => {
  mount()
  fireEvent.click(within(plans()).getByRole('button', { name: '新建平面图' }))
  fireEvent.click(screen.getByRole('button', { name: /放入全部热区/ }))
  expect(canvas()).toHaveAttribute('data-placed', '4')
  fireEvent.click(screen.getByRole('button', { name: '画布点选一厅A口' }))
  fireEvent.click(screen.getByRole('button', { name: '从本平面图移除' }))
  expect(canvas()).toHaveAttribute('data-placed', '3')
  fireEvent.click(within(plans()).getByRole('button', { name: /平面图 1/ }))
  expect(canvas()).toHaveAttribute('data-placed', '4')
})
it('renames inline and deletes a plan after confirming, without touching any zone', () => {
  mount()
  fireEvent.click(within(plans()).getByRole('button', { name: '新建平面图' }))
  fireEvent.change(screen.getByRole('textbox', { name: '平面图名称' }), { target: { value: '二层' } })
  expect(currentPlan()).toBe('二层')
  menu('删除平面图')
  const confirmation = screen.getByRole('dialog', { name: '删除平面图？' })
  expect(confirmation).toHaveTextContent('确认仅从当前草稿移除')
  fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }))
  expect(planNames()).toHaveLength(2)
  expect(screen.getByRole('textbox', { name: '平面图名称' })).toHaveValue('二层')
  menu('删除平面图')
  fireEvent.click(within(screen.getByRole('dialog', { name: '删除平面图？' })).getByRole('button', { name: '从草稿移除' }))
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  expect(planNames()).toHaveLength(1)
  expect(within(list()).getAllByRole('button', { name: /共用通道/ })).toHaveLength(2)
})
it('saves the draft locally, restores it next time, and asks before discarding unsaved changes', () => {
  const { onClose } = mount()
  fireEvent.click(screen.getByRole('button', { name: '画布拖动一厅A口' }))
  fireEvent.click(screen.getByRole('button', { name: '画布画一个房间' }))
  expect(canvas()).toHaveAttribute('data-shapes', '1')
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  const confirmation = screen.getByRole('dialog', { name: '放弃未保存的修改？' })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }))
  expect(canvas()).toHaveAttribute('data-shapes', '1')
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
  expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).plans[0].placements.za.x).toBe(700)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
it('restores a saved draft and ignores an unreadable one with a visible notice', () => {
  const saved = { version: 2, activeId: 'p1', plans: [{ id: 'p1', name: '一层', image: null, shapes: [], placements: { za: { x: 500, y: 300, w: 200, h: 100 } } }] }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(saved))
  const { unmount } = mount()
  expect(currentPlan()).toBe('一层')
  fireEvent.click(screen.getByRole('button', { name: '画布点选一厅A口' }))
  expect(screen.getByRole('spinbutton', { name: 'X 位置' })).toHaveValue(500)
  unmount()
  localStorage.setItem(DRAFT_KEY, '{broken')
  mount()
  expect(screen.getByRole('status')).toHaveTextContent('本机草稿无法读取，已忽略')
})
it('removes a drawn shape that is selected, with the button or the Delete key', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: '画布画一个房间' }))
  fireEvent.click(screen.getByRole('button', { name: '删除所选图形' }))
  expect(canvas()).toHaveAttribute('data-shapes', '0')
  fireEvent.click(screen.getByRole('button', { name: '画布画一个房间' }))
  fireEvent.keyDown(document.body, { key: 'Delete' })
  expect(canvas()).toHaveAttribute('data-shapes', '0')
})
it('undoes and redoes edits, from the buttons and the keyboard', () => {
  mount()
  const undo = screen.getByRole('button', { name: '撤销' }), redo = screen.getByRole('button', { name: '重做' })
  expect(undo).toBeDisabled(); expect(redo).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '画布画一个房间' }))
  fireEvent.click(screen.getByRole('button', { name: '画布拖动一厅A口' }))
  fireEvent.click(undo)
  fireEvent.click(screen.getByRole('button', { name: '画布点选一厅A口' }))
  expect(screen.getByRole('spinbutton', { name: 'X 位置' })).not.toHaveValue(700)
  expect(canvas()).toHaveAttribute('data-shapes', '1')
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
  expect(canvas()).toHaveAttribute('data-shapes', '0')
  fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
  expect(canvas()).toHaveAttribute('data-shapes', '1')
  fireEvent.click(redo)
  expect(screen.getByRole('spinbutton', { name: 'X 位置' })).toHaveValue(700)
})
it('picks tools from the rail or by letter, but never while typing a name', () => {
  mount()
  expect(within(tools()).getByRole('button', { name: /选择/ })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(within(tools()).getByRole('button', { name: /房间/ }))
  expect(canvas()).toHaveAttribute('data-tool', 'room')
  fireEvent.keyDown(document.body, { key: 'l' })
  expect(canvas()).toHaveAttribute('data-tool', 'line')
  expect(within(tools()).getByRole('button', { name: /墙线/ })).toHaveAttribute('aria-pressed', 'true')
  // A wall keeps the wall tool so the next segment can continue from its end.
  fireEvent.click(screen.getByRole('button', { name: '画布画一段墙' }))
  expect(canvas()).toHaveAttribute('data-tool', 'line')
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(canvas()).toHaveAttribute('data-tool', 'select')
  const name = screen.getByRole('textbox', { name: '平面图名称' })
  fireEvent.keyDown(name, { key: 'r' })
  expect(canvas()).toHaveAttribute('data-tool', 'select')
})
it('Space still presses a focused control; only over the board does it pan', () => {
  mount()
  const room = within(tools()).getByRole('button', { name: /房间/ })
  room.focus()
  expect(fireEvent.keyDown(room, { key: ' ' })).toBe(true)
  expect(fireEvent.keyDown(document.body, { key: ' ' })).toBe(false)
  expect(canvas()).toHaveAttribute('data-tool', 'pan')
  fireEvent.keyUp(document.body, { key: ' ' })
  expect(canvas()).toHaveAttribute('data-tool', 'select')
})
it('zooms from the corner controls and fits back to the board', () => {
  mount()
  expect(canvas()).toHaveAttribute('data-zoom', '1')
  fireEvent.click(screen.getByRole('button', { name: '放大' }))
  expect(Number(canvas().getAttribute('data-zoom'))).toBeGreaterThan(1)
  fireEvent.click(screen.getByRole('button', { name: /适应画布/ }))
  expect(canvas()).toHaveAttribute('data-zoom', '1')
})
it('with nothing selected the side panel holds the board settings: grid, snapping and base image', () => {
  mount()
  const board = screen.getByRole('region', { name: '平面图属性' })
  expect(canvas()).toHaveAttribute('data-grid', 'true')
  fireEvent.click(within(board).getByRole('checkbox', { name: '显示网格' }))
  expect(canvas()).toHaveAttribute('data-grid', 'false')
  expect(canvas()).toHaveAttribute('data-snap', '20')
  fireEvent.click(within(board).getByRole('checkbox', { name: '吸附网格' }))
  expect(canvas()).toHaveAttribute('data-snap', '0')
  expect(within(board).getByRole('button', { name: '导入底图' })).toBeInTheDocument()
  expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()
})
it('opens straight onto a blank board that offers the two ways to start', () => {
  render(<MemoryRouter><FloorPlanEditor zones={[]} counters={[]} counts={{}} onClose={() => {}} /></MemoryRouter>)
  expect(currentPlan()).toBe('平面图 1')
  expect(canvas()).toHaveAttribute('data-placed', '0')
  const start = screen.getByRole('region', { name: '开始绘制' })
  expect(within(start).getByRole('button', { name: /导入底图/ })).toBeInTheDocument()
  fireEvent.click(within(start).getByRole('button', { name: /直接在白板上画/ }))
  expect(canvas()).toHaveAttribute('data-tool', 'room')
  expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument()
})
it('never leaves the editor without a canvas: deleting the last plan starts a fresh blank one', () => {
  mount()
  menu('删除平面图')
  fireEvent.click(within(screen.getByRole('dialog', { name: '删除平面图？' })).getByRole('button', { name: '从草稿移除' }))
  expect(planNames()).toHaveLength(1)
  expect(canvas()).toHaveAttribute('data-placed', '0')
})

it('does not render NaN or Infinity when a direction has unknown coverage', () => {
  render(<MemoryRouter><FloorPlanEditor zones={zones} counters={counters} counts={{za:NaN,zb:Infinity}} onClose={vi.fn()} /></MemoryRouter>)
  expect(screen.getByRole('dialog', {name:'平面图编辑'})).not.toHaveTextContent('NaN')
  expect(screen.getByRole('dialog', {name:'平面图编辑'})).not.toHaveTextContent('Infinity')
})

const serverDraft = (): PlanDraft => ({
  version: 2, activeId: 'server-plan',
  plans: [{ id: 'server-plan', name: '服务器一层', image: null, shapes: [], placements: {} }],
})

it('keeps nested Escape and Tab in the confirmation, preserves edits on cancel, and discards without saving', () => {
  const save = vi.fn(), closed = vi.fn()
  const server = { draft: serverDraft(), save, reload: vi.fn() }
  function Host() {
    const [editing, setEditing] = useState(false)
    return <>
      <button onClick={() => setEditing(true)}>打开平面图编辑</button>
      {editing && <FloorPlanEditor zones={zones} counters={counters} counts={{}} server={server}
        onClose={() => { closed(); setEditing(false) }} />}
    </>
  }
  render(<MemoryRouter><Host /></MemoryRouter>)
  const opener = screen.getByRole('button', { name: '打开平面图编辑' })
  opener.focus()
  fireEvent.click(opener)
  const name = screen.getByRole('textbox', { name: '平面图名称' })
  expect(name).toHaveFocus()
  fireEvent.change(name, { target: { value: '保留我的草稿' } })
  fireEvent.keyDown(name, { key: 'Escape' })
  let confirmation = screen.getByRole('dialog', { name: '放弃未保存的修改？' })
  expect(within(confirmation).getByRole('button', { name: '继续编辑' })).toHaveFocus()
  const nestedClose = within(confirmation).getByRole('button', { name: '关闭' })
  const discard = within(confirmation).getByRole('button', { name: '放弃修改' })
  nestedClose.focus()
  fireEvent.keyDown(nestedClose, { key: 'Tab', shiftKey: true })
  expect(discard).toHaveFocus()
  fireEvent.keyDown(discard, { key: 'Tab' })
  expect(nestedClose).toHaveFocus()
  fireEvent.keyDown(nestedClose, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: '放弃未保存的修改？' })).not.toBeInTheDocument()
  expect(name).toHaveValue('保留我的草稿')
  expect(name).toHaveFocus()
  expect(closed).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()

  fireEvent.keyDown(name, { key: 'Escape' })
  confirmation = screen.getByRole('dialog', { name: '放弃未保存的修改？' })
  fireEvent.click(within(confirmation).getByRole('button', { name: '继续编辑' }))
  expect(name).toHaveValue('保留我的草稿')
  expect(name).toHaveFocus()

  const editorClose = within(screen.getByRole('dialog', { name: '平面图编辑' })).getByRole('button', { name: '关闭' })
  editorClose.focus()
  fireEvent.click(editorClose)
  fireEvent.click(within(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).getByRole('button', { name: '放弃修改' }))
  expect(closed).toHaveBeenCalledTimes(1)
  expect(save).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(opener).toHaveFocus()
})

it('confirms local import explicitly and uploads only on Save, preserving the source draft', async () => {
  const local = { version: 2, activeId: 'local-plan', plans: [
    { id: 'local-plan', name: '本机二层', image: null, shapes: [], placements: {} },
  ] }
  const stored = JSON.stringify(local)
  localStorage.setItem(DRAFT_KEY, stored)
  const save = vi.fn().mockResolvedValue(undefined)
  render(<MemoryRouter><FloorPlanEditor zones={zones} counters={counters} counts={{}} onClose={vi.fn()}
    server={{ draft: serverDraft(), save, reload: vi.fn() }} /></MemoryRouter>)
  expect(screen.getByRole('dialog', { name: '平面图编辑' })).toHaveTextContent('服务器平面图')
  menu('导入本机草稿')
  let confirmation = screen.getByRole('dialog', { name: '导入本机草稿？' })
  expect(confirmation).toHaveTextContent('确认只加入当前草稿，保存后才会上传')
  fireEvent.keyDown(confirmation, { key: 'Escape' })
  expect(planNames()).toHaveLength(1)
  expect(screen.getByRole('button', { name: '更多操作' })).toHaveFocus()
  expect(save).not.toHaveBeenCalled()
  menu('导入本机草稿')
  confirmation = screen.getByRole('dialog', { name: '导入本机草稿？' })
  fireEvent.click(within(confirmation).getByRole('button', { name: '导入草稿' }))
  expect(planNames()).toHaveLength(2)
  expect(save).not.toHaveBeenCalled()
  expect(localStorage.getItem(DRAFT_KEY)).toBe(stored)
  fireEvent.click(screen.getByRole('button', { name: '保存到服务器' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0]![0].plans.map((p: Plan) => p.id)).toEqual(['server-plan', 'local-plan'])
  expect(localStorage.getItem(DRAFT_KEY)).toBe(stored)
})

it('keeps plan deletion in the draft until an explicit server Save', async () => {
  const draft = serverDraft()
  draft.plans.push({ id: 'second', name: '服务器二层', image: null, shapes: [], placements: {} })
  const save = vi.fn().mockResolvedValue(undefined)
  render(<MemoryRouter><FloorPlanEditor zones={zones} counters={counters} counts={{}} onClose={vi.fn()}
    server={{ draft, save, reload: vi.fn() }} /></MemoryRouter>)
  menu('删除平面图')
  const confirmation = screen.getByRole('dialog', { name: '删除平面图？' })
  expect(confirmation).toHaveTextContent('点击“保存到服务器”后才保存删除')
  fireEvent.click(within(confirmation).getByRole('button', { name: '从草稿移除' }))
  expect(planNames()).toHaveLength(1)
  expect(draft.plans).toHaveLength(2)
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存到服务器' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0]![0].plans.map((p: Plan) => p.id)).toEqual(['second'])
})

it('preserves unresolved references on ordinary save and only removes an explicitly chosen placement from the draft', async () => {
  const draft = serverDraft()
  draft.plans[0]!.placements = {
    za: { x: 0, y: 0, w: 200, h: 100 },
    ghost1: { x: 300, y: 0, w: 200, h: 100 },
    ghost2: { x: 600, y: 0, w: 200, h: 100 },
  }
  const save = vi.fn().mockResolvedValue(undefined)
  render(<MemoryRouter><FloorPlanEditor zones={zones} counters={counters} counts={{}} onClose={vi.fn()}
    server={{ draft, save, reload: vi.fn() }} /></MemoryRouter>)
  const references = screen.getByRole('region', { name: '未读取引用' })
  expect(references).toHaveTextContent('失效/未读取引用 2 个')
  fireEvent.change(screen.getByRole('textbox', { name: '平面图名称' }), { target: { value: '保留存量引用' } })
  fireEvent.click(screen.getByRole('button', { name: '保存到服务器' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(Object.keys(save.mock.calls[0]![0].plans[0].placements)).toEqual(['za', 'ghost1', 'ghost2'])
  fireEvent.click(screen.getByRole('button', { name: '从草稿移除未读取引用 ghost1' }))
  expect(references).toHaveTextContent('失效/未读取引用 1 个')
  expect(save).toHaveBeenCalledTimes(1)
  expect(draft.plans[0]!.placements.ghost1).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '保存到服务器' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(Object.keys(save.mock.calls[1]![0].plans[0].placements)).toEqual(['za', 'ghost2'])
})
