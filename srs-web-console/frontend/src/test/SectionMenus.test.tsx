import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, RouterProvider } from 'react-router-dom'
import { ScanLine } from 'lucide-react'
import { SideDockedSection } from '@/components/layout/SideDockedSection'
import { Sidebar } from '@/components/layout/Sidebar'
import { router } from '@/router'

const tabs = [{ to: '/alarms', name: '告警记录' }, { to: '/alarms/rules', name: '告警规则' }]

// A host whose measured width the test controls (jsdom has no layout).
let width = 1600
const observers: ResizeObserverCallback[] = []
class FakeObserver {
  constructor(cb: ResizeObserverCallback) { observers.push(cb) }
  observe() { /* the width is pushed by resize() */ }
  disconnect() { /* nothing to release */ }
}
function resize(next: number) {
  width = next
  act(() => { for (const cb of observers) cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver) })
}
beforeEach(() => {
  observers.length = 0
  width = 1600
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', FakeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
})
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth') })

function section(path = '/alarms') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SideDockedSection label="告警" tabs={tabs} sideRoute="/alarms/rules" storageKey="test.columns" middleMin={640}
        sideTitle="告警规则" sideIcon={ScanLine} middle={<p>records here</p>} side={<p>rules here</p>} />
    </MemoryRouter>,
  )
}

it('puts alarms in one menu entry and counters under statistics', () => {
  render(<MemoryRouter><Sidebar /></MemoryRouter>)
  const nav = screen.getByRole('navigation', { name: '主导航' })
  for (const gone of ['告警触发', '告警列表', '流量统计']) expect(nav).not.toHaveTextContent(gone)
  expect(screen.getByRole('link', { name: /统计分析/ })).toHaveAttribute('href', '/analytics')
  expect(screen.getByRole('link', { name: /^告警$/ })).toHaveAttribute('href', '/alarms')
})

it('docks the rules beside the records on a wide page, with no tabs', () => {
  section()
  expect(screen.getByText('records here')).toBeVisible()
  expect(screen.getByText('rules here')).toBeVisible()
  expect(screen.queryByRole('navigation', { name: '告警' })).toBeNull()
})

it('folds to a labelled rail, remembers it, and opens again with one click', async () => {
  const first = section()
  await userEvent.click(screen.getByRole('button', { name: '收起告警规则' }))
  expect(screen.getByText('rules here')).not.toBeVisible()
  expect(localStorage.getItem('test.columns')).toBe('closed')
  first.unmount()
  section()
  expect(screen.getByRole('button', { name: '告警规则', pressed: false })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '告警规则' }))
  expect(screen.getByText('rules here')).toBeVisible()
  expect(localStorage.getItem('test.columns')).toBe('open')
})

it('opens the column when the address asks for it, even if it was folded', () => {
  localStorage.setItem('test.columns', 'closed')
  section('/alarms/rules')
  expect(screen.getByText('rules here')).toBeVisible()
})

it('falls back to two tabs on a narrow page without losing the middle', async () => {
  section()
  resize(900)
  expect(screen.getByRole('navigation', { name: '告警' })).toBeVisible()
  expect(screen.getByText('records here')).toBeVisible()
  await userEvent.click(screen.getByRole('link', { name: '告警规则' }))
  expect(screen.getByText('rules here')).toBeVisible()
  expect(screen.getByText('records here')).not.toBeVisible()
  expect(screen.getByRole('link', { name: '告警记录' })).not.toHaveAttribute('aria-current')
})

it('keeps the old addresses working and carries their query along', async () => {
  render(<RouterProvider router={router} />)
  await router.navigate('/alarm-analysis?x=1')
  await waitFor(() => expect(router.state.location.pathname).toBe('/alarms/rules'))
  expect(router.state.location.search).toBe('?x=1')
  await router.navigate('/flow-statistics')
  await waitFor(() => expect(router.state.location.pathname).toBe('/analytics/counters'))
})

it('keeps the column open after a link inside it leaves the column address', async () => {
  localStorage.setItem('test.columns', 'closed')
  render(
    <MemoryRouter initialEntries={['/alarms/rules']}>
      <SideDockedSection label="告警" tabs={tabs} sideRoute="/alarms/rules" storageKey="test.columns" middleMin={640}
        sideTitle="告警规则" sideIcon={ScanLine} middle={<p>records here</p>} side={<Link to="/alarms">see records</Link>} />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('link', { name: 'see records' }))
  expect(screen.getByRole('link', { name: 'see records' })).toBeVisible()
})
