import {fireEvent,render,screen} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {AlarmRow} from '@/pages/AlarmCenter/AlarmRow'
import type {AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/pages/AlarmCenter/EvidenceThumb',()=>({EvidenceThumb:({eventId,label,onOpen}:{eventId:string;label:string;onOpen?:()=>void})=><button onClick={onOpen}>{label}截图 {eventId}</button>}))
vi.mock('@/features/faces/FaceAlarmEvidence',async importOriginal=>({
 ...await importOriginal<typeof import('@/features/faces/FaceAlarmEvidence')>(),
 FaceAlarmPhoto:({recordId,onOpen}:{recordId:string;onOpen:()=>void})=><button onClick={onOpen}>受保护人脸照片 {recordId}</button>,
}))
const alarm:AlarmEvent={alarm_id:'a',event_kind:'fire_smoke',channel_id:'c',behavior:'appearance',occurred_at:'2026-11-13T00:00:00Z',last_seen_at:'2026-11-13T00:00:00Z',rule:{id:'r',name:'仓库规则'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},stages:[{event_id:'s',behavior:'appearance',at:'2026-11-13T00:00:00Z',direction:null,behavior_event_ids:['e']}]}
it('keeps the long channel name readable and all three actions reachable',()=>{
 const onHandle=vi.fn(),onOpen=vi.fn()
 render(<AlarmRow alarm={alarm} trigger={undefined} channelName="测试仓库东侧入口完整通道名称" onHandle={onHandle} onOpen={onOpen}/>)
 const heading=screen.getByRole('heading',{name:/测试仓库东侧入口完整通道名称/})
 expect(heading).not.toHaveClass('truncate')
 expect(screen.getByRole('article')).toHaveAccessibleName('测试仓库东侧入口完整通道名称 · 烟雾 / 明火')
 for(const name of ['确认','标记误报','详情与录像'])expect(screen.getByRole('button',{name})).toHaveClass('!min-h-11')
 fireEvent.click(screen.getByRole('button',{name:'确认'}))
 fireEvent.click(screen.getByRole('button',{name:'标记误报'}))
 fireEvent.click(screen.getByRole('button',{name:'详情与录像'}))
 expect(onHandle.mock.calls).toEqual([['handled'],['false_positive']]);expect(onOpen).toHaveBeenCalledTimes(1)
 expect(screen.queryByLabelText('阶段')).not.toBeInTheDocument()
})
it('renders bounded face summary without full analysis evidence or stages',()=>{
 const value={...alarm,event_kind:'face_watchlist',stages:[],face_summary:{record_id:'record',member_name:'张某',library_name:'关注人员',similarity:.873}}
 render(<AlarmRow alarm={value} trigger={undefined} channelName="入口" onHandle={vi.fn()} onOpen={vi.fn()}/>)
 expect(screen.getByText(/疑似「张某」.*人脸库「关注人员」.*0.87/)).toBeInTheDocument()
 expect(screen.getByRole('button',{name:'受保护人脸照片 record'})).toBeInTheDocument()
 expect(screen.getByText('名单候选 · 待人工复核')).toBeInTheDocument()
 expect(screen.queryByText(/布防区域/)).not.toBeInTheDocument()
})
it('uses the face evidence ref when the summary record ID is absent, without inventing absent facts',()=>{
 const value={...alarm,event_kind:'face_watchlist',stages:[],face_summary:{library_name:'关注人员'},evidence:{refs:[{kind:'face_record',record_id:'ref-record'}]}}
 render(<AlarmRow alarm={value} trigger={undefined} channelName="入口" onHandle={vi.fn()} onOpen={vi.fn()}/>)
 expect(screen.getByRole('button',{name:'受保护人脸照片 ref-record'})).toBeInTheDocument()
 expect(screen.queryByText(/候选相似度/)).not.toBeInTheDocument()
 expect(screen.getByText(/人脸名单候选 · 人脸库「关注人员」 · 需人工复核/)).toBeInTheDocument()
})
it('keeps handling facts for reviewed face candidates instead of calling them pending',()=>{
 render(<AlarmRow alarm={{...alarm,event_kind:'face_watchlist',handling:{state:'acknowledged',revision:1,reviewed_by_kind:'human',disposition:'false_positive'}}} trigger={undefined} channelName="入口" onHandle={vi.fn()} onOpen={vi.fn()}/>)
 expect(screen.getByText('已人工审核 · 误报')).toBeInTheDocument()
 expect(screen.queryByText('名单候选 · 待人工复核')).not.toBeInTheDocument()
})
it('keeps legacy spatial stage history and its evidence action',()=>{
 const onOpen=vi.fn(),value={...alarm,event_kind:undefined,stages:[...alarm.stages!,{...alarm.stages![0]!,event_id:'s2',behavior:'region_enter'}]}
 render(<AlarmRow alarm={value} trigger={undefined} channelName="入口" onHandle={vi.fn()} onOpen={onOpen}/>)
 expect(screen.getByLabelText('阶段')).toHaveTextContent('经过：出现 → 碰撞侵入')
 fireEvent.click(screen.getByRole('button',{name:'出现截图 e'}))
 expect(onOpen).toHaveBeenCalledWith('s')
})

it('reviewed rows display an administrator name without exposing the service principal',()=>{
 render(<AlarmRow alarm={{...alarm,handling:{state:'acknowledged',revision:1,reviewed_by_kind:'human',disposition:'handled',acknowledged_by:'console-administrator'}}} trigger={undefined} channelName="入口" onHandle={vi.fn()} onOpen={vi.fn()}/>);
 expect(screen.getByText('已确认 · 管理员')).toBeInTheDocument();
 expect(screen.queryByText(/console-administrator/)).not.toBeInTheDocument();
});
