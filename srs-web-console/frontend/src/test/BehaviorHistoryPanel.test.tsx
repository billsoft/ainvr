import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {BehaviorHistoryPanel} from '@/pages/AlarmCenter/BehaviorHistoryPanel'
import {behaviorHistoryService,type BehaviorFact} from '@/api/behaviorHistoryService'
vi.mock('@/api/behaviorHistoryService',()=>({behaviorHistoryService:{list:vi.fn(),get:vi.fn()}}))
const fact:BehaviorFact={event_id:'one',event_type:'region_traverse',occurred_at:'2026-10-19T01:00:00Z',started_at:null,channel_id:'c',input_stream_id:'in',stream_session_id:'s',track_id:'t',label_id:'person',zone_id:'gate',zone_version:2,rule_id:'rule',rule_version:3,direction:{entry_side_deg:90,exit_side_deg:270},quality:{basis:'observed_track',trajectory_complete:true},frame_id:'f',source_pts_ns:'1',evidence_refs:[]}
const query={from:'2026-10-19',to:'2026-10-20',event_type:'region_traverse'}
beforeEach(()=>{
 vi.mocked(behaviorHistoryService.list).mockReset();vi.mocked(behaviorHistoryService.get).mockReset()
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','')}})
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open')}})
})
it('keeps loaded rows after pagination failure and retries the same cursor; details are separate',async()=>{
 vi.mocked(behaviorHistoryService.list).mockResolvedValueOnce({items:[fact],next_cursor:'next'}).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({items:[{...fact,event_id:'two'}],next_cursor:null})
 vi.mocked(behaviorHistoryService.get).mockResolvedValue(fact)
 render(<BehaviorHistoryPanel query={query} onClose={()=>{}}/>)
 fireEvent.click(await screen.findByRole('button',{name:'加载更多'}))
 expect(await screen.findByRole('alert')).toHaveTextContent('已加载内容保留')
 expect(screen.getByRole('button',{name:'查看行为 one'})).toBeEnabled()
 fireEvent.click(screen.getByRole('button',{name:'重试读取'}))
 await screen.findByRole('button',{name:'查看行为 two'})
 expect(behaviorHistoryService.list).toHaveBeenNthCalledWith(3,query,'next')
 fireEvent.click(screen.getByRole('button',{name:'查看行为 one'}))
 expect(await screen.findByText('约 3 点钟方向（90.0°）')).toBeInTheDocument()
 expect(screen.getByRole('dialog',{name:'行为详情'})).toHaveTextContent('已确认完整')
 fireEvent.click(screen.getByRole('button',{name:'关闭详情'}))
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'查看行为 two'})).toBeEnabled()
})
it('shows contact side separately and does not invent motion when it is unknown',async()=>{
 const contact={...fact,event_type:'region_contact',direction:{region_side_deg:270,motion_heading_deg:null}}
 vi.mocked(behaviorHistoryService.list).mockResolvedValue({items:[contact],next_cursor:null})
 vi.mocked(behaviorHistoryService.get).mockResolvedValue(contact)
 render(<BehaviorHistoryPanel query={query} onClose={()=>{}}/>)
 fireEvent.click(await screen.findByRole('button',{name:'查看行为 one'}))
 expect(await screen.findByText('约 9 点钟方向（270.0°） · 最近边界估计')).toBeInTheDocument()
 expect(screen.getByRole('dialog')).toHaveTextContent('不代表地理方向')
 expect(screen.getByText('运动方向').nextElementSibling).toHaveTextContent('未确定')
})
it('closing during a pending request does not reopen the history panel',async()=>{
 let complete!:(v:{items:BehaviorFact[];next_cursor:null})=>void
 vi.mocked(behaviorHistoryService.list).mockImplementation(()=>new Promise(resolve=>{complete=resolve}))
 const close=vi.fn();const view=render(<BehaviorHistoryPanel query={query} onClose={close}/>)
 fireEvent.click(screen.getByRole('button',{name:'返回统计'}));expect(close).toHaveBeenCalledOnce()
 view.unmount();complete({items:[fact],next_cursor:null})
 await waitFor(()=>expect(screen.queryByRole('table')).not.toBeInTheDocument())
})
