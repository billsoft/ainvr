import {render,screen,fireEvent,within} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {CounterStatistics} from '@/pages/Flow/CounterStatistics'
import type {CounterResult,Counter} from '@/api/flowService'
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
function setup(result=data()){
 const onRecords=vi.fn()
 const view=render(<CounterStatistics counter={counter} result={result} comparison="昨天" bucket="hour" slots={[{from:start,to:end}]} zoneName={z=>`${z.source_id} · ${z.zone_name}`} onRecords={onRecords}/> )
 return {onRecords,...view}
}
it('keeps totals fixed while selecting a location trend; number buttons use its binding only',()=>{
 const {onRecords}=setup()
 expect(screen.getByRole('figure',{name:'登船 · 全部热区趋势'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'查看 后相机 · 后口 的趋势'}))
 expect(screen.getByRole('img',{name:'登船 · 后相机 · 后口趋势：进共3，出共8'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'进合计 13，查看通行记录'})).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'查看 后相机 · 后口 的出记录'}))
 expect(onRecords).toHaveBeenLastCalledWith('out','后口')
 fireEvent.click(screen.getByRole('button',{name:'返回全部'}))
 expect(screen.getByRole('img',{name:'登船 · 全部热区趋势：进共13，出共10'})).toBeInTheDocument()
})
it('always shows the single location and a signed negative net instead of claiming occupancy',()=>{
 setup(data([zone('后口','后相机',3,8)]))
 expect(screen.getByRole('button',{name:'查看 后相机 · 后口 的趋势'})).toBeInTheDocument()
 const total=screen.getByRole('region',{name:'整体合计'})
 expect(within(total).getByText('-5')).toBeInTheDocument()
 expect(screen.queryByText('当前在场')).not.toBeInTheDocument()
})
it('search, camera filter and pagination affect the location list only',()=>{
 setup(data(Array.from({length:18},(_,i)=>zone(`口${i}`,i%2?'后相机':'前相机',i,0))))
 expect(screen.getAllByRole('button',{name:/^查看 .* 的趋势$/})).toHaveLength(8)
 fireEvent.click(screen.getByRole('button',{name:'下一页'}))
 expect(screen.getByRole('button',{name:'查看 前相机 · 口8 的趋势'})).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('搜索统计位置'),{target:{value:'口17'}})
 expect(screen.getAllByRole('button',{name:/^查看 .* 的趋势$/})).toHaveLength(1)
 expect(screen.getByRole('button',{name:'进合计 153，查看通行记录'})).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('筛选摄像头'),{target:{value:'前相机'}})
 expect(screen.getByRole('status')).toHaveTextContent('没有匹配')
})
it('puts a diagnostic on its own row and retains removed locations in totals',()=>{
 const r=data();r.zones[1]!.active=false;r.zones[1]!.in!.diagnostic={reason:'passage_gap_rejected',at:start}
 setup(r)
 const row=screen.getByRole('button',{name:'查看 后相机 · 后口 的趋势'}).closest('tr')!
 expect(within(row).getByText('通行诊断')).toBeInTheDocument()
 expect(within(row).getByText('已移除 · 保留本期记录')).toBeInTheDocument()
 expect(within(screen.getByRole('button',{name:'查看 前相机 · 前口 的趋势'}).closest('tr')!).queryByText('通行诊断')).not.toBeInTheDocument()
})
it('missing direction data is unknown, not zero; single-output counters have no net',()=>{
 const r=data();delete r.zones[0]!.out
 const v=setup(r)
 expect(screen.getByRole('button',{name:'查看 前相机 · 前口 的出记录'})).toBeDisabled()
 v.unmount()
 r.counter={...counter,outputs:'in',occupancy:false};delete r.out
 render(<CounterStatistics counter={r.counter} result={r} comparison="昨天" bucket="hour" slots={[]} zoneName={z=>z.zone_name!} onRecords={vi.fn()}/> )
 expect(screen.queryByText('本期净流入')).not.toBeInTheDocument()
})
