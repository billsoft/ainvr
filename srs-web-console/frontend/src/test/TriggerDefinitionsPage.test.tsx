import {render,screen,fireEvent,within,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi} from 'vitest'
import TriggerDefinitionsPage from '@/pages/AlarmCenter/TriggerDefinitionsPage'
import {alarmDefinitionService,createDefinitionSaveSession} from '@/api/alarmDefinitionService'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
vi.mock('@/api/alarmDefinitionService',async original=>({...await original<typeof import('@/api/alarmDefinitionService')>(),alarmDefinitionService:{list:vi.fn(),save:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn(async()=>[])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn(async()=>{throw Error('offline')})}}))
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
 expect(card).toHaveTextContent('统计未确认')
 fireEvent.click(within(card).getByRole('button',{name:'编辑'}))
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
it('共享定义暂停和归档在保存前不写库',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 vi.mocked(alarmDefinitionService.save).mockResolvedValue({saved:true,trigger:{...trigger,state:'archived',version:2},application:{state:'pending'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 fireEvent.click(within(await screen.findByRole('article')).getByRole('button',{name:'编辑'}))
 for(let i=0;i<3;i++)fireEvent.click(screen.getByRole('button',{name:'下一步'}))
 fireEvent.change(screen.getByLabelText('保存后状态'),{target:{value:'archived'}})
 expect(screen.getByText(/解除全部选用/)).toBeInTheDocument()
 expect(alarmDefinitionService.save).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await waitFor(()=>expect(alarmDefinitionService.save).toHaveBeenCalledOnce())
 expect(vi.mocked(alarmDefinitionService.save).mock.calls[0]?.[0]).toMatchObject({state:'archived'})
})
it('保存超时锁住修改与取消，界面重试使用相同内容和操作号',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[trigger]})
 vi.mocked(alarmDefinitionService.save).mockRejectedValueOnce(Error('timeout'))
  .mockResolvedValueOnce({saved:true,trigger:{...trigger,version:2},application:{state:'pending'}})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 fireEvent.click(within(await screen.findByRole('article')).getByRole('button',{name:'编辑'}))
 for(let i=0;i<3;i++)fireEvent.click(screen.getByRole('button',{name:'下一步'}))
 fireEvent.click(screen.getByRole('button',{name:'保存'}))
 await screen.findByRole('alert')
 expect(screen.getByRole('button',{name:'取消'})).toBeDisabled()
 expect(screen.getByRole('button',{name:'上一步'})).toBeDisabled()
 expect(screen.getByLabelText('保存后状态')).toBeDisabled()
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
 await within(card).findByText('今日暂无记录（覆盖未确认）')
 expect(card).not.toHaveTextContent('今天 0 次')
})

it('旧接近范围未等价转换时显示待确认，不展示不存在的百分比',async()=>{
 vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[{...trigger,behavior:'region_approach',state:'paused',migration_review:{required:true,reason:'旧区域缺失'}}]})
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const card=await screen.findByRole('article',{name:trigger.name})
 expect(card).toHaveTextContent('接近范围待重新确认')
 expect(card).not.toHaveTextContent('undefined')
})
