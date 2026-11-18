import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {RuleColumn} from '@/pages/AlarmCenter/RuleColumn'
import {alarmHasTrigger} from '@/pages/AlarmCenter/alarmListScope'
import type {AlarmRuleLink} from '@/pages/AlarmCenter/alarmLink'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),summary:vi.fn().mockResolvedValue({}),confirm:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'a',name:'A'}])}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/components/PtzProtectionNotice',()=>({PtzProtectionNotice:()=>null}))
vi.mock('@/pages/AlarmCenter/AlarmRow',()=>({AlarmRow:({alarm}:{alarm:AlarmEvent})=><article>{alarm.alarm_id}</article>}))

const at='2026-11-18T08:00:00Z'
const alarm=(id:string,trigger:string):AlarmEvent=>({alarm_id:id,trigger_id:trigger,channel_id:'a',occurred_at:at,last_seen_at:at,behavior:'region_enter',rule:{id:trigger+'@2',name:'r'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},stages:[]} as AlarmEvent)
beforeEach(()=>{vi.clearAllMocks();vi.mocked(alarmEventService.list).mockResolvedValue({items:[],next_cursor:null,as_of:'now'})})
afterEach(()=>vi.useRealTimers())

it('a chosen rule narrows the list through a dated rule scope and says so, with a way back to every rule',async()=>{
 const showAll=vi.fn()
 render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage rule="door" ruleName="门口闯入" onShowAll={showAll}/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalled())
 const filters=vi.mocked(alarmEventService.list).mock.calls.at(-1)![2]!
 const scope=JSON.parse(filters.analytics!)
 expect(scope.trigger_id).toBe('door')
 expect(Date.parse(scope.to)-Date.parse(scope.from)).toBeLessThanOrEqual(31*86400000)
 expect(filters.from).toBeUndefined()
 // Pending alarms default to all time; for one rule that is capped, and the page must not hide it.
 const note=screen.getByText(/只看规则「门口闯入」/)
 expect(note).toHaveTextContent('最多查看近 30 天')
 fireEvent.click(screen.getByRole('button',{name:'查看全部规则'}))
 expect(showAll).toHaveBeenCalled()
})
it('confirming all names the rule, so a batch is never mistaken for every alarm',async()=>{
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('x1','door')],next_cursor:null,as_of:'now'})
 render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage rule="door" ruleName="门口闯入"/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:/全部确认/}))
 expect(screen.getByRole('group',{name:'确认全部'})).toHaveTextContent('规则「门口闯入」')
})
it('the background refresh never brings in another rule',async()=>{
 vi.useFakeTimers({shouldAdvanceTime:true})
 vi.mocked(alarmEventService.list).mockResolvedValueOnce({items:[alarm('mine','door')],next_cursor:null,as_of:'now'})
 render(<MemoryRouter initialEntries={['/alarms']}><AlarmListPage rule="door" ruleName="门口闯入"/></MemoryRouter>)
 await screen.findByText('mine')
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm('mine','door'),alarm('other','gate')],next_cursor:null,as_of:'now'})
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
 expect(screen.getByText('mine')).toBeInTheDocument()
 expect(screen.queryByText('other')).toBeNull()
 expect(alarmHasTrigger(alarm('v','door'),'door')).toBe(true)
 expect(alarmHasTrigger({...alarm('v','gate'),trigger_id:undefined,rule:{id:'door@3',name:'r'}} as AlarmEvent,'door')).toBe(true)
})

const rule=(id:string,name:string):TriggerDefinition=>({trigger_id:id,name,state:'enabled',behavior:'region_enter',labels:[],version:1} as unknown as TriggerDefinition)
function link(over:Partial<AlarmRuleLink>={}):AlarmRuleLink{
 return {rule:null,choose:vi.fn(),periodLabel:'今天',countsError:'',columnOpen:true,reload:0,bump:vi.fn(),
  counts:{total:9,pending:3,human_confirmed:4,human_false_positive:1,triggers:[{trigger_id:'door',name:'门口闯入',total:7,pending:2,human_reviewed:5,human_false_positive:1,rule_versions:[1]}]} as unknown as AlarmRuleLink['counts'],...over}
}
it('the rules column is one choice: every rule, or one rule with its alarms and pending ones for the period',()=>{
 const l=link()
 const {rerender}=render(<RuleColumn link={l} rules={[rule('door','门口闯入'),rule('gate','大门越线')]} details={t=><p>详情 {t.name}</p>} menu={()=>null}/>)
 const all=screen.getByRole('radio',{name:/全部规则/})
 expect(all).toHaveAttribute('aria-checked','true')
 expect(all).toHaveTextContent('告警 9'); expect(all).toHaveTextContent('待审核 3')
 const door=within(screen.getByRole('article',{name:'门口闯入'})).getByRole('radio')
 expect(door).toHaveTextContent('告警 7'); expect(door).toHaveTextContent('待审核 2')
 // A rule with no alarms in the period shows a real zero once the numbers are in.
 expect(within(screen.getByRole('article',{name:'大门越线'})).getByRole('radio')).toHaveTextContent('告警 0')
 expect(screen.queryByText('详情 门口闯入')).toBeNull()
 fireEvent.click(door)
 expect(l.choose).toHaveBeenCalledWith('door')
 rerender(<RuleColumn link={{...l,rule:'door'}} rules={[rule('door','门口闯入'),rule('gate','大门越线')]} details={t=><p>详情 {t.name}</p>} menu={()=>null}/>)
 expect(screen.getByText('详情 门口闯入')).toBeInTheDocument()
 expect(screen.getByRole('article',{name:'门口闯入'})).toHaveTextContent('人工误报 1 / 明确结论 5')
 fireEvent.click(screen.getByRole('radio',{name:/全部规则/}))
 expect(l.choose).toHaveBeenCalledWith(null)
})
