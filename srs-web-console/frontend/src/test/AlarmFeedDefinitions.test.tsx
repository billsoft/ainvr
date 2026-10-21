import {render,screen,within} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),confirm:vi.fn()}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn().mockResolvedValue({items:[]}),source:vi.fn()}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn().mockResolvedValue({items:[
 {trigger_id:'d1',name:'门前侵入',behavior:'region_enter',labels:[{label_id:'0',name:'person'}],duration_ms:0,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1}]})}}))
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn().mockResolvedValue({arming:{source_id:'cam',geometry_revision:'r:1920x1080',revision:1,assignments:[],
 zones:[{zone_id:'z1',channel_id:'cam',geometry_revision:'r:1920x1080',version:1,name:'禁区',state:'active',points:[[.3,.2],[.7,.2],[.7,.8],[.3,.8]],edge_ids:['a','b','c','d']}]}})}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'ai',name:'大门'}])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockRejectedValue(Error('x'))}}))
vi.mock('@/pages/AlarmCenter/EvidenceThumb',()=>({EvidenceThumb:()=>null}))
const alarm:AlarmEvent={alarm_id:'a',occurred_at:'2026-10-20T02:02:05Z',last_seen_at:'2026-10-20T02:02:11Z',channel_id:'ai',input_stream_id:'cam',trigger_id:'d1',behavior:'region_enter',
 rule:{id:'assignment-1',name:'门前侵入'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},
 stages:[{event_id:'s',behavior:'region_enter',trigger_id:'d1',zone_id:'z1',at:'2026-10-20T02:02:11Z',direction:{entry_edge:2}}]}
it('an alarm from an armed trigger names its target in Chinese, its zone and the entry edge',async()=>{
 vi.mocked(alarmEventService.list).mockResolvedValue({items:[alarm],next_cursor:null})
 render(<MemoryRouter><AlarmListPage/></MemoryRouter>)
 const [card]=await screen.findAllByRole('article')
 await within(card!).findByText('人员从下边进入「禁区」。')
 expect(card).toHaveTextContent('大门 · 禁区')
})
