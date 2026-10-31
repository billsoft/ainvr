import {act,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {MemoryRouter,useNavigate} from 'react-router-dom'
import AlarmListPage from '@/pages/AlarmCenter/AlarmListPage'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{list:vi.fn(),get:vi.fn(),summary:vi.fn().mockResolvedValue({}),confirm:vi.fn()}}))
vi.mock('@/api/aiChannelService',()=>({aiChannelService:{list:vi.fn().mockResolvedValue([{id:'a',name:'A'},{id:'b',name:'B'}])}}))
vi.mock('@/api/alarmTriggerService',()=>({alarmTriggerService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmDefinitionService',()=>({alarmDefinitionService:{list:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/api/alarmArmingService',()=>({alarmArmingService:{read:vi.fn()}}))
vi.mock('@/api/behaviorStatisticsService',()=>({behaviorStatisticsService:{query:vi.fn().mockResolvedValue({items:[]})}}))
vi.mock('@/components/PtzProtectionNotice',()=>({PtzProtectionNotice:()=>null}))
vi.mock('@/pages/AlarmCenter/AlarmRow',()=>({AlarmRow:({alarm}:{alarm:AlarmEvent})=><article>{alarm.alarm_id}</article>}))
const from='2026-10-01T00:00:00Z',to='2026-10-02T00:00:00Z'
const locations=[{channel_id:'a',zone_id:'x'},{channel_id:'b',zone_id:'y'}]
const url='/alarms?'+new URLSearchParams({status:'all',from,to,locations:JSON.stringify(locations)})
const alarm=(id:string,channel='a',zone='x',at='2026-10-01T12:00:00Z'):AlarmEvent=>({
 alarm_id:id,channel_id:channel,occurred_at:at,last_seen_at:at,behavior:'region_enter',rule:{id:'r',name:'r'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},stages:[{event_id:'s',behavior:'region_enter',at,direction:null,zone_id:zone}]
})
function ChangeUrl(){const navigate=useNavigate();return <button onClick={()=>navigate('/alarms?status=all&from=bad&to=bad&locations=bad')}>invalid link</button>}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(alarmEventService.list).mockResolvedValue({items:[],next_cursor:null,as_of:'now'})})
afterEach(()=>vi.useRealTimers())
it('forwards the complete analytics scope to server pagination and clears it explicitly',async()=>{
 const analytics={from,to,timezone:'Asia/Shanghai',bucket:'hour',trigger_id:'door',audit:'pending',weekday:3,hour:20}
 render(<MemoryRouter initialEntries={['/alarms?'+new URLSearchParams({status:'all',analytics_scope:JSON.stringify(analytics)})]}><AlarmListPage/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalledWith('all',undefined,{analytics:JSON.stringify(analytics)}))
 expect(screen.getByText(/保留统计页的触发器/)).toHaveTextContent('全部位置')
 fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,{analytics:JSON.stringify(analytics)}))
 fireEvent.click(screen.getByRole('button',{name:'清除统计范围'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith(expect.any(String),undefined,expect.not.objectContaining({analytics:JSON.stringify(analytics)})))
})
it('loads the fixed pair scope and keeps it while status and conclusion refine results',async()=>{
 render(<MemoryRouter initialEntries={[url]}><AlarmListPage/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalledWith('all',undefined,{from,to,locations}))
 expect(screen.getByText(/通道和时间已固定/)).toBeInTheDocument()
 expect(screen.getByLabelText('时间')).toBeDisabled()
 expect(screen.getByRole('button',{name:'A'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:'已人工审核'}))
 fireEvent.change(screen.getByLabelText('审核结论'),{target:{value:'handled'}})
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith('human',undefined,{from,to,locations,disposition:'handled'}))
 fireEvent.click(screen.getByRole('button',{name:'清除统计范围'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenLastCalledWith(expect.any(String),undefined,expect.not.objectContaining({locations})))
})
it('rejects malformed scope without making any list request until explicitly cleared',async()=>{
 render(<MemoryRouter initialEntries={['/alarms?status=all&from=bad&to=bad&locations=bad']}><AlarmListPage/></MemoryRouter>)
 expect(await screen.findByRole('alert')).toHaveTextContent('统计范围无效')
 expect(alarmEventService.list).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'清除统计范围'}))
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalled())
})
it('poll retains only rows that still match exact pairs and the exclusive end',async()=>{
 const first=alarm('first'),cross=alarm('cross'),upper=alarm('upper')
 vi.mocked(alarmEventService.list).mockResolvedValueOnce({items:[first,cross,upper],next_cursor:null,as_of:'now'}).mockResolvedValue({items:[first],next_cursor:null,as_of:'now'})
 vi.mocked(alarmEventService.get).mockImplementation(async id=>id==='cross'?alarm(id,'a','y'):alarm(id,'b','y',to))
 render(<MemoryRouter initialEntries={[url]}><AlarmListPage/></MemoryRouter>)
 expect(await screen.findByText('cross')).toBeInTheDocument()
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3300))})
 expect(screen.getByText('first')).toBeInTheDocument()
 expect(screen.queryByText('cross')).not.toBeInTheDocument()
 expect(screen.queryByText('upper')).not.toBeInTheDocument()
 expect(alarmEventService.list).toHaveBeenLastCalledWith('all',undefined,{from,to,locations})
})
it('invalid navigation cannot be overwritten by an earlier in-flight scoped response',async()=>{
 let resolve!:(v:{items:AlarmEvent[];next_cursor:null;as_of:string})=>void
 vi.mocked(alarmEventService.list).mockImplementation(()=>new Promise(r=>{resolve=r}))
 render(<MemoryRouter initialEntries={[url]}><ChangeUrl/><AlarmListPage/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByText('invalid link'))
 expect(await screen.findByRole('alert')).toHaveTextContent('统计范围无效')
 await act(async()=>resolve({items:[alarm('stale')],next_cursor:null,as_of:'now'}))
 expect(screen.queryByText('stale')).not.toBeInTheDocument()
 expect(alarmEventService.list).toHaveBeenCalledTimes(1)
})


