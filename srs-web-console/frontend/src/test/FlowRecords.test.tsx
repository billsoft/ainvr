import {render,screen,fireEvent,waitFor,act} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import {RecordsDrawer} from '@/pages/Flow/RecordsDrawer'
import {flowService,type CounterResult,type Counter} from '@/api/flowService'
vi.mock('@/api/flowService',()=>({flowService:{records:vi.fn()}}))
const start='2026-10-23T00:00:00Z',end='2026-10-23T01:00:00Z'
const counter:Counter={counter_id:'ship',name:'登船',method:'line',labels:[],outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:2000,state:'enabled',version:1,bindings:[]}
function zone(id:string,source:string,into:number,out:number):CounterResult['zones'][number]{
 const series=(n:number)=>({occurrences:n,tracked_targets:n,coverage:{state:'complete' as const},buckets:[{from:start,to:end,occurrences:n}]})
 return {binding_id:id,zone_id:id,zone_name:id,source_id:source,processor_id:'ai',active:true,counting:true,direction:{kind:'line',edge:'a',in_side:'inward'},in:series(into),out:series(out)}
}
function data(zones=[zone('前口','前相机',10,2),zone('后口','后相机',3,8)]):CounterResult{
 const series=(o:'in'|'out')=>({occurrences:zones.reduce((n,z)=>n+z[o]!.occurrences,0),coverage:'complete' as const,buckets:[{from:start,to:end,occurrences:zones.reduce((n,z)=>n+z[o]!.occurrences,0)}]})
 return {counter,zones,in:series('in'),out:series('out')}
}

beforeEach(()=>vi.mocked(flowService.records).mockReset())
function setup(bindingId?:string){render(<MemoryRouter><RecordsDrawer result={data()} from={start} to={end} output="in" bindingId={bindingId} zoneName={z=>z.zone_name!} onClose={vi.fn()}/></MemoryRouter>)}
it('aggregate requires an explicit location before loading records',async()=>{
 vi.mocked(flowService.records).mockResolvedValue({items:[],next_cursor:null})
 setup()
 expect(flowService.records).not.toHaveBeenCalled()
 fireEvent.change(screen.getByRole('combobox',{name:'记录所属热区'}),{target:{value:'后口'}})
 await waitFor(()=>expect(flowService.records).toHaveBeenCalledWith(expect.objectContaining({binding_id:'后口',output:'in'})))
})
it('late records from another location cannot appear under the current camera',async()=>{
 let resolveOld!:(v:any)=>void
 vi.mocked(flowService.records).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve})).mockResolvedValue({items:[],next_cursor:null})
 setup('前口')
 fireEvent.change(screen.getByRole('combobox',{name:'记录所属热区'}),{target:{value:'后口'}})
 await screen.findByText('这段时间没有记录。')
 await act(async()=>resolveOld({items:[{event_id:'old',occurred_at:start,label_id:'person'}],next_cursor:null}))
 expect(screen.queryByRole('link',{name:'录像'})).not.toBeInTheDocument()
 expect(screen.getByText('这段时间没有记录。')).toBeInTheDocument()
})
it('links the actual source and event window to existing automatic replay',async()=>{
 vi.mocked(flowService.records).mockResolvedValue({items:[{event_id:'event',occurred_at:start,label_id:'person',track_id:'track',frame_id:'frame',stream_session_id:'session'}],next_cursor:null})
 setup('后口')
 const link=await screen.findByRole('link',{name:'录像'})
 const url=new URL(link.getAttribute('href')!,'https://console.test')
 expect(decodeURIComponent(url.pathname)).toBe('/playback/后相机')
 expect(url.searchParams.get('from')).toBe(String(Date.parse(start)-20000))
 expect(url.searchParams.get('to')).toBe(String(Date.parse(start)+20000))
 expect(url.searchParams.get('autoplay')).toBe('1')
})
it('keeps an unavailable direction unknown and does not query it',async()=>{
 vi.mocked(flowService.records).mockResolvedValue({items:[],next_cursor:null})
 const result=data([zone('前口','前相机',10,2)])
 result.zones[0]!.out=undefined
 render(<MemoryRouter><RecordsDrawer result={result} from={start} to={end} output="in" bindingId="前口" zoneName={z=>z.zone_name!} onClose={vi.fn()}/></MemoryRouter>)
 expect(screen.getByRole('button',{name:'出 —'})).toBeDisabled()
 await waitFor(()=>expect(flowService.records).toHaveBeenCalledTimes(1))
 expect(flowService.records).toHaveBeenCalledWith(expect.objectContaining({output:'in'}))
})
