import {act,render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {playbackHref} from '@/features/alarmNavigation'
import {describeAlarm} from '@/features/alarmSentences'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import type {AlarmTrigger} from '@/features/alarmTriggers'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),confirm:vi.fn(),summary:vi.fn().mockResolvedValue({pending:2,as_of:new Date().toISOString(),reference:{active:true,counts:{completed:1,waiting:1}}})}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn(),source:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'gate',name:'大门'},{id:'east',name:'东围栏'}])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockResolvedValue({schema_version:'1.0',from:'a',to:'b',items:[{event_type:'region_traverse',occurrences:4,tracked_targets:4},{event_type:'appearance',occurrences:23,tracked_targets:20}],coverage:{state:'unknown'}})}}))
vi.mock('@/pages/AlarmCenter/EvidenceThumb',()=>({EvidenceThumb:({eventId,label,onOpen}:{eventId:string;label:string;onOpen?:()=>void})=>onOpen?<button data-testid="thumb" aria-label={`查看${label}截图`} onClick={onOpen}>{label}:{eventId.slice(0,4)}</button>:<span data-testid="thumb">{label}:{eventId.slice(0,4)}</span>}))
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
  vi.mocked(alarmEventService.confirm).mockReset()
  vi.mocked(alarmTriggerService.list).mockResolvedValue({items:[trigger('pass','region_traverse')]})
  vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('a'),alarm('b',{channel_id:'east',lifecycle:{state:'active'},stages:[{event_id:'x',behavior:'appearance',at:'2026-10-20T01:58:31Z',direction:null}],behavior:'appearance',trigger_id:'missing'})],next_cursor:null})
  vi.mocked(alarmEventService.confirm).mockImplementation(async items=>({items:items.map(i=>({alarm_id:i.alarm_id,outcome:'succeeded'}))}))
  vi.mocked(alarmEventService.get).mockImplementation(async id=>alarm(id))
})
const open=async()=>{render(<MemoryRouter><AlarmListPage/></MemoryRouter>);return screen.findAllByRole('article')}
const card=(name:RegExp)=>screen.getAllByRole('article').find(a=>name.test(a.textContent??''))!
const handleRow=async(name:RegExp,disposition:'handled'|'false_positive')=>{
 fireEvent.click(within(card(name)).getByRole('button',{name:disposition==='handled'?'确认':'标记误报'}))
 const dialog=await screen.findByRole('dialog',{name:disposition==='handled'?'确认告警':'标记误报'})
 await within(dialog).findByLabelText('处理备注')
 fireEvent.click(within(dialog).getByRole('button',{name:disposition==='handled'?'确认':'确认标记误报'}))
}

