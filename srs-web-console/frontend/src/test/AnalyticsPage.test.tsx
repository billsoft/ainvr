import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import AnalyticsPage from '@/pages/Analytics'
import { flowService, type CounterResult } from '@/api/flowService'
import { alarmEventService } from '@/api/alarmEventService'
import { bucketCoverage, bucketValue, counterUnit, csvCell, selectedRows, sumKnown, toCsv, weekPattern, weekWindow } from '@/pages/Analytics/analyticsSource'

vi.mock('@/api/flowService', async original => ({...await original<typeof import('@/api/flowService')>(),flowService:{list:vi.fn(),query:vi.fn(),records:vi.fn()}}))
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{statistics:vi.fn()}}))
vi.mock('@/api/floorPlanService',()=>({createFloorPlanSession:()=>({load:async()=>({version:2,plans:[],activeId:null}),save:async()=>{},dispose:()=>{}})}))
vi.mock('@/pages/Analytics/plan/PlanCanvas',()=>({PlanCanvas:()=> <div data-testid="analytics-map-values"/>}))
const from='2026-10-01T00:00:00.000Z', mid='2026-10-01T00:30:00.000Z', to='2026-10-01T01:00:00.000Z'
const coverage={state:'partial' as const,ratio:.5,expected_ms:3600000,covered_ms:1800000,expected_intervals:[{from,to}],intervals:[{from,to:mid}]}
const counter={counter_id:'counter',name:'=counter',labels:[{label_id:'person',name:'人'}],method:'line',outputs:'both',names:{in:'进入',out:'离开'},occupancy:false,max_gap_ms:0,state:'enabled',version:1,bindings:[
 {binding_id:'b1',source_id:'s',processor_id:'p',zone_id:'z1',zone_name:'门一',active:true,counting:true,direction:{kind:'line',edge:'e',in_side:'inward'}},
 {binding_id:'b2',source_id:'s',processor_id:'p',zone_id:'z2',zone_name:'门二',active:true,counting:true,direction:{kind:'line',edge:'e',in_side:'inward'}}
]}
const series={occurrences:4,tracked_targets:1,coverage,buckets:[{from,to,occurrences:4}]}
const result={counter,in:{occurrences:104,buckets:[],coverage:'partial'},zones:[
 {...counter.bindings[0],in:series,out:{...series,occurrences:2}},
 {...counter.bindings[1],in:{...series,occurrences:100},out:series}
]} as unknown as CounterResult
it('refreshes fixed-range alarms and counter definitions while retaining selected bindings',async()=>{
 const query=new URLSearchParams({range:'yesterday',counters:'["counter"]',bindings:'["b1"]'})
 render(<MemoryRouter initialEntries={['/analytics?'+query]}><AnalyticsPage/></MemoryRouter>)
 await screen.findByText('4 人次')
 await waitFor(()=>expect(alarmEventService.statistics).toHaveBeenCalled())
 const before=vi.mocked(alarmEventService.statistics).mock.calls.length
 fireEvent.click(screen.getByRole('button',{name:'刷新'}))
 await waitFor(()=>expect(flowService.list).toHaveBeenCalledTimes(2))
 await waitFor(()=>expect(vi.mocked(alarmEventService.statistics).mock.calls.length).toBeGreaterThan(before))
 expect(await screen.findByText('4 人次')).toBeInTheDocument()
 expect(screen.getByText('统计位置 1')).toBeInTheDocument()
})
it('uses configured direction names across cards and does not invent an unused exit direction',async()=>{
 const single={...counter,names:{in:'上船',out:'下船'},outputs:'in'}
 vi.mocked(flowService.list).mockResolvedValue({items:[single]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[{...result,counter:single}]} as never)
 render(<MemoryRouter><AnalyticsPage/></MemoryRouter>)
 expect(await screen.findByRole('group',{name:'已记录上船'})).toBeInTheDocument()
 expect(screen.queryByRole('group',{name:'已记录离开'})).not.toBeInTheDocument()
 expect(within(screen.getByLabelText('概览')).getByRole('group',{name:'统计方向'})).toHaveTextContent('单向计数')
})
beforeEach(()=>{
 vi.clearAllMocks()
 vi.mocked(flowService.list).mockResolvedValue({items:[counter]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[result]} as never)
 vi.mocked(alarmEventService.statistics).mockResolvedValue({total:3,as_of:to,handling:{},review:{},association:{unassociated:2}})
})
it('uses per-bucket measured intersection; legacy and absent measurements never become zero',()=>{
 expect(bucketCoverage(coverage,{from,to:mid},{from,to})).toEqual({ratio:1,state:'complete'})
 expect(bucketCoverage(coverage,{from:mid,to},{from,to})).toEqual({ratio:0,state:'no_data'})
 expect(bucketCoverage({state:'complete'},{from,to},{from,to}).ratio).toBeNull()
 expect(bucketValue({...series,occurrences:0,buckets:[],coverage:{state:'complete'}},{from,to},{from,to})).toBeNull()
 expect(sumKnown([0,null])).toBeNull()
 expect(sumKnown([0,0])).toBe(0)
 expect(sumKnown([4,null])).toBe(4)
})
it('keeps human, vehicle and mixed counting units distinct',()=>{
 expect(counterUnit({labels:[{label_id:'person'}]})).toBe('人次')
 expect(counterUnit({labels:[{label_id:'class:0',name:'person'}]})).toBe('人次')
 expect(counterUnit({labels:[{label_id:'class:2',name:'car'}]})).toBe('车次')
 expect(counterUnit({labels:[{label_id:'car'},{label_id:'bus'}]})).toBe('车次')
 expect(counterUnit({labels:[{label_id:'person'},{label_id:'car'}]})).toBe('次')
 expect(counterUnit({labels:[]})).toBe('次')
})
it('counts only observation time intersecting proven applicable periods, including exact boundaries',()=>{
 const at=(minutes:number)=>new Date(Date.parse(from)+minutes*60000).toISOString()
 const c={state:'complete' as const,expected_intervals:[{from,to:at(20)},{from:at(40),to}],intervals:[{from:at(10),to:at(50)}]}
 expect(bucketCoverage(c,{from,to},{from,to})).toEqual({ratio:.5,state:'partial'})
 expect(bucketCoverage(c,{from:at(20),to:at(40)},{from,to})).toEqual({ratio:null,state:'not_applicable'})
 expect(bucketCoverage(c,{from:at(40),to:at(50)},{from,to})).toEqual({ratio:1,state:'complete'})
})
it('keeps many adjacent observed fragments exact without reprocessing them for every bucket',()=>{
 const at=(ms:number)=>new Date(Date.parse(from)+ms).toISOString(),end=at(1000000)
 const c={state:'complete' as const,expected_intervals:[{from,to:end}],intervals:Array.from({length:10000},(_,i)=>({from:at(i*100),to:at((i+1)*100)}))}
 for(let i=0;i<1000;i++)expect(bucketCoverage(c,{from:at(i*1000),to:at((i+1)*1000)},{from,to:end})).toEqual({ratio:1,state:'complete'})
})
it('filters by actual binding and escapes CSV formula injection with bucket coverage',()=>{
 const rows=selectedRows([result],[{counterId:'counter',bindingId:'b1'}])
 expect(rows).toHaveLength(1)
 const csv=toCsv(rows,[{from,to:mid},{from:mid,to}],{from,to},'UTC',to)
 expect(csv).toContain('"\'=counter"')
 expect(csv).toContain('"完整","1"')
 expect(csv).toContain('"无覆盖","0"')
 expect(csv).not.toContain('门二')
 expect(csvCell('  @SUM(1)')).toContain("'  @")
})
it('uses four complete weeks and leaves uncovered samples empty',()=>{
 const end=new Date(2026,9,30,12),window=weekWindow(end)
 expect(window.to.getDay()).toBe(1)
 expect(window.to.getHours()).toBe(0)
 expect((window.to.getTime()-window.from.getTime())/86400000).toBe(28)
 const cells=weekPattern(selectedRows([result],[{counterId:'counter',bindingId:'b1'}]),window.from,window.to)
 expect(cells.flat().every(c=>c.value===null&&c.samples===0)).toBe(true)
})
it('uses counter and binding filters without repeating flow queries on binding changes',async()=>{
 render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)
 expect(await screen.findByText('104 人次')).toBeInTheDocument()
 await waitFor(()=>expect(flowService.query).toHaveBeenCalledTimes(3))
 fireEvent.click(screen.getByText('统计位置 2'))
 fireEvent.click(screen.getByLabelText(/门二/))
 expect(await screen.findByText('4 人次')).toBeInTheDocument()
 expect(flowService.query).toHaveBeenCalledTimes(3)
 expect(vi.mocked(flowService.query).mock.calls.every(([q])=>q.counter_ids?.[0]==='counter')).toBe(true)
 await waitFor(()=>expect(alarmEventService.statistics).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),[{channel_id:'p',zone_id:'z1'}]))
})

