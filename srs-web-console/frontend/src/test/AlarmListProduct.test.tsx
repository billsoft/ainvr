import {fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {MemoryRouter,useLocation,useNavigate} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {alarmEventService} from '@/api/alarmEventService'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'

vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),summary:vi.fn(),confirm:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'a',name:'测试通道'}])}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn().mockResolvedValue({items:[{trigger_id:'fire',name:'仓库烟火'}]})}}))
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn()}}))
vi.mock('@/components/PtzProtectionNotice',()=>({PtzProtectionNotice:()=>null}))
vi.mock('@/pages/AlarmCenter/AlarmRow',()=>({AlarmRow:()=>null}))
const statistics={schema_version:'1.0',from:'2026-11-13',to:'2026-11-14',items:[],coverage:{state:'unknown'}}
const analytics={from:'2026-11-12T00:00:00Z',to:'2026-11-13T00:00:00Z',timezone:'Asia/Shanghai',bucket:'hour',event_kind:'fire_smoke',primary_type:'appearance',trigger_id:'fire',audit:'pending'}
const scopeUrl='/alarms?'+new URLSearchParams({status:'all',analytics_scope:JSON.stringify(analytics)})
function LocationProbe(){const location=useLocation(),navigate=useNavigate();return <><output aria-label="当前URL">{location.search}</output><button onClick={()=>navigate(scopeUrl)}>打开烟火统计</button></>}
function mount(path='/alarms'){return render(<MemoryRouter initialEntries={[path]}><LocationProbe/><AlarmListPage/></MemoryRouter>)}
beforeEach(()=>{
 vi.clearAllMocks()
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[],next_cursor:null})
 vi.mocked(alarmEventService.summary).mockResolvedValue({pending:0,as_of:'now',automatic_review:{mode:'confirm_only',accuracy_validated:false,approve_above:.95,labels:['person']}})
 vi.mocked(behaviorStatisticsService.query).mockResolvedValue(statistics)
})
it.each(['fire_smoke','face_watchlist','region_absence','vehicle_watchlist'])('clears only local spatial stages when selecting %s',async kind=>{
 mount()
 fireEvent.click(within(screen.getByRole('group',{name:'空间阶段'})).getByRole('button',{name:'出现'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,{behavior:'appearance',event_kind:'spatial'}))
 fireEvent.change(screen.getByLabelText('告警业务类型'),{target:{value:kind}})
 expect(screen.queryByRole('group',{name:'空间阶段'})).not.toBeInTheDocument()
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,{event_kind:kind}))
 fireEvent.change(screen.getByLabelText('告警业务类型'),{target:{value:'spatial'}})
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,{event_kind:'spatial'}))
 expect(within(screen.getByRole('group',{name:'空间阶段'})).getByRole('button',{name:'全部阶段'})).toHaveAttribute('aria-pressed','true')
 expect(alarmEventService.confirm).not.toHaveBeenCalled()
})
it('keeps every fixed URL condition, labels the business and trigger, and never clears the legacy primary type',async()=>{
 mount(scopeUrl)
 const select=screen.getByLabelText('告警业务类型')
 expect(select).toBeDisabled();expect(select).toHaveValue('fire_smoke')
 expect(screen.queryByRole('group',{name:'空间阶段'})).not.toBeInTheDocument()
 expect(screen.getByText(/业务范围：烟雾 \/ 明火/)).toBeInTheDocument()
 await screen.findByText(/触发器 仓库烟火/)
 expect(screen.getByText(/附加筛选：触发阶段 出现/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,{analytics:JSON.stringify(analytics)}))
 expect(screen.getByLabelText('当前URL')).toHaveTextContent(new URLSearchParams({status:'all',analytics_scope:JSON.stringify(analytics)}).toString())
 for(const call of vi.mocked(alarmEventService.list).mock.calls)expect(call[2]).toEqual({analytics:JSON.stringify(analytics)})
})
it('navigation from a local stage to a fixed nonspatial scope cannot leak the local stage',async()=>{
 mount()
 fireEvent.click(within(screen.getByRole('group',{name:'空间阶段'})).getByRole('button',{name:'出现'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('pending',undefined,{behavior:'appearance',event_kind:'spatial'}))
 vi.mocked(alarmEventService.list).mockClear()
 fireEvent.click(screen.getByRole('button',{name:'打开烟火统计'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalled())
 for(const call of vi.mocked(alarmEventService.list).mock.calls)expect(call[2]).toEqual({analytics:JSON.stringify(analytics)})
})
it('labels all-channel spatial counts and keeps missing data unknown',async()=>{
 vi.mocked(behaviorStatisticsService.query).mockResolvedValue({...statistics,items:[{event_type:'appearance',occurrences:7,tracked_targets:3}]})
 mount()
 const panel=screen.getByRole('complementary',{name:'今日空间行为概况'})
 await within(panel).findByText('7')
 expect(panel).toHaveTextContent('全通道 · 今日已记录量')
 expect(panel).toHaveTextContent('不含烟火、区域业务及名单告警')
 expect(within(panel).queryByText('0')).not.toBeInTheDocument()
 expect(within(panel).getAllByText('—').length).toBeGreaterThan(0)
 fireEvent.change(screen.getByLabelText('告警业务类型'),{target:{value:'fire_smoke'}})
 expect(behaviorStatisticsService.query).toHaveBeenCalledTimes(1)
 expect(vi.mocked(behaviorStatisticsService.query).mock.calls[0]![0]).not.toHaveProperty('channel_id')
})
it('does not show failed statistics as zero',async()=>{
 vi.mocked(behaviorStatisticsService.query).mockRejectedValue(new Error('offline'))
 mount()
 const panel=screen.getByRole('complementary',{name:'今日空间行为概况'})
 await within(panel).findByText('统计暂不可用')
 expect(within(panel).queryByText('0')).not.toBeInTheDocument()
})
it('collapses automatic review detail and presents manual candidate review for nonspatial business',async()=>{
 mount()
 const summary=await screen.findByText('自动审核仅用于已授权且证据满足条件的告警 · 展开说明')
 const details=summary.closest('details')!
 expect(details).not.toHaveAttribute('open')
 expect(details).toHaveTextContent('模型准确率尚未全面验证')
 fireEvent.click(summary)
 expect(details).toHaveAttribute('open')
 fireEvent.change(screen.getByLabelText('告警业务类型'),{target:{value:'face_watchlist'}})
 expect(screen.getByText('名单候选需人工复核 · 展开说明')).toBeInTheDocument()
 expect(details).toHaveTextContent('全局审核设置不表示所有业务已自动处理')
})