it('turns an alarm into one sentence per level, naming the zone edges',()=>{
  const t=trigger('pass','region_traverse'),a=alarm('a')
  expect(describeAlarm(a,t).sentence).toBe('人员从下边进入「禁区」，5 秒后从上边离开。')
  expect(describeAlarm({...a,behavior:'region_enter'},t).sentence).toBe('人员从下边进入「禁区」。')
  expect(describeAlarm({...a,behavior:'region_approach',stages:[{event_id:'n',behavior:'region_approach',at:a.occurred_at,direction:{nearest_edge:3}}]},trigger('near','region_approach')).sentence).toBe('人员靠近「禁区」左边一侧（60 像素内）。')
  expect(describeAlarm({...a,behavior:'appearance'},trigger('near','appearance',{bindings:[]})).sentence).toBe('人员在画面中连续出现 3 秒。')
  expect(describeAlarm({...a,stages:[]},undefined).sentence).toBe('目标穿过热区。')
  expect(describeAlarm({...a,behavior:'appearance'},{...t,labels:[{label_id:'class:0',name:'person'}]}).sentence).toBe('人员在画面中连续出现 3 秒。')
})
it('shows one compact alarm row and one representative image; earlier stages stay in the detail view',async()=>{
  await open()
  const a=card(/门前禁区/)
  for(const text of ['大门','禁区','穿过','人员从下边进入「禁区」，5 秒后从上边离开。','出现','碰撞侵入'])expect(a).toHaveTextContent(text)
  expect(within(a).getAllByTestId('thumb').map(t=>t.textContent)).toEqual(['穿过:3333'])
  expect(a).toHaveClass('alarm-list-row')
  expect(card(/东围栏/)).toHaveTextContent('进行中')
})
it('filters by status, level, channel and time from the toolbar and the channel rail',async()=>{
  await open();vi.mocked(alarmEventService.list).mockClear()
  fireEvent.click(screen.getByRole('button',{name:/^穿过/}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,expect.objectContaining({behavior:'region_traverse'})))
  fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,expect.anything()))
  fireEvent.click(within(screen.getByRole('navigation',{name:'告警通道'})).getByRole('button',{name:/东围栏/}))
  await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,expect.objectContaining({channel_id:'east'})))
  const filters=vi.mocked(alarmEventService.list).mock.lastCall![2]!
  const midnight=new Date();midnight.setHours(0,0,0,0)
  expect(filters.from).toBe(midnight.toISOString())  // handled history defaults to today
  fireEvent.change(screen.getByLabelText('时间'),{target:{value:'all'}})
  await waitFor(()=>expect(vi.mocked(alarmEventService.list).mock.lastCall![2]!.from).toBeUndefined())
})
it('confirms or marks a false alarm after the separate confirmation dialog',async()=>{
  await open()
  await handleRow(/门前禁区/,'handled')
  await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledWith([{alarm_id:'a',expected_handling_revision:0}],'',expect.any(String),'handled'))
  await waitFor(()=>expect(screen.getAllByRole('article')).toHaveLength(1))
  expect(screen.getAllByRole('article')[0]).toHaveTextContent('东围栏')
  await handleRow(/东围栏/,'false_positive')
  await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenLastCalledWith([{alarm_id:'b',expected_handling_revision:0}],'',expect.any(String),'false_positive'))
  await waitFor(()=>expect(screen.queryAllByRole('article')).toHaveLength(0))
  expect(screen.getByText('当前筛选下没有告警。')).toBeInTheDocument()
})
it('confirms every loaded alarm after an on-page confirmation and reports partial success',async()=>{
  vi.mocked(alarmEventService.confirm).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'succeeded'},{alarm_id:'b',outcome:'version_conflict'}]})
  const confirm=vi.spyOn(window,'confirm')
  await open()
  fireEvent.click(screen.getByRole('button',{name:'确认已加载（2）'}))
  expect(alarmEventService.confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText('已确认 1 条；1 条记录已变化，请刷新后重试。')).toBeInTheDocument()
  expect(confirm).not.toHaveBeenCalled()
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getAllByRole('article')[0]).toHaveTextContent('东围栏')
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
  fireEvent.click(within(sheet).getByRole('button',{name:'确认'}))
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
  try{await open();await handleRow(/门前禁区/,'handled')
   await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalled())
   expect(vi.mocked(alarmEventService.confirm).mock.calls[0]![2]).toMatch(/^[a-f0-9]{32}$/)}
  finally{Object.defineProperty(crypto,'randomUUID',{configurable:true,value:original})}
})
it('an uncertain bulk confirmation is retried with the same operation key',async()=>{
  vi.mocked(alarmEventService.confirm).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'already_acknowledged'},{alarm_id:'b',outcome:'succeeded'}]})
  await open()
  fireEvent.click(screen.getByRole('button',{name:'确认已加载（2）'}));fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText(/结果未确认/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
  expect(await screen.findByText('已确认 2 条。')).toBeInTheDocument()
  const keys=vi.mocked(alarmEventService.confirm).mock.calls.map(c=>c[2]);expect(keys[0]).toBe(keys[1])
})
it('opening details never acknowledges; a failed filter never displays stale cards',async()=>{
  vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a'))
  await open()
  fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'}))
  await screen.findByRole('dialog',{name:'告警详情'})
  fireEvent.click(screen.getByRole('button',{name:'关闭'}))
  expect(alarmEventService.confirm).not.toHaveBeenCalled()
  vi.mocked(alarmEventService.list).mockRejectedValueOnce(Error('offline'))
  fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('请重试当前筛选')
  expect(screen.queryAllByRole('article').length).toBe(0)
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
it('bulk confirmation opens one separate dialog and Escape cancels without writing',async()=>{
 await open();const entry=screen.getByRole('button',{name:'确认已加载（2）'});entry.focus();fireEvent.click(entry)
 const dialog=await screen.findByRole('dialog',{name:'批量确认告警'})
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
 fireEvent.keyDown(dialog,{key:'Escape'})
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(entry).toHaveFocus()
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
})
it('a representative thumbnail opens its exact stage and never acknowledges the alarm',async()=>{
 const value=alarm('a');value.stages![2]!.behavior_event_ids=[]
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[value],next_cursor:null})
 vi.mocked(alarmEventService.get).mockResolvedValue(value)
 await open();fireEvent.click(within(screen.getByRole('article')).getByTestId('thumb'))
 const sheet=await screen.findByRole('dialog',{name:'告警详情'})
 await waitFor(()=>expect(within(sheet).getAllByRole('button').find(b=>b.getAttribute('aria-pressed')==='true')).toHaveTextContent('碰撞侵入'))
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
})
it('ignores an older filter response that finishes after the current filter',async()=>{
 await open()
 let resolve!:(v:{items:AlarmEvent[];next_cursor:null})=>void
 const old=new Promise<{items:AlarmEvent[];next_cursor:null}>(r=>{resolve=r})
 vi.mocked(alarmEventService.list).mockImplementation((_s,_c,f)=>f?.behavior==='region_approach'?old:Promise.resolve({items:[alarm('new',{rule:{id:'n',name:'最新筛选'}})],next_cursor:null}))
 fireEvent.click(screen.getByRole('button',{name:/^接近/}));fireEvent.click(screen.getByRole('button',{name:/^穿过/}))
 await screen.findByText(/最新筛选/)
 await act(async()=>resolve({items:[alarm('old',{rule:{id:'o',name:'过期筛选'}})],next_cursor:null}))
 expect(screen.queryByText(/过期筛选/)).not.toBeInTheDocument()
})
it('retries an uncertain single acknowledgement with the original operation key',async()=>{
 vi.mocked(alarmEventService.confirm).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'already_acknowledged'}]})
 await open();await handleRow(/门前禁区/,'handled')
 await screen.findByRole('alert')
 const dialog=screen.getByRole('dialog',{name:'确认告警'})
 expect(within(dialog).getByLabelText('处理备注')).toBeDisabled()
 fireEvent.click(within(dialog).getByRole('button',{name:'确认'}))
 await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledTimes(2))
 const calls=vi.mocked(alarmEventService.confirm).mock.calls;expect(calls[0]![2]).toBe(calls[1]![2])
})
it('opening and cancelling the handling dialog never changes an alarm',async()=>{
 await open();fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'确认'}))
 const dialog=await screen.findByRole('dialog',{name:'确认告警'})
 await within(dialog).findByLabelText('处理备注')
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
 fireEvent.click(within(dialog).getByRole('button',{name:'取消'}))
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('keeps keyboard focus inside details and restores it when Escape closes the dialog',async()=>{
 vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a'));await open()
 const button=within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'});button.focus();fireEvent.click(button)
 const sheet=await screen.findByRole('dialog',{name:'告警详情'})
 const close=within(sheet).getByRole('button',{name:'关闭'})
 await waitFor(()=>expect(close).toHaveFocus())
 const last=within(sheet).getByRole('button',{name:'标记误报'});last.focus();fireEvent.keyDown(last,{key:'Tab'})
 expect(close).toHaveFocus()
 fireEvent.keyDown(close,{key:'Escape'})
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(button).toHaveFocus()
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
})
it('freezes the bulk selection while its request outcome is uncertain, even if filters change',async()=>{
 vi.mocked(alarmEventService.confirm).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'already_acknowledged'},{alarm_id:'b',outcome:'succeeded'}]})
 await open();fireEvent.click(screen.getByRole('button',{name:'确认已加载（2）'}));fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
 await screen.findByText(/结果未确认/)
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('other')],next_cursor:null})
 fireEvent.click(screen.getByRole('button',{name:/^穿过/}))
 await waitFor(()=>expect(screen.getAllByRole('article')).toHaveLength(1))
 fireEvent.click(screen.getByRole('button',{name:'确认这 2 条'}))
 await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledTimes(2))
 const calls=vi.mocked(alarmEventService.confirm).mock.calls;expect(calls[0]).toEqual(calls[1])
})
it('opens recording in another page, preserves the alarm list and rejects invalid recording times',async()=>{
 vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a'));await open()
 fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'详情与录像'}))
 const sheet=await screen.findByRole('dialog',{name:'告警详情'})
 expect(await within(sheet).findByRole('link',{name:/查看录像/})).toHaveAttribute('target','_blank')
 expect(playbackHref(alarm('a',{occurred_at:'bad'}))).toBeNull()
 expect(playbackHref(alarm('a',{last_seen_at:'2020-01-01T00:00:00Z'}))).toBeNull()
})

