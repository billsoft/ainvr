import {render,screen,fireEvent,within,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import TriggerDefinitionsPage from '@/pages/AlarmCenter/TriggerDefinitionsPage'
import {alarmDefinitionService,createDefinitionSaveSession} from '@/api/alarmDefinitionService'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
vi.mock('@/api/alarmDefinitionService',async original=>({...await original<typeof import('@/api/alarmDefinitionService')>(),alarmDefinitionService:{list:vi.fn(),save:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn(async()=>[])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn(async()=>{throw Error('offline')})}}))
function edit(card:HTMLElement){fireEvent.click(within(card).getByRole('button',{name:'更多操作'}));fireEvent.click(within(card).getByRole('menuitem',{name:'编辑'}))}
beforeEach(()=>vi.clearAllMocks())
const trigger={trigger_id:'t',name:'人员出现',behavior:'appearance' as const,labels:[{label_id:'person',name:'人员'}],duration_ms:3000,
 alarm_enabled:true,state:'enabled' as const,schedule:{mode:'always' as const},version:1,usages:[]}
it('旧配置不能等价迁移时明确显示暂停原因',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[{...trigger,state:'paused',
  migration_review:{required:true,reason:'旧方向需要确认'}}]})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'人员出现'})
 expect(card).toHaveTextContent('已暂停')
 expect(card).toHaveTextContent('旧方向需要确认')
 expect(card).toHaveTextContent('原配置与历史已保留')
})
it('卡片保留列表背景，编辑弹窗可取消，不把统计失败显示成零',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:'人员出现'})
 expect(card).toHaveTextContent('尚未选用')
 expect(card).toHaveTextContent('记录未确认')
 edit(card)
 expect(screen.getByRole('dialog',{name:'编辑触发器'})).toBeInTheDocument()
 expect(card).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
 expect(alarmDefinitionService.save).not.toHaveBeenCalled()
})
it('不确定的保存沿用操作号，禁止改内容覆盖未确认操作',async()=>{
 const {version:_,usages:__,...input}=trigger
 const send=vi.fn<typeof alarmDefinitionService.save>()
 send.mockRejectedValueOnce(Error('timeout')).mockResolvedValue({saved:true,trigger:{...trigger,version:2},application:{state:'pending'}})
 const session=createDefinitionSaveSession(1,send)
 await expect(session.save(input)).rejects.toThrow('timeout')
 await expect(session.save({...input,name:'改名'})).rejects.toThrow('请先确认')
 await session.save(input)
 expect(send).toHaveBeenCalledTimes(2)
 expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
})
it('archive is separate from editing and requires explicit confirmation; cancel/close never write',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 vi.mocked(alarmDefinitionService.save).mockResolvedValue({saved:true,trigger:{...trigger,state:'archived',version:2},application:{state:'pending'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article')
 fireEvent.click(within(card).getByRole('button',{name:'更多操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'归档'}))
 expect(screen.getByText(/解除全部/)).toBeInTheDocument()
 expect(alarmDefinitionService.save).not.toHaveBeenCalled()
 fireEvent.keyDown(screen.getByRole('dialog',{name:'归档触发器'}),{key:'Escape'})
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(alarmDefinitionService.save).not.toHaveBeenCalled()
 fireEvent.click(within(card).getByRole('button',{name:'更多操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'归档'}))
 fireEvent.click(screen.getByRole('button',{name:'确认归档'}))
 await waitFor(()=>expect(alarmDefinitionService.save).toHaveBeenCalledOnce())
 expect(vi.mocked(alarmDefinitionService.save).mock.calls[0]?.[0]).toMatchObject({state:'archived'})
})
it('保存超时锁住修改与取消，界面重试使用相同内容和操作号',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 vi.mocked(alarmDefinitionService.save).mockRejectedValueOnce(Error('timeout'))
  .mockResolvedValueOnce({saved:true,trigger:{...trigger,version:2},application:{state:'pending'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 edit(await screen.findByRole('article'))
 for(let i=0;i<3;i++)fireEvent.click(screen.getByRole('button',{name:'下一步'}))
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await screen.findByRole('alert')
 expect(screen.getByRole('button',{name:'取消'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'上一步'})).toBeDisabled()
 expect(screen.queryByLabelText('保存后状态')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'重试确认保存'}))
 await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
 const calls=vi.mocked(alarmDefinitionService.save).mock.calls
 expect(calls.at(-1)).toEqual(calls.at(-2))
})
it('统计覆盖未确认时，无记录不表示今天确定为零',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 vi.mocked(behaviorStatisticsService.query).mockResolvedValueOnce({schema_version:'1.0',from:'a',to:'b',items:[],coverage:{state:'unknown'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:trigger.name})
 await within(card).findByText('今日暂无触发记录（覆盖未确认）')
 expect(card).not.toHaveTextContent('今天 0 次')
})

it('旧接近范围未等价转换时显示待确认，不展示不存在的百分比',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[{...trigger,behavior:'region_approach',state:'paused',migration_review:{required:true,reason:'旧区域缺失'}}]})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:trigger.name})
 expect(card).toHaveTextContent('接近范围待重新确认')
 expect(card).not.toHaveTextContent('undefined')
})


it('pause and enable are direct versioned actions with stable retries after an uncertain response',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValueOnce({items:[trigger]}).mockResolvedValue({items:[{...trigger,state:'paused',version:2}]})
 vi.mocked(alarmDefinitionService.save).mockRejectedValueOnce(Error('timeout')).mockResolvedValueOnce({saved:true,trigger:{...trigger,state:'paused',version:2},application:{state:'applied'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article')
 fireEvent.click(within(card).getByRole('button',{name:'更多操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'暂停'}))
 await screen.findByRole('alert')
 expect(screen.getByRole('button',{name:'新建触发器'})).toBeDisabled()
 expect(vi.mocked(alarmDefinitionService.save).mock.calls[0]?.[0]).toMatchObject({state:'paused',alarm_enabled:true})
 expect(vi.mocked(alarmDefinitionService.save).mock.calls[0]?.[0]).not.toHaveProperty('version')
 expect(vi.mocked(alarmDefinitionService.save).mock.calls[0]?.[0]).not.toHaveProperty('usages')
 fireEvent.click(screen.getByRole('button',{name:'重试确认操作'}))
 await waitFor(()=>expect(alarmDefinitionService.save).toHaveBeenCalledTimes(2))
 const calls=vi.mocked(alarmDefinitionService.save).mock.calls
 expect(calls[0]).toEqual(calls[1])
 await waitFor(()=>expect(screen.getByRole('button',{name:'新建触发器'})).toBeEnabled())
 expect(await screen.findByText('已暂停')).toBeInTheDocument()
 fireEvent.click(within(screen.getByRole('article')).getByRole('button',{name:'更多操作'}))
 expect(screen.getByRole('menuitem',{name:'启用'})).toBeEnabled()
})
