import {render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {describeAlarm} from '@/features/alarmSentences'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import type {AlarmTrigger} from '@/features/alarmTriggers'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),confirm:vi.fn()}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn(),source:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'gate',name:'大门'},{id:'east',name:'东围栏'}])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockResolvedValue({schema_version:'1.0',from:'a',to:'b',items:[{event_type:'region_traverse',occurrences:4,tracked_targets:4},{event_type:'appearance',occurrences:23,tracked_targets:20}],coverage:{state:'unknown'}})}}))
vi.mock('@/pages/AlarmCenter/EvidenceThumb',()=>({EvidenceThumb:({eventId,label}:{eventId:string;label:string})=><span data-testid="thumb">{label}:{eventId.slice(0,4)}</span>}))
const square:[number,number][]=[[.3,.2],[.7,.2],[.7,.8],[.3,.8]]  // edges 上 右 下 左
const fact=(n:number)=>String(n).repeat(64)
const trigger=(id:string,behavior:AlarmTrigger['behavior'],extra:Partial<AlarmTrigger>={}):AlarmTrigger=>({trigger_id:id,name:id==='pass'?'门前禁区':'围栏接近',behavior,labels:[{label_id:'class:0',name:'人员'}],duration_ms:3000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1,
  bindings:[{channel_id:'gate',label_map_version:'l',geometry_revision:'source-frame-v2:in-gate:g:1920x1080',zone_id:'z',zone_version:1,direction:{entry_edges:[],exit_edges:[]},approach_px:60,input_stream_id:'in-gate',zone_snapshot:{name:'禁区',points:square,version:1}}],...extra})
const alarm=(id:string,extra:Partial<AlarmEvent>={}):AlarmEvent=>({alarm_id:id,occurred_at:'2026-10-20T02:02:05Z',last_seen_at:'2026-10-20T02:02:16Z',channel_id:'gate',input_stream_id:'in-gate',trigger_id:'pass',behavior:'region_traverse',
  rule:{id:'pass@gate',name:'门前禁区'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},
  stages:[{event_id:'s1',behavior:'appearance',trigger_id:'pass',at:'2026-10-20T02:02:05Z',direction:null,behavior_event_ids:[fact(1)]},
    {event_id:'s2',behavior:'region_enter',trigger_id:'pass',at:'2026-10-20T02:02:11Z',direction:{entry_edge:2},behavior_event_ids:[fact(2)]},
    {event_id:'s3',behavior:'region_traverse',trigger_id:'pass',at:'2026-10-20T02:02:16Z',direction:{entry_edge:2,exit_edge:0},behavior_event_ids:[fact(3)]}],...extra})
beforeEach(()=>{
  vi.clearAllMocks()
  vi.mocked(alarmTriggerService.list).mockResolvedValue({items:[trigger('pass','region_traverse')]})
  vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('a'),alarm('b',{channel_id:'east',lifecycle:{state:'active'},stages:[{event_id:'x',behavior:'appearance',at:'2026-10-20T01:58:31Z',direction:null}],behavior:'appearance',trigger_id:'missing'})],next_cursor:null})
  vi.mocked(alarmEventService.confirm).mockImplementation(async items=>({items:items.map(i=>({alarm_id:i.alarm_id,outcome:'succeeded'}))}))
})
const open=async()=>{render(<MemoryRouter><AlarmListPage/></MemoryRouter>);return screen.findAllByRole('article')}
const card=(name:RegExp)=>screen.getAllByRole('article').find(a=>name.test(a.textContent??''))!

