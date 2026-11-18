import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CounterLocations } from '@/pages/Flow/CounterLocations'
import type { Counter } from '@/api/flowService'
import type { CounterSelection } from '@/pages/Analytics/analyticsLinkContext'

const binding = (id: string, name: string) => ({ binding_id: id, source_id: 's', zone_id: id, zone_name: name, active: true })
const counter = { counter_id: 'a', name: '门店客流', outputs: 'in', names: { in: '进', out: '出' }, bindings: [binding('a-door', '门口'), binding('a-hall', '大厅')] } as unknown as Counter
const sel = (bindings: string[]) => ({ counters: [counter], bindings, toggleBinding: vi.fn(), setBindings: vi.fn(), items: null, openRecords: vi.fn() }) as unknown as CounterSelection

it('a statistic card picks its locations the same way as an alarm rule card: only one, or all again', () => {
  const s = sel(['a-door', 'a-hall', 'other-counter-zone'])
  const { rerender } = render(<CounterLocations counter={counter} sel={s} zoneName={z => z.zone_name ?? ''} onClear={vi.fn()} />)
  const group = screen.getByRole('group', { name: '门店客流 的统计位置' })
  expect(group).toHaveTextContent('已选 2 / 2')
  fireEvent.click(within(group).getByRole('button', { name: '只看 大厅' }))
  // Another statistic's locations (a total of several) are not this card's to drop.
  expect(s.setBindings).toHaveBeenCalledWith(['other-counter-zone', 'a-hall'])
  const narrowed = sel(['a-hall'])
  rerender(<CounterLocations counter={counter} sel={narrowed} zoneName={z => z.zone_name ?? ''} onClear={vi.fn()} />)
  expect(within(screen.getByRole('group', { name: '门店客流 的统计位置' })).getByRole('checkbox', { name: '大厅' })).toBeDisabled()
  fireEvent.click(within(screen.getByRole('group', { name: '门店客流 的统计位置' })).getByRole('button', { name: '全选' }))
  expect(narrowed.setBindings).toHaveBeenCalledWith(['a-door', 'a-hall'])
})
