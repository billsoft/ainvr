import {render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {alarmTriggerService} from '@/api/alarmTriggerService'
import {alarmEventService} from '@/api/alarmEventService'
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{source:vi.fn(),list:vi.fn()}}))
vi.mock('@/api/alarmZoneService',async original=>({...await original<typeof import('@/api/alarmZoneService')>(),alarmZoneService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'c1',name:'大门'}])}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),confirm:vi.fn()}}))
beforeEach(()=>{
  vi.clearAllMocks()
  vi.mocked(alarmTriggerService.source).mockRejectedValue(Error('offline'))
  vi.mocked(alarmTriggerService.list).mockResolvedValue({items:[
    {trigger_id:'t1',name:'通道进出计数',behavior:'region_traverse',labels:[{label_id:'person',name:'人员'}],duration_ms:0,alarm_enabled:false,state:'archived',schedule:{mode:'always'},version:2,
     bindings:[{channel_id:'c1',label_map_version:'lm',geometry_revision:'g',zone_id:'z1',zone_version:1,direction:{entry_edges:[],exit_edges:[]},zone_snapshot:{name:'通道区',points:[],version:1}}]},
    {trigger_id:'t2',name:'别处出现',behavior:'appearance',labels:[{label_id:'car',name:'车辆'}],duration_ms:2000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'},version:1,
     bindings:[{channel_id:'other',label_map_version:'lm',geometry_revision:'g',zone_id:null,zone_version:null,direction:{entry_edges:[],exit_edges:[]}}]},
  ]} as never)
})
it('the alarm list filters by level using the four trigger behaviors',async()=>{
  vi.mocked(alarmEventService.list).mockResolvedValue({items:[],next_cursor:null} as never)
  vi.mocked(alarmTriggerService.list).mockResolvedValue({items:[]} as never)
  render(<MemoryRouter><AlarmListPage/></MemoryRouter>)
  const group=await screen.findByRole('group',{name:'级别'})
  expect([...group.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['全部级别','出现','接近','碰撞侵入','穿过'])
})