it('turns an alarm into one sentence per level, naming the zone edges',()=>{
  const t=trigger('pass','region_traverse'),a=alarm('a')
  expect(describeAlarm(a,t).sentence).toBe('人员从下边进入「禁区」，5 秒后从上边离开。')
  expect(describeAlarm({...a,behavior:'region_enter'},t).sentence).toBe('人员从下边进入「禁区」。')
  expect(describeAlarm({...a,behavior:'region_approach',stages:[{event_id:'n',behavior:'region_approach',at:a.occurred_at,direction:{nearest_edge:3}}]},trigger('near','region_approach')).sentence).toBe('人员靠近「禁区」左边一侧（60 像素内）。')
  expect(describeAlarm({...a,behavior:'appearance'},trigger('near','appearance',{bindings:[]})).sentence).toBe('人员在画面中连续出现 3 秒。')
  expect(describeAlarm({...a,stages:[]},undefined).sentence).toBe('目标穿过热区。')
  expect(describeAlarm({...a,behavior:'appearance'},{...t,labels:[{label_id:'class:0',name:'person'}]}).sentence).toBe('人员在画面中连续出现 3 秒。')
})
it('shows each alarm as a feed card with its level, stages and evidence',async()=>{
  await open()
  const a=card(/门前禁区/)
  for(const text of ['大门','禁区','穿过','人员从下边进入「禁区」，5 秒后从上边离开。','出现','碰撞侵入'])expect(a).toHaveTextContent(text)
  expect(within(a).getAllByTestId('thumb').map(t=>t.textContent)).toEqual(['出现:1111','碰撞侵入:2222','穿过:3333'])
  expect(card(/东围栏/)).toHaveTextContent('进行中')
})
it('filters by status, level, channel and time from the toolbar and the channel rail',async()=>{
  await open();vi.mocked(alarmEventService.list).mockClear()
  fireEvent.click(screen.getByRole('button',{name:/^穿过/}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,expect.objectContaining({behavior:'region_traverse'})))
  fireEvent.click(screen.getByRole('button',{name:'已确认'}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('acknowledged',undefined,expect.anything()))
  fireEvent.click(within(screen.getByRole('navigation',{name:'告警通道'})).getByRole('button',{name:/东围栏/}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('acknowledged',undefined,expect.objectContaining({channel_id:'east'})))
  const filters=vi.mocked(alarmEventService.list).mock.lastCall![2]!
  const midnight=new Date();midnight.setHours(0,0,0,0)
  expect(filters.from).toBe(midnight.toISOString())  // handled history defaults to today
  fireEvent.change(screen.getByLabelText('时间'),{target:{value:'all'}})
  await waitFor(()=>expect(vi.mocked(alarmEventService.list).mock.lastCall![2]!.from).toBeUndefined())
})
it('confirms or marks a false alarm right on the card',async()=>{
  await open()
  fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'确认已处理'}))
  await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledWith([{alarm_id:'a',expected_handling_revision:0}],'',expect.any(String),'handled'))
  expect(await within(card(/门前禁区/)).findByText(/已确认/)).toBeInTheDocument()
  fireEvent.click(within(card(/东围栏/)).getByRole('button',{name:'标记误报'}))
  await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenLastCalledWith([{alarm_id:'b',expected_handling_revision:0}],'',expect.any(String),'false_positive'))
  expect(await within(card(/东围栏/)).findByText(/已标记误报/)).toBeInTheDocument()
})
it('confirms every loaded alarm after an on-page confirmation and reports partial success',async()=>{
  vi.mocked(alarmEventService.confirm).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'succeeded'},{alarm_id:'b',outcome:'version_conflict'}]})
  const confirm=vi.spyOn(window,'confirm')
  await open()
  fireEvent.click(screen.getByRole('button',{name:'全部确认（2）'}))
  expect(alarmEventService.confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText('已确认 1 条；1 条记录已变化，请刷新后重试。')).toBeInTheDocument()
  expect(confirm).not.toHaveBeenCalled()
})
it('the detail sheet shows the stages, jumps to the recording and confirms with a note',async()=>{
  vi.mocked(alarmEventService.get).mockResolvedValue({...alarm('a'),logs:[{operation_id:'c',action:'created',actor:'alarm-service',at:'2026-10-20T02:02:05Z'}]})
  await open()
  fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'}))
  const sheet=await screen.findByRole('dialog',{name:'告警详情'})
  for(const text of ['首次触发','出现','碰撞侵入','穿过','从下边进入'])expect(sheet).toHaveTextContent(text)
  const link=within(sheet).getByRole('link',{name:/查看录像/})
  const from=Date.parse('2026-10-20T02:02:05Z')-15000,to=Date.parse('2026-10-20T02:02:16Z')+15000
  expect(link).toHaveAttribute('href',`/playback/in-gate?from=${from}&to=${to}`)
  fireEvent.change(within(sheet).getByLabelText('处理备注'),{target:{value:'已核实'}})
  fireEvent.click(within(sheet).getByRole('button',{name:'确认已处理'}))
  await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledWith([{alarm_id:'a',expected_handling_revision:0}],'已核实',expect.any(String),'handled'))
})
it('the side panel shows today by level',async()=>{
  await open()
  const panel=screen.getByRole('complementary',{name:'今日概况'})
  await waitFor(()=>expect(panel).toHaveTextContent('穿过4'))
  expect(panel).toHaveTextContent('出现23')
})
it('confirms on a LAN page without secure-context crypto helpers',async()=>{
  const original=crypto.randomUUID;Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined})
  try{await open();fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'确认已处理'}))
   await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalled())
   expect(vi.mocked(alarmEventService.confirm).mock.calls[0]![2]).toMatch(/^[a-f0-9]{32}$/)}
  finally{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:original})}
})
it('an uncertain bulk confirmation is retried with the same operation key',async()=>{
  vi.mocked(alarmEventService.confirm).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'already_acknowledged'},{alarm_id:'b',outcome:'succeeded'}]})
  await open()
  fireEvent.click(screen.getByRole('button',{name:'全部确认（2）'}));fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText(/结果未确认/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText('已确认 2 条。')).toBeInTheDocument()
  const keys=vi.mocked(alarmEventService.confirm).mock.calls.map(c=>c[2]);expect(keys[0]).toBe(keys[1])
})
it('opening details never acknowledges; a failed refresh keeps the loaded cards',async()=>{
  vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a'))
  await open()
  fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'}))
  await screen.findByRole('dialog',{name:'告警详情'})
  fireEvent.click(screen.getByRole('button',{name:'关闭详情'}))
  expect(alarmEventService.confirm).not.toHaveBeenCalled()
  vi.mocked(alarmEventService.list).mockRejectedValueOnce(Error('offline'))
  fireEvent.click(screen.getByRole('button',{name:'已确认'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('已加载的记录保留')
  expect(screen.getAllByRole('article').length).toBe(2)
})
it('the sheet shows the evidence of the stage the user picks',async()=>{
  vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a'))
  await open()
  fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'}))
  const sheet=await screen.findByRole('dialog',{name:'告警详情'})
  expect(within(sheet).getByRole('region',{name:'原帧目标截图'})).toBeInTheDocument()
  const enter=within(sheet).getAllByRole('button').find(b=>b.getAttribute('aria-pressed')!==null&&/碰撞侵入/.test(b.textContent??''))!
  fireEvent.click(enter);expect(enter).toHaveAttribute('aria-pressed','true')
})
it('unhandled alarms from before midnight stay in the default view',async()=>{
  await open()
  const first=vi.mocked(alarmEventService.list).mock.calls[0]!
  expect(first[0]).toBe('pending');expect(first[2]!.from).toBeUndefined()
  expect(screen.getByLabelText('时间')).toHaveValue('all')
})