it('restores selected bindings from a shared URL and shows the recorded peak with a coverage warning',async()=>{
 const query=new URLSearchParams({counters:JSON.stringify(['counter']),bindings:JSON.stringify(['b1']),compare:'0'})
 render(<MemoryRouter initialEntries={['/analytics?'+query]}><AnalyticsPage /></MemoryRouter>)
 expect(await screen.findByText('4 人次')).toBeInTheDocument()
 expect(screen.getByText('统计位置 1')).toBeInTheDocument()
 expect(screen.getByText('已记录峰值')).toBeInTheDocument()
 expect(screen.queryByText('104 人次')).not.toBeInTheDocument()
})

it('combines compatible counters in one query and excludes different target definitions',async()=>{
 const compatible={...counter,counter_id:'counter2',name:'入口二',bindings:[{...counter.bindings[0],binding_id:'b3',zone_id:'z3',zone_name:'门三'}]}
 const incompatible={...counter,counter_id:'vehicles',name:'车辆',labels:[{label_id:'car',name:'车'}]}
 vi.mocked(flowService.list).mockResolvedValue({items:[counter,compatible,incompatible]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[result,{...result,counter:compatible,zones:[{...compatible.bindings[0],in:series,out:series}]}]} as never)
 render(<MemoryRouter><AnalyticsPage/></MemoryRouter>)
 await screen.findByText('104 人次')
 fireEvent.click(screen.getByText(/^计数器 1\//))
 expect(screen.getByLabelText(/车辆/)).toBeDisabled()
 fireEvent.click(screen.getByLabelText('入口二'))
 await waitFor(()=>expect(vi.mocked(flowService.query).mock.calls.some(([q])=>q.counter_ids?.length===2)).toBe(true))
 expect(await screen.findByText('108 人次')).toBeInTheDocument()
})

it('keeps a dirty floor plan open across automatic refresh intervals',async()=>{
 vi.useFakeTimers()
 try{
  await act(async()=>{render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'编辑平面图'}))})
  fireEvent.change(screen.getByLabelText('平面图名称'),{target:{value:'未保存的布局'}})
  const calls=vi.mocked(flowService.query).mock.calls.length
  await act(async()=>{await vi.advanceTimersByTimeAsync(125000)})
  expect(screen.getByRole('dialog',{name:'平面图编辑'})).toBeInTheDocument()
  expect(screen.getByLabelText('平面图名称')).toHaveValue('未保存的布局')
  expect(flowService.query).toHaveBeenCalledTimes(calls)
 }finally{vi.useRealTimers()}
})
it('freezes the analysis range while a region observation is selected',async()=>{
 vi.useFakeTimers()
 try{
  await act(async()=>{render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)})
  await act(async()=>{fireEvent.click(screen.getByRole('tab',{name:'热区'}))})
  fireEvent.change(screen.getByRole('combobox',{name:'停留位置'}),{target:{value:'0'}})
  const calls=vi.mocked(flowService.query).mock.calls.length
  await act(async()=>{await vi.advanceTimersByTimeAsync(125000)})
  expect(screen.getByRole('combobox',{name:'停留位置'})).toHaveValue('0')
  expect(flowService.query).toHaveBeenCalledTimes(calls)
  expect(screen.getByTitle(/分析期间固定查询截止时间/)).toBeInTheDocument()
 }finally{vi.useRealTimers()}
})

