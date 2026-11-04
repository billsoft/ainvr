import {render,screen} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import type {AlarmEvent} from '@/api/alarmEventService'
import {GroupEvidence} from '@/pages/AlarmCenter/GroupEvidence'
import {request} from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn(async()=>({jpeg_base64:'YQ=='})),requestBlob:vi.fn()}))
it('shows only the selected original frame with both member boxes and frozen zone; missing member scores remain readable',async()=>{
 const members=['a','b'].map((id,i)=>({event_id:id,name:'person',sample:{frame_id:'f',captured_at:'2026-11-04T08:00:00Z',track_id:id,label_id:'person',bbox:{x:i*100,y:0,w:30,h:60}}}))
 const row={alarm_id:'group',rule:{snapshot:{points:[[0,0],[1,0],[1,1]]}},analysis_evidence:{source:{width:320,height:200},group:{minimum:2,mode:'simultaneous',labels:'any',members}},
 review:{group_verdict:'uncertain',group_scores:[{event_id:'b',outcome:'uncertain',reason:'group_visual_unavailable'}],frames:[{frame_id:'f',key:'pinned-image',captured_at:members[0]!.sample.captured_at}]}} as unknown as AlarmEvent
 const {container}=render(<GroupEvidence alarm={row}/>)
 await screen.findByRole('img',{name:'审核使用的原始全景'})
 expect(container.querySelectorAll('svg rect')).toHaveLength(2)
 expect(container.querySelectorAll('svg polygon')).toHaveLength(1)
 expect(screen.getByText(/组合证据不足/)).toBeInTheDocument()
 expect(request).toHaveBeenCalledTimes(1)
})
