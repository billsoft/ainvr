import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { PlanCanvas } from '@/pages/Analytics/plan/PlanCanvas'
import type { Plan, ZoneInfo } from '@/pages/Analytics/plan/planModel'

vi.mock('react-konva', () => ({
  Stage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Layer: ({ children, name }: { children: ReactNode; name?: string }) => <div data-testid={name}>{children}</div>,
  Group: ({ children, id }: { children: ReactNode; id: string }) => <div data-testid={id}>{children}</div>,
  Text: ({ text }: { text: string }) => <span>{text}</span>,
  Rect: ({ name, fill }: { name?: string; fill?: string }) => name === 'placement-outline' ? <span data-testid="placement-fill">{fill}</span> : null,
  Shape: () => <span>独立热度场</span>, Line: () => null, Image: () => null, Transformer: () => null,
}))
const placement = { x: 0, y: 0, w: 200, h: 100 }
it('renders observed source grids in their own display layer without coloring or changing planning geometry',()=>{
 const plan:Plan={id:'p',name:'布局',image:null,shapes:[],placements:{hot:placement}}
 const zones:ZoneInfo[]=[{key:'hot',zoneId:'hot',channelId:'p',name:'入口',counters:[]}]
 const variant={input_stream_id:'s',geometry_revision:'g',view_epoch:null,zone_version:1,source_width:1920,source_height:1080,columns:16,rows:9,values_ms:Array(144).fill(100),observed_ms:14400,from:'2026-10-30T01:00:00Z',to:'2026-10-30T01:01:00Z'}
 const view=render(<PlanCanvas plan={plan} zones={zones} sourceHeat={{zoneKey:'hot',variant}} selectedKey="hot" readOnly onSelectZone={vi.fn()}/>)
 expect(screen.getByTestId('source-heat-inset')).toBeInTheDocument()
 expect(screen.queryByTestId('count-heat-overlay')).not.toBeInTheDocument()
 expect(screen.getByTestId('placement-fill')).toHaveTextContent('transparent')
 expect(plan.placements.hot).toEqual(placement)
 view.rerender(<PlanCanvas plan={plan} zones={zones} sourceHeat={{zoneKey:'hot',variant}} selectedKey="hot" onSelectZone={vi.fn()}/>)
 expect(screen.queryByTestId('source-heat-inset')).not.toBeInTheDocument()
})
it('keeps unresolved references visible without placing statistical numbers on planning frames', () => {
  const plan: Plan = { id: 'p', name: '存量', image: null, shapes: [],
    placements: { missing: placement, zero: placement, unknown: placement } }
  const zones: ZoneInfo[] = ['zero', 'unknown'].map(key => ({
    key, zoneId: key, channelId: 'processor', name: key === 'zero' ? '已确认零值' : '未知位置', counters: [],
  }))
  render(<PlanCanvas plan={plan} zones={zones} selectedKey={null} readOnly onSelectZone={vi.fn()} />)
  const unresolved = screen.getByTestId('zone-missing')
  expect(unresolved).toHaveTextContent('失效/未读取引用')
  expect(unresolved).toHaveTextContent('missing')
  expect(within(screen.getByTestId('zone-zero')).queryByText('0')).not.toBeInTheDocument()
  expect(within(screen.getByTestId('zone-unknown')).queryByText('—')).not.toBeInTheDocument()
})
it('keeps planning frames transparent and draws heat only as a separate read-only overlay', () => {
  const plan: Plan = { id: 'p', name: '布局', image: null, shapes: [], placements: { hot: placement } }
  const zones: ZoneInfo[] = [{ key: 'hot', zoneId: 'hot', channelId: 'p', name: '入口', counters: [] }]
  const view = render(<PlanCanvas plan={plan} zones={zones} heat={[[1]]} selectedKey={null} readOnly onSelectZone={vi.fn()} />)
  expect(screen.getByTestId('placement-fill')).toHaveTextContent('transparent')
  expect(screen.getByTestId('count-heat-overlay')).toHaveTextContent('独立热度场')
  view.rerender(<PlanCanvas plan={plan} zones={zones} heat={[[1]]} selectedKey={null} onSelectZone={vi.fn()} />)
  expect(screen.queryByTestId('count-heat-overlay')).not.toBeInTheDocument()
  expect(screen.getByTestId('placement-fill')).toHaveTextContent('transparent')
})
