import {fireEvent, render, screen} from '@testing-library/react'
import {MemoryRouter, useLocation} from 'react-router-dom'
import {expect, it} from 'vitest'
import {AnalyticsSubjectSwitch} from '@/pages/Analytics/AnalyticsSubjectSwitch'

function Harness(){
 const location=useLocation()
 return <><AnalyticsSubjectSwitch locations={[{channel_id:'a',zone_id:'z'}]}/><output data-testid="url">{location.search}</output></>
}
it('does not widen an oversized inherited location scope to all alarms',()=>{
 const positions=Array.from({length:101},(_,i)=>({channel_id:'a',zone_id:String(i)}))
 function Large(){const location=useLocation();return <><AnalyticsSubjectSwitch locations={positions}/><output data-testid="large-url">{location.search}</output></>}
 render(<MemoryRouter><Large/></MemoryRouter>)
 fireEvent.change(screen.getByLabelText('统计对象'),{target:{value:'alarms'}})
 const params=new URLSearchParams(screen.getByTestId('large-url').textContent!)
 expect(params.get('alarm_locations')).toBe('[]')
 expect(params.get('alarm_scope_origin')).toBe('limit')
})
it('carries paired positions while preserving time and the original flow selection',()=>{
 render(<MemoryRouter initialEntries={['/analytics?range=yesterday&bindings=%5B%22b1%22%5D']}><Harness/></MemoryRouter>)
 fireEvent.change(screen.getByLabelText('统计对象'),{target:{value:'alarms'}})
 const params=new URLSearchParams(screen.getByTestId('url').textContent!)
 expect(params.get('range')).toBe('yesterday')
 expect(JSON.parse(params.get('alarm_locations')!)).toEqual([{channel_id:'a',zone_id:'z'}])
 expect(params.get('alarm_scope_origin')).toBe('flow')
 fireEvent.change(screen.getByLabelText('统计对象'),{target:{value:'flow'}})
 expect(new URLSearchParams(screen.getByTestId('url').textContent!).get('bindings')).toBe('["b1"]')
})