it('reopens an uncertain acknowledgement with its original note and disposition, even from the other action',async()=>{
 vi.mocked(alarmEventService.confirm).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({items:[{alarm_id:'a',outcome:'already_acknowledged'}]});
 await open();fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'确认'}));
 let dialog=await screen.findByRole('dialog',{name:'确认告警'});
 fireEvent.change(within(dialog).getByLabelText('处理备注'),{target:{value:'现场核实'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'确认'}));await screen.findByRole('alert');
 fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));
 fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'标记误报'}));
 dialog=await screen.findByRole('dialog',{name:'确认告警'});
 expect(within(dialog).getByLabelText('处理备注')).toHaveValue('现场核实');expect(within(dialog).getByLabelText('处理备注')).toBeDisabled();
 fireEvent.click(within(dialog).getByRole('button',{name:'确认'}));
 await waitFor(()=>expect(alarmEventService.confirm).toHaveBeenCalledTimes(2));
 const calls=vi.mocked(alarmEventService.confirm).mock.calls;expect(calls[1]).toEqual(calls[0]);
});

it('AI confirmation and false positive are completed reviews with human correction available',async()=>{
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('a',{handling:{state:'acknowledged',revision:1,reviewed_by_kind:'ai',disposition:'false_positive'}})],next_cursor:null})
 await open();const row=card(/门前禁区/)
 expect(within(row).getByText('已 AI 审核 · 误报')).toBeInTheDocument()
 expect(within(row).getByRole('button',{name:'确认'})).toBeEnabled()
 expect(screen.queryByText('疑似误报')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'已 AI 审核'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('ai',undefined,expect.anything()))
 fireEvent.change(screen.getByRole('combobox',{name:'审核结论'}),{target:{value:'false_positive'}})
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('ai',undefined,expect.objectContaining({disposition:'false_positive'})))
})