it('retains global compatible totals but never merges two counters into one map reading', async () => {
 const shared = {...counter,counter_id:'counter2',name:'同区另一计数器',bindings:[{...counter.bindings[0],binding_id:'b3'}]}
 vi.mocked(flowService.list).mockResolvedValue({items:[counter,shared]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[result,{...result,counter:shared,zones:[{...shared.bindings[0],in:{...series,occurrences:7},out:series}]}]} as never)
 render(<MemoryRouter><AnalyticsPage/></MemoryRouter>)
 await screen.findByText('104 人次')
 fireEvent.click(screen.getByText(/^计数器 1\//))
 fireEvent.click(screen.getByLabelText('同区另一计数器'))
 expect(await screen.findByText('111 人次')).toBeInTheDocument()
 expect(within(screen.getByRole('table',{name:'热区排名'})).getAllByRole('cell').map(c=>c.textContent)).toEqual(expect.arrayContaining(['4','100']))
 fireEvent.change(screen.getByLabelText('地图计数器'),{target:{value:'counter2'}})
 expect(within(screen.getByRole('table',{name:'热区排名'})).getAllByRole('cell').map(c=>c.textContent)).toEqual(expect.arrayContaining(['7']))
 expect(within(screen.getByRole('table',{name:'热区排名'})).queryByRole('cell',{name:'100'})).not.toBeInTheDocument()
})
it('lists historical bindings without selecting them by default and restores explicit historical URL selections', async () => {
 const historical={...counter.bindings[0],binding_id:'old-binding',zone_id:'old-zone',zone_name:'旧入口',active:false}
 const definition={...counter,bindings:[...counter.bindings,historical]}
 vi.mocked(flowService.list).mockResolvedValue({items:[definition]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[{...result,counter:definition,zones:[...result.zones,{...historical,in:{...series,occurrences:9},out:series}]}]} as never)
 const initial=render(<MemoryRouter><AnalyticsPage/></MemoryRouter>)
 await screen.findByText('104 人次')
 expect(flowService.list).toHaveBeenCalledWith({includeInactiveBindings:true})
 fireEvent.click(screen.getByText('统计位置 2'))
 expect(screen.getByLabelText(/旧入口（已解绑\/历史）/)).not.toBeChecked()
 initial.unmount()
 const query=new URLSearchParams({counters:JSON.stringify(['counter']),bindings:JSON.stringify(['old-binding']),compare:'0'})
 render(<MemoryRouter initialEntries={['/analytics?'+query]}><AnalyticsPage/></MemoryRouter>)
 expect(await screen.findByText('9 人次')).toBeInTheDocument()
 fireEvent.click(screen.getByText('统计位置 1'))
 expect(screen.getByLabelText(/旧入口（已解绑\/历史）/)).toBeChecked()
 expect(within(screen.getByRole('table',{name:'热区排名'})).getAllByRole('cell').map(c=>c.textContent)).toContain('9')
})

it('keeps four compact metrics and the comparison gate while putting full statistical explanations behind a disclosure', async () => {
 render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)
 await screen.findByText('104 人次')
 const overview=screen.getByRole('region',{name:'概览'})
 expect(within(overview).getAllByRole('group')).toHaveLength(4)
 const entering=within(overview).getByRole('group',{name:'已记录进入'})
 expect(entering).toHaveTextContent('104 人次')
 expect(within(entering).getByLabelText(/覆盖不完整或未知，不计算变化率/)).toHaveTextContent('对比不足')
 expect(screen.getByRole('status',{name:'数据状态'})).toHaveTextContent('覆盖不足或未知，已记录量可能偏低')
 const explanation=screen.getByLabelText('统计说明')
 expect(explanation).not.toHaveAttribute('open')
 fireEvent.click(explanation.querySelector('summary')!)
 expect(explanation).toHaveAttribute('open')
 const content=screen.getByRole('region',{name:'统计说明详情'})
 expect(content).toHaveTextContent('已记录量不代表缺口内为零')
 expect(content).toHaveTextContent('覆盖不是识别准确率')
 expect(content).toHaveTextContent('仅在两期位置匹配、覆盖完整时计算变化率')
 expect(content).toHaveTextContent('另有 2 条未关联位置（未计入总数）')
})
it('retains model category metadata and query scope when switching between the overview and two-pane region view', async () => {
 const definition={...counter,labels:[{label_id:'class:0',name:'person'}]}
 vi.mocked(flowService.list).mockResolvedValue({items:[definition]} as never)
 vi.mocked(flowService.query).mockResolvedValue({from,to,items:[{...result,counter:definition}]} as never)
 render(<MemoryRouter><AnalyticsPage /></MemoryRouter>)
 await screen.findByText('104 人次')
 await waitFor(()=>expect(flowService.query).toHaveBeenCalledTimes(3))
 const regionTab=screen.getByRole('tab',{name:'热区'})
 await act(async()=>{fireEvent.click(regionTab)})
 expect(regionTab).toHaveAttribute('aria-selected','true')
 const regionView=screen.getByRole('tabpanel',{name:'热区'})
 expect(regionView).toContainElement(screen.getByTestId('analytics-map-values'))
 expect(within(regionView).getByRole('region',{name:'停留观测'})).toHaveTextContent('筛选类别：人员')
 expect(screen.getByRole('combobox',{name:'停留位置'})).toHaveValue('')
 expect(flowService.query).toHaveBeenCalledTimes(3)
 await act(async()=>{fireEvent.click(screen.getByRole('tab',{name:'总览'}))})
 expect(screen.getByRole('tabpanel',{name:'总览'})).toContainElement(screen.getByRole('region',{name:'客流趋势'}))
 expect(screen.getByText('统计位置 2')).toBeInTheDocument()
 expect(flowService.query).toHaveBeenCalledTimes(3)
})
