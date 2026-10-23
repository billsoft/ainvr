import {render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import {rangeOf,validateCustomRange} from '@/pages/Flow/flowRange'
import FlowPage from '@/pages/Flow'
import {flowService} from '@/api/flowService'
vi.mock('@/api/flowService',async original=>({...await original<typeof import('@/api/flowService')>(),flowService:{list:vi.fn(),query:vi.fn(),records:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([])}}))
vi.mock('@/components/ui/DateTimeRangePicker',()=>({DateTimeRangePicker:({onConfirm,onClose,from,to}:any)=><div role="dialog" aria-label="选择时间范围"><span>{from} / {to}</span><button onClick={()=>{onConfirm('2026-10-01T08:12:13','2026-10-02T10:23:24');onClose()}}>应用测试范围</button><button onClick={onClose}>取消选择</button></div>}))
const counter={counter_id:'ship',name:'登船',method:'line' as const,labels:[],outputs:'both' as const,names:{in:'进',out:'出'},occupancy:true,max_gap_ms:2000,state:'enabled' as const,version:1,bindings:[]}
const z={binding_id:'b',zone_id:'z',zone_name:'后门',source_id:'cam',processor_id:'ai',active:true,counting:true,direction:{kind:'line' as const,edge:'a',in_side:'inward' as const}}
const series={occurrences:2,tracked_targets:2,coverage:{state:'complete' as const},buckets:[]}
beforeEach(()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[{...counter,bindings:[z]}]})
 vi.mocked(flowService.query).mockReset().mockImplementation(async input=>({from:input.from,to:input.to,items:[{counter,in:{...series,coverage:'complete'},out:{...series,coverage:'complete'},zones:[{...z,in:series,out:series}]}]}))
 vi.mocked(flowService.records).mockResolvedValue({items:[],next_cursor:null})
})
it('custom endpoints include the chosen final second, and the preceding period has identical duration',()=>{
 const custom={from:new Date('2026-10-01T08:12:13'),to:new Date('2026-10-02T10:23:24')},r=rangeOf('custom',new Date(),custom)
 expect(r.from).toEqual(custom.from);expect(r.to.getTime()).toBe(custom.to.getTime()+1000)
 expect(r.previous.to).toEqual(r.from)
 expect(r.previous.to.getTime()-r.previous.from.getTime()).toBe(r.to.getTime()-r.from.getTime())
 expect(r.bucket).toBe('hour')
 expect(rangeOf('custom',new Date(),{...custom,to:new Date('2026-10-05T00:00:00')}).bucket).toBe('day')
 expect(validateCustomRange(new Date('2026-10-01T00:00:00'),new Date('2026-10-31T23:59:59'))).toBeNull()
 expect(validateCustomRange(new Date('2026-10-01T00:00:00'),new Date('2026-11-01T00:00:00'))).toContain('31 天')
 expect(rangeOf('yesterday',new Date('2026-10-23T12:00:00')).to.getHours()).toBe(0)
})
it('cancel leaves the preset and query unchanged; custom queries and record links share exact endpoints',async()=>{
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 await screen.findByRole('button',{name:'进合计 2，查看通行记录'})
 fireEvent.click(screen.getByRole('button',{name:'自选时间范围'}))
 const calls=vi.mocked(flowService.query).mock.calls.length
 fireEvent.click(screen.getByRole('button',{name:'取消选择'}))
 expect(flowService.query).toHaveBeenCalledTimes(calls)
 expect(screen.getByRole('button',{name:'今天'})).toHaveAttribute('aria-pressed','true')
 fireEvent.click(screen.getByRole('button',{name:'自选时间范围'}))
 fireEvent.click(screen.getByRole('button',{name:'应用测试范围'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'自选时间范围'})).toHaveAttribute('aria-pressed','true'))
 const expected={from:new Date('2026-10-01T08:12:13').toISOString(),to:new Date(new Date('2026-10-02T10:23:24').getTime()+1000).toISOString()}
 await waitFor(()=>expect(flowService.query).toHaveBeenCalledWith(expect.objectContaining({...expected,bucket:'hour'})))
 await screen.findByRole('button',{name:'进合计 2，查看通行记录'})
 fireEvent.click(screen.getByRole('button',{name:'进合计 2，查看通行记录'}))
 await waitFor(()=>expect(flowService.records).toHaveBeenCalledWith(expect.objectContaining(expected)))
 fireEvent.click(within(screen.getByRole('dialog',{name:'通行记录 · 登船'})).getByRole('button',{name:'关闭'}))
 fireEvent.click(screen.getByRole('button',{name:'昨天'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'自选时间范围'})).toHaveAttribute('aria-pressed','false'))
 expect(screen.queryByLabelText('当前自选时间范围')).not.toBeInTheDocument()
})