it('keeps a manually confirmed row in All with the human review source',async()=>{
 await open();fireEvent.click(screen.getByRole('button',{name:'全部'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('all',undefined,expect.anything()))
 await handleRow(/门前禁区/,'handled')
 await waitFor(()=>expect(card(/门前禁区/)).toHaveTextContent('已人工审核 · 确认'))
 expect(screen.getAllByRole('article')).toHaveLength(2)
})

it('uses the authoritative AI source for a replayed acknowledgement',async()=>{
 vi.mocked(alarmEventService.confirm).mockResolvedValue({items:[{alarm_id:'a',outcome:'already_acknowledged'}]})
 await open();fireEvent.click(screen.getByRole('button',{name:'全部'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('all',undefined,expect.anything()))
 fireEvent.click(within(card(/门前禁区/)).getByRole('button',{name:'确认'}))
 const dialog=await screen.findByRole('dialog',{name:'确认告警'});await within(dialog).findByLabelText('处理备注')
 vi.mocked(alarmEventService.get).mockResolvedValue(alarm('a',{handling:{state:'acknowledged',revision:1,reviewed_by_kind:'ai',disposition:'handled'}}))
 fireEvent.click(within(dialog).getByRole('button',{name:'确认'}))
 await waitFor(()=>expect(card(/门前禁区/)).toHaveTextContent('已 AI 审核 · 确认'))
})

it('clears a completed conclusion when switching to unreviewed',async()=>{
 await open();fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
 fireEvent.change(screen.getByLabelText('审核结论'),{target:{value:'handled'}})
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,expect.objectContaining({disposition:'handled'})))
 fireEvent.click(screen.getByRole('button',{name:'未审核'}))
 await waitFor(()=>expect(screen.getByLabelText('审核结论')).toHaveValue(''))
 expect(screen.getByLabelText('审核结论')).toBeDisabled()
 expect(vi.mocked(alarmEventService.list).mock.lastCall![2]!.disposition).toBeUndefined()
})
it('reference scores stay unreviewed and explain the validation status',async()=>{
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('a',{review:{state:'skipped',reference:{state:'completed',score:.99}}})],next_cursor:null})
 await open();expect(screen.getByRole('article')).toHaveTextContent('AI 参考分数 0.990 · 待验证，不是概率')
 expect(screen.getByRole('article')).toHaveTextContent('未审核')
 expect(within(screen.getByRole('article')).getByRole('button',{name:'确认'})).toBeEnabled()
})