it.each([
 '/alarms?status=all&from=2026-10-01T00%3A00%3A00Z',
 '/alarms?status=all&from=2026-10-01T00%3A00%3A00Z&to=2026-11-02T00%3A00%3A00Z&locations=%5B%5D',
 '/alarms?status=all&from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00Z&locations=%5B%5D',
 '/alarms?status=pending&from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00Z&locations=%5B%7B%22channel_id%22%3A%22a%22%2C%22zone_id%22%3A%22x%22%7D%5D',
])('rejects incomplete or invalid scope without broadening the query: %s',async path=>{
 render(<MemoryRouter initialEntries={[path]}><AlarmListPage/></MemoryRouter>)
 expect(await screen.findByRole('alert')).toHaveTextContent('统计范围无效')
 expect(alarmEventService.list).not.toHaveBeenCalled()
})
it('a pending poll cannot restore old rows after navigating to an invalid scope',async()=>{
 let resolvePoll!:(v:{items:AlarmEvent[];next_cursor:null;as_of:string})=>void
 vi.mocked(alarmEventService.list).mockResolvedValueOnce({items:[alarm('current')],next_cursor:null,as_of:'now'})
  .mockImplementation(()=>new Promise(r=>{resolvePoll=r}))
 render(<MemoryRouter initialEntries={[url]}><ChangeUrl/><AlarmListPage/></MemoryRouter>)
 await screen.findByText('current')
 await waitFor(()=>expect(alarmEventService.list).toHaveBeenCalledTimes(2),{timeout:4500})
 fireEvent.click(screen.getByText('invalid link'))
 expect(await screen.findByRole('alert')).toHaveTextContent('统计范围无效')
 await act(async()=>resolvePoll({items:[alarm('stale-poll')],next_cursor:null,as_of:'now'}))
 expect(screen.queryByText('stale-poll')).not.toBeInTheDocument()
 expect(screen.queryByText('current')).not.toBeInTheDocument()
 expect(alarmEventService.list).toHaveBeenCalledTimes(2)
},10000)
