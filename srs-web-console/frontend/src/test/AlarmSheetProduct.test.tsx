import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import {AlarmSheet} from '@/pages/AlarmCenter/AlarmSheet'
import {ReviewFrames} from '@/pages/AlarmCenter/ReviewFrames'
import {alarmEventService,type AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{get:vi.fn()}}))
vi.mock('@/api/httpClient',()=>({request:vi.fn().mockResolvedValue({jpeg_base64:'frame'}),requestBlob:vi.fn()}))
vi.mock('@/pages/AlarmCenter/RuleEvidence',()=>({RuleEvidence:()=>null}))
vi.mock('@/pages/AlarmCenter/BehaviorEvidence',()=>({BehaviorEvidence:({eventId}:{eventId:string})=><p>业务证据 {eventId}</p>}))
vi.mock('@/pages/AlarmCenter/EvidenceThumb',()=>({EvidenceThumb:({label}:{label:string})=><span>{label}截图</span>}))
const at='2026-11-13T00:00:00Z'
const frame={key:'f',frame_id:'f',roles:['entry_after'],captured_at:at,source_pts_ns:'1',bbox:{x:10,y:10,w:20,h:20}}
const alarm:AlarmEvent={alarm_id:'a',event_kind:'fire_smoke',channel_id:'c',behavior:'appearance',occurred_at:at,last_seen_at:at,rule:{id:'r',name:'烟火规则'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},stages:[{event_id:'s',behavior:'appearance',at,direction:null,behavior_event_ids:['e']},{event_id:'s2',behavior:'appearance',at,direction:null,behavior_event_ids:['e2']}],analysis_evidence:{source:{width:100,height:100},review_context:{region:{points:[[0,0],[1,0],[1,1]]},trace:[]}},review:{state:'uncertain',reason:'region_manual_review',frames:[frame]}}
beforeEach(()=>{vi.clearAllMocks();vi.mocked(alarmEventService.get).mockResolvedValue(alarm)})
it('presents fire evidence as business records, preserving per-record evidence selection and manual actions',async()=>{
 const confirm=vi.fn(),close=vi.fn()
 render(<MemoryRouter><AlarmSheet id="a" channelName="仓库" trigger={undefined} close={close} confirm={confirm}/></MemoryRouter>)
 await screen.findByRole('heading',{name:'业务记录'})
 expect(screen.queryByRole('heading',{name:'经过'})).not.toBeInTheDocument()
 expect(screen.queryByText(/进入画面/)).not.toBeInTheDocument()
 expect(screen.queryByText('出现')).not.toBeInTheDocument()
 const records=screen.getAllByRole('button',{name:/业务触发记录/})
 expect(records).toHaveLength(2)
 fireEvent.click(records[0]!)
 expect(await screen.findByText('业务证据 e')).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'关闭'})).toHaveClass('h-11','w-11')
 expect(screen.getByRole('button',{name:'确认'})).toHaveClass('!min-h-11')
 expect(confirm).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'关闭'}))
 expect(close).toHaveBeenCalledTimes(1)
})
it('keeps spatial stage semantics for legacy alarms',async()=>{
 vi.mocked(alarmEventService.get).mockResolvedValue({...alarm,event_kind:undefined,review:undefined})
 render(<MemoryRouter><AlarmSheet id="a" channelName="仓库" trigger={undefined} close={vi.fn()} confirm={vi.fn()}/></MemoryRouter>)
 await screen.findByRole('heading',{name:'经过'})
 expect(screen.getAllByText(/进入画面/)).toHaveLength(2)
})
it('keeps missing face evidence in the manual watchlist flow',async()=>{
 vi.mocked(alarmEventService.get).mockResolvedValue({...alarm,event_kind:'face_watchlist',analysis_evidence:undefined})
 render(<MemoryRouter><AlarmSheet id="a" channelName="入口" trigger={undefined} close={vi.fn()} confirm={vi.fn()}/></MemoryRouter>)
 await screen.findByText(/此名单候选的抓拍与比对证据暂不可用/)
 expect(screen.queryByRole('heading',{name:'经过'})).not.toBeInTheDocument()
 expect(screen.queryByRole('heading',{name:'业务记录'})).not.toBeInTheDocument()
 expect(screen.queryByText(/进入画面/)).not.toBeInTheDocument()
 expect(screen.queryByText(/布防区域/)).not.toBeInTheDocument()
})
it.each(['fire_smoke','face_watchlist','vehicle_watchlist'])('does not claim spatial geometry verification for %s frames',async event_kind=>{
 await act(async()=>{render(<MemoryRouter><ReviewFrames alarm={{...alarm,event_kind}}/></MemoryRouter>)})
 const evidence=screen.getByRole('region',{name:'审核关键帧'})
 expect(within(evidence).queryByRole('button',{name:'目标与轨迹'})).not.toBeInTheDocument()
 expect(within(evidence).queryByText(/行为几何条件仍由规则引擎判断/)).not.toBeInTheDocument()
 expect(within(evidence).queryByLabelText('当前判定点')).not.toBeInTheDocument()
 expect(within(evidence).queryByText(/进入后/)).not.toBeInTheDocument()
 expect(within(evidence).getByRole('button',{name:/证据帧 1/})).toBeInTheDocument()
})
it('preserves geometry controls for actual spatial evidence',async()=>{
 await act(async()=>{render(<MemoryRouter><ReviewFrames alarm={{...alarm,event_kind:'spatial'}}/></MemoryRouter>)})
 await waitFor(()=>expect(screen.getByLabelText('当前判定点')).toBeInTheDocument())
 expect(screen.getByRole('button',{name:'目标与轨迹'})).toBeInTheDocument()
 expect(screen.getByText(/行为几何条件仍由规则引擎判断/)).toBeInTheDocument()
})
