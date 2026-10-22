import {render,screen,fireEvent,within,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {tapEdge,pickFrom,pickDirection} from '@/features/countingSelection'
import {countingDrawing} from '@/features/counterGeometry'
import type {ArmingDocument} from '@/features/armingDocument'
import type {Counter,CounterResult} from '@/api/flowService'
import type {AlarmSource} from '@/api/alarmTriggerService'
vi.mock('@/api/flowService',async original=>({...(await original<typeof import('@/api/flowService')>()),flowService:{list:vi.fn(),save:vi.fn(),query:vi.fn(),records:vi.fn(),live:vi.fn(),remove:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([])}}))
const {flowService}=await import('@/api/flowService')
const {default:FlowPage}=await import('@/pages/Flow')
const counter:Counter={counter_id:'visitors',name:'客流',labels:[{label_id:'person',name:'person'}],method:'line',outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled',version:2,
 bindings:[{binding_id:'flow-1',source_id:'cam',processor_id:'ai',zone_id:'z',zone_name:'门口',active:true,counting:true,direction:{kind:'line',edge:'b',in_side:'inward'}}]}
const result=(inside:number,outside:number):CounterResult=>({counter,in:{occurrences:inside,buckets:[],coverage:'complete'},out:{occurrences:outside,buckets:[],coverage:'complete'},
 zones:[{...counter.bindings[0]!,in:{occurrences:inside,tracked_targets:inside,coverage:{state:'complete'},buckets:[]},out:{occurrences:outside,tracked_targets:outside,coverage:{state:'complete'},buckets:[]}}]})
beforeEach(()=>{vi.mocked(flowService.list).mockReset();vi.mocked(flowService.query).mockReset()})
it('一条计数线的“进”箭头指向热区内侧，翻转后指向外侧',()=>{
 const square:[number,number][]=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],ids=['top','right','bottom','left']
 const inward=countingDrawing({kind:'line',edge:'right',in_side:'inward'},square,ids,1000,1000).arrow!
 expect(inward.to[0]).toBeLessThan(inward.from[0])
 const outward=countingDrawing({kind:'line',edge:'right',in_side:'outward'},square,ids,1000,1000).arrow!
 expect(outward.to[0]).toBeGreaterThan(outward.from[0])
 // Clockwise polygons (negative area) keep the same meaning.
 const reversed=countingDrawing({kind:'line',edge:'right',in_side:'inward'},[...square].reverse(),['bottom','right','top','left'],1000,1000).arrow!
 expect(reversed.to[0]).toBeLessThan(reversed.from[0])
})
it('点边不隐式翻转：双线明确 A/B，区域明确进入/离开',()=>{
 let line=tapEdge(pickFrom('line'),'right');expect(pickDirection(line)).toEqual({kind:'line',edge:'right',in_side:'inward'})
 line=tapEdge(line,'right');expect(pickDirection(line)).toMatchObject({in_side:'inward'})
 let gates=tapEdge(pickFrom('gates'),'left');expect(pickDirection(gates)).toBeNull()
 gates=tapEdge(gates,'right');expect(pickDirection(gates)).toEqual({kind:'gates',from:'left',to:'right'})
 let zone=tapEdge(pickFrom('zone'),'left');zone=tapEdge({...zone,target:'exit'},'right')
 expect(pickDirection(zone)).toEqual({kind:'edges',entry:['left'],exit:['right']})
 expect(pickDirection(tapEdge(zone,'right'))).toBeNull()
})
const base:ArmingDocument={source_id:'cam',geometry_revision:'g:1000x500',revision:1,assignments:[],
 zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g:1000x500',version:1,name:'门口',state:'active',points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],edge_ids:['a','b','c','d']}]}
const source:AlarmSource={channel_id:'ai',channel_name:'识别',input_stream_id:'cam',input_name:'大门',label_map_version:'lm',geometry_revision:'g:1000x500',tracking_available:true,
 labels:[{class_id:0,label_id:'person',name:'person',description:''}]}
it('布防里为热区选用计数器：点画面上的边设置计数线，保存时一并提交',async()=>{
 const send=vi.fn().mockResolvedValue({saved:true,sourceId:'cam',revision:2,application:{state:'applied'}})
 render(<ArmingModal sourceId="cam" sourceName="大门" base={base} reference={{url:'image',width:1000,height:500,geometryRevision:'g:1000x500',capturedAt:'now'}}
  definitions={[]} sources={[source]} counters={[{...counter,bindings:[]}]} send={send} onClose={vi.fn()} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'选择热区 门口'}))
 fireEvent.click(screen.getByRole('button',{name:'为 门口 选用计数器'}))
 fireEvent.click(screen.getByRole('radio',{name:/客流/}))
 expect(screen.queryByRole('button',{name:'确定'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}));expect(send).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'设置计数线：边 2'}))
 expect(screen.getByText(/箭头方向记为“进”，反方向记为“出”/)).toBeInTheDocument()

 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].counterBindings).toEqual([expect.objectContaining({counter_id:'visitors',processor_id:'ai',zone_id:'z',zone_version:1,label_map_version:'lm',direction:{kind:'line',edge:'b',in_side:'inward'}})])
})
it('流量概览默认今天，显示进、出、在场并与上期比较；点数字打开通行记录',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[counter]})
 vi.mocked(flowService.query).mockImplementation(async input=>({from:input.from,to:input.to,items:[input.bucket?result(12,9):result(6,9)]}))
 vi.mocked(flowService.records).mockResolvedValue({items:[{event_id:'e',occurred_at:new Date().toISOString(),track_id:'t',label_id:'person',frame_id:'f',stream_session_id:'s'}],next_cursor:null})
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'客流'})
 await waitFor(()=>expect(within(card).getByText('12')).toBeInTheDocument())
 expect(within(card).getByText('3')).toBeInTheDocument()
 expect(within(card).getByText(/比昨天同时段 ↑ 100%/)).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'今天'})).toHaveAttribute('aria-pressed','true')
 expect(vi.mocked(flowService.query).mock.calls[0]![0]).toMatchObject({bucket:'hour'})
 fireEvent.click(within(card).getByText('12').closest('button')!)
 const drawer=await screen.findByRole('dialog',{name:'通行记录 · 客流'})
 await waitFor(()=>expect(within(drawer).getByRole('link',{name:/录像/})).toHaveAttribute('href',expect.stringMatching(/^\/playback\/cam\?from=\d+&to=\d+$/)))
})
it('前一时段还没有选用到热区时不显示“为 0”的比较',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[counter]})
 vi.mocked(flowService.query).mockImplementation(async input=>({from:input.from,to:input.to,items:[input.bucket?result(5,2):{...result(0,0),zones:[]}]}))
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'客流'})
 await waitFor(()=>expect(within(card).getByText('5')).toBeInTheDocument())
 expect(within(card).queryByText(/昨天同时段/)).not.toBeInTheDocument()
})
it('没有计数器时引导两步开始，不显示空白统计',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[]})
 vi.mocked(flowService.query).mockResolvedValue({from:'',to:'',items:[]})
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 expect(await screen.findByText('开始统计流量')).toBeInTheDocument()
 expect(screen.getByRole('link',{name:/前往实时监看/})).toHaveAttribute('href','/monitor')
 expect(screen.queryByRole('group',{name:'时间范围'})).not.toBeInTheDocument()
})
it('切换时段时晚到的旧结果不会覆盖新时段，失败时不保留旧数字',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[counter]})
 const pending:{bucket:string|null|undefined;from:string;resolve:(v:unknown)=>void;reject:(e:unknown)=>void}[]=[]
 vi.mocked(flowService.query).mockImplementation(input=>new Promise((resolve,reject)=>{pending.push({bucket:input.bucket,from:input.from,resolve:resolve as (v:unknown)=>void,reject})}))
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 await waitFor(()=>expect(pending.filter(p=>p.bucket).length).toBe(1))
 fireEvent.click(screen.getByRole('button',{name:'昨天'}))
 await waitFor(()=>expect(pending.filter(p=>p.bucket).length).toBe(2))
 const [today,yesterday]=pending.filter(p=>p.bucket)
 yesterday!.resolve({from:'',to:'',items:[result(7,1)]})
 const card=await screen.findByRole('article',{name:'客流'})
 await waitFor(()=>expect(within(card).getByText('7')).toBeInTheDocument())
 today!.resolve({from:'',to:'',items:[result(99,98)]})
 await new Promise(r=>setTimeout(r,20))
 expect(within(card).queryByText('99')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'近 7 天'}))
 await waitFor(()=>expect(pending.filter(p=>p.bucket).length).toBe(3))
 pending.filter(p=>p.bucket)[2]!.reject(Object.assign(Error('分析服务查询失败'),{status:502}))
 await screen.findByRole('alert')
 expect(within(screen.getByRole('article',{name:'客流'})).queryByText('7')).not.toBeInTheDocument()
})
it('一页一个计数器一张卡片：统计与编辑、暂停、删除在一起，没有选项卡和归档',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[counter]})
 vi.mocked(flowService.query).mockImplementation(async input=>({from:input.from,to:input.to,items:[result(4,3)]}))
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'客流'})
 await waitFor(()=>expect(within(card).getByText('4')).toBeInTheDocument())
 expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
 expect(screen.queryByText(/归档/)).not.toBeInTheDocument()
 for(const name of ['编辑','暂停','删除'])expect(within(card).getByRole('button',{name})).toBeInTheDocument()
 expect(within(card).getByText(/门口/)).toBeInTheDocument()
})
it('删除前说明会连同历史记录一起删除；确认后删除并刷新',async()=>{
 vi.mocked(flowService.list).mockResolvedValueOnce({items:[counter]}).mockResolvedValue({items:[]})
 vi.mocked(flowService.query).mockImplementation(async input=>({from:input.from,to:input.to,items:[result(4,3)]}))
 vi.mocked(flowService.remove).mockResolvedValue({deleted:true})
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 fireEvent.click(within(await screen.findByRole('article',{name:'客流'})).getByRole('button',{name:'删除'}))
 const confirm=screen.getByRole('alertdialog',{name:'确认删除计数器'})
 expect(confirm).toHaveTextContent(/历史通行记录.*一起删除/)
 expect(confirm).toHaveTextContent(/不能恢复/)
 expect(flowService.remove).not.toHaveBeenCalled()
 fireEvent.click(within(confirm).getByRole('button',{name:'删除计数器及历史'}))
 await waitFor(()=>expect(flowService.remove).toHaveBeenCalledWith('visitors',2,expect.any(String)))
 expect(await screen.findByText('开始统计流量')).toBeInTheDocument()
})
it('删除未完成的计数器只显示重试，不再显示统计',async()=>{
 vi.mocked(flowService.list).mockResolvedValue({items:[{...counter,bindings:[],deleting:true}]})
 vi.mocked(flowService.query).mockResolvedValue({from:'',to:'',items:[]})
 vi.mocked(flowService.remove).mockRejectedValue(Object.assign(Error('分析服务暂不可用'),{status:503}))
 render(<MemoryRouter><FlowPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'客流'})
 expect(card).toHaveTextContent(/删除未完成/)
 expect(within(card).queryByRole('button',{name:'编辑'})).not.toBeInTheDocument()
 fireEvent.click(within(card).getByRole('button',{name:'重试删除'}))
 await waitFor(()=>expect(flowService.remove).toHaveBeenCalled())
 expect(await within(card).findByText(/分析服务暂不可用/)).toBeInTheDocument()
})
it('分时图的提示时间不重复“时”字',async()=>{
 const {FlowChart}=await import('@/pages/Flow/FlowChart')
 render(<FlowChart label="趋势" bucket="hour" slots={[{from:'2026-10-21T06:00:00Z',to:'2026-10-21T07:00:00Z'}]} series={[{name:'进',color:'#000',buckets:[{from:'2026-10-21T06:00:00Z',occurrences:2}]}]}/>)
 fireEvent.click(document.querySelector('svg g.cursor-pointer')!)
 expect(screen.getByText(/：进 2/).textContent).not.toMatch(/时时/)
})
it('调整已有计数线时提供“以前的记录”选项，默认保持原统计',async()=>{
 const withBinding:ArmingDocument={...base,counter_bindings:[{binding_id:'flow-1',counter_id:'visitors',input_stream_id:'cam',processor_id:'ai',zone_id:'z',zone_version:1,geometry_revision:'g:1000x500',label_map_version:'lm',direction:{kind:'line',edge:'b',in_side:'inward'}}]}
 const send=vi.fn().mockResolvedValue({saved:true,sourceId:'cam',revision:2,application:{state:'applied'}})
 render(<ArmingModal sourceId="cam" sourceName="大门" base={withBinding} reference={{url:'image',width:1000,height:500,geometryRevision:'g:1000x500',capturedAt:'now'}}
  definitions={[]} sources={[source]} counters={[counter]} send={send} onClose={vi.fn()} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'选择热区 门口'}))
 fireEvent.click(screen.getByRole('button',{name:'调整计数线 客流 · 门口'}))
 expect(screen.queryByRole('group',{name:'以前的记录'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'翻转方向'}))
 const history=screen.getByRole('group',{name:'以前的记录'})
 expect(within(history).getByRole('radio',{name:/保持原统计/})).toBeChecked()
 fireEvent.click(within(history).getByRole('radio',{name:/按新计数线重新统计/}))
 fireEvent.click(screen.getByRole('button',{name:'保存布防'}))
 await waitFor(()=>expect(send).toHaveBeenCalledOnce())
 expect(send.mock.calls[0]![0].counterBindings[0]).toMatchObject({direction:{in_side:'outward'},reclassify_history:true})
})
it('从参数库读回的计数线字段顺序不同，不算改动：未修改时不出现“以前的记录”，也不发送重新统计',async()=>{
 // PostgreSQL returns JSON object keys in its own order.
 const stored:ArmingDocument={...base,counter_bindings:[{binding_id:'flow-1',counter_id:'visitors',input_stream_id:'cam',processor_id:'ai',zone_id:'z',zone_version:1,geometry_revision:'g:1000x500',label_map_version:'lm',direction:{edge:'b',kind:'line',in_side:'inward'} as never}]}
 render(<ArmingModal sourceId="cam" sourceName="大门" base={stored} reference={{url:'image',width:1000,height:500,geometryRevision:'g:1000x500',capturedAt:'now'}}
  definitions={[]} sources={[source]} counters={[counter]} send={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()}/>)
 fireEvent.click(screen.getByRole('button',{name:'门口：触发器 0，计数器 1'}))
 fireEvent.click(screen.getByRole('button',{name:'调整计数线 客流 · 门口'}))
 expect(screen.queryByRole('group',{name:'以前的记录'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'翻转方向'}))
 fireEvent.click(screen.getByRole('button',{name:'翻转方向'}))
 expect(screen.queryByRole('group',{name:'以前的记录'})).not.toBeInTheDocument()
})
