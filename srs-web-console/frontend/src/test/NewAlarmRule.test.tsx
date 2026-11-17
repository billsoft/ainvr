import {render,screen,fireEvent,within} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import TriggerDefinitionsPage from '@/pages/AlarmCenter/TriggerDefinitionsPage'
import {AssignmentPicker} from './WorkspaceEditorHarness'
import {ArmingModal} from '@/pages/AlarmCenter/ArmingModal'
import {alarmDefinitionService} from '@/api/alarmDefinitionService'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import type {ArmingDocument} from '@/features/armingDocument'
vi.mock('@/api/alarmDefinitionService',async original=>({...await original<typeof import('@/api/alarmDefinitionService')>(),alarmDefinitionService:{list:vi.fn(),save:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn(async()=>[])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn(async()=>{throw Error('offline')})}}))
vi.mock('@/api/alarmAnalyticsService',async original=>({...await original<typeof import('@/api/alarmAnalyticsService')>(),alarmAnalyticsService:{query:vi.fn(async()=>{throw Error('offline')})}}))
beforeEach(()=>{vi.clearAllMocks();vi.mocked(alarmDefinitionService.list).mockResolvedValue({items:[]})})

async function openChooser(){
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 const create=await screen.findByRole('button',{name:'新建告警规则'})
 await vi.waitFor(()=>expect(create).toBeEnabled())
 fireEvent.click(create)
 return screen.getByRole('dialog',{name:'你想在什么情况下报警？'})
}

it('rules page has one create entry; the old two buttons are gone',async()=>{
 render(<MemoryRouter><TriggerDefinitionsPage/></MemoryRouter>)
 expect(await screen.findByRole('heading',{name:'告警规则'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'新建告警规则'})).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'新建场景'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'新建'+'触发器'})).not.toBeInTheDocument()
})

it('the chooser offers common situations and do-it-yourself actions in plain words',async()=>{
 const chooser=await openChooser()
 const common=within(chooser).getByRole('group',{name:'常见情况'})
 for(const name of ['没戴安全帽','冒烟或起火','区域人数不够','有人倒地'])expect(within(common).getByRole('button',{name:new RegExp(name)})).toBeInTheDocument()
 const custom=within(chooser).getByRole('group',{name:'自己设定'})
 for(const name of ['出现在画面里','靠近某个区域','进入某个区域','穿过某个区域'])expect(within(custom).getByRole('button',{name:new RegExp(name)})).toBeInTheDocument()
 expect(chooser).not.toHaveTextContent('姿态')
})

it('a common situation opens the scene setup on that situation',async()=>{
 const chooser=await openChooser()
 fireEvent.click(within(chooser).getByRole('button',{name:/冒烟或起火/}))
 const scene=screen.getByRole('dialog',{name:'新建告警规则 · 冒烟或起火'})
 expect(within(scene).getByRole('button',{name:/烟火/})).toHaveAttribute('aria-pressed','true')
 expect(screen.queryByRole('dialog',{name:'你想在什么情况下报警？'})).not.toBeInTheDocument()
})

it('a do-it-yourself action opens the rule wizard with that action chosen',async()=>{
 const chooser=await openChooser()
 fireEvent.click(within(chooser).getByRole('button',{name:/进入某个区域/}))
 const wizard=screen.getByRole('dialog',{name:'新建告警规则'})
 expect(within(wizard).getByLabelText('告警规则名称')).toBeInTheDocument()
 expect(within(within(wizard).getByRole('group',{name:'检测行为'})).getByRole('button',{name:/^进入区域/})).toHaveAttribute('aria-pressed','true')
})

const source={channel_id:'ai',channel_name:'检测',input_stream_id:'cam',input_name:'门',label_map_version:'l',geometry_revision:'g',tracking_available:true,labels:[{class_id:0,label_id:'person',name:'person',description:''}]}
const rule=(id:string,patch:Partial<TriggerDefinition>):TriggerDefinition=>({trigger_id:id,name:id,behavior:'appearance',labels:[{label_id:'person',name:'person'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1,...patch})
it('the whole picture lists appearance and common-situation rules, not zone actions',()=>{
 const definitions=[
  rule('人员出现',{}),
  rule('无人值守',{region_state:{operator:'count_below',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'region_absence'}}),
  rule('闯入禁区',{behavior:'region_enter'}),
 ]
 render(<AssignmentPicker sourceId="cam" geometryRevision="g" zone={null} definitions={definitions} sources={[source]} onDirectionChange={vi.fn()} onApply={vi.fn()}/>)
 expect(screen.getByLabelText('人员出现')).toBeInTheDocument()
 expect(screen.getByLabelText('无人值守')).toBeInTheDocument()
 expect(screen.queryByLabelText('闯入禁区')).not.toBeInTheDocument()
 expect(screen.getByLabelText('无人值守').closest('label')).toHaveTextContent('区域无人')
})

const reference={url:'image',width:1000,height:500,geometryRevision:'g',capturedAt:'now'}
it('arming without zones starts on the whole picture so rules can be added without drawing',()=>{
 const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[],assignments:[]}
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()}/>)
 expect(screen.getByRole('button',{name:'整个画面选用告警规则'})).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'整个画面'})).toHaveAttribute('aria-pressed','true')
})
it('with zones drawn the whole picture stays one click away in the toolbar',()=>{
 const base:ArmingDocument={source_id:'cam',geometry_revision:'g',revision:1,zones:[{zone_id:'z',channel_id:'cam',geometry_revision:'g',version:1,name:'门',state:'active',points:[[.1,.1],[.9,.1],[.9,.9]],edge_ids:['a','b','c']}],assignments:[]}
 render(<ArmingModal sourceId="cam" sourceName="门" base={base} reference={reference} definitions={[]} sources={[]} send={vi.fn()} onClose={vi.fn()} onSaved={vi.fn()}/>)
 expect(screen.queryByRole('button',{name:'整个画面选用告警规则'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'整个画面'}))
 expect(screen.getByRole('button',{name:'整个画面选用告警规则'})).toBeInTheDocument()
})
