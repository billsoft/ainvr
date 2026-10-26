import {render,screen,fireEvent} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import {ReviewFrames} from '@/pages/AlarmCenter/ReviewFrames'
import type {AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/api/httpClient',()=>({request:vi.fn().mockResolvedValue({jpeg_base64:'test'})}))
it('shows one key moment at a time, defaults to the last frame, and hides unavailable model input',async()=>{
 const frames=['entry_before','entry_after','exit_before','exit_after'].map((role,i)=>({key:`frame${i}`,frame_id:`frame${i}`,roles:[role],source_pts_ns:String(i),captured_at:`2026-10-23T10:00:0${i}Z`,bbox:{x:1,y:1,w:20,h:30}}))
 const alarm={alarm_id:'a',input_stream_id:'camera',playback_stream_id:'output',review:{frames}} as AlarmEvent
 render(<MemoryRouter><ReviewFrames alarm={alarm}/></MemoryRouter>)
 expect(await screen.findByAltText('关键帧 4')).toBeInTheDocument()
 expect(screen.queryByAltText('关键帧 1')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'模型输入预览'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:/进入前/}))
 expect(screen.getByAltText('关键帧 1')).toBeInTheDocument()
 expect(screen.queryByAltText('关键帧 4')).not.toBeInTheDocument()
 expect(screen.getByRole('link',{name:'查看关键帧 1 此刻录像'})).toHaveAttribute('target','_blank')
})

it('marks the actual anchor on original coordinates and shows only recorded AI instructions',async()=>{
 const alarm={alarm_id:'b',occurred_at:'2026-10-26T00:00:00Z',last_seen_at:'2026-10-26T00:00:00Z',channel_id:'c',behavior:'region_enter',rule:{id:'r',name:'test'},severity:'warning',lifecycle:{state:'ended'},handling:{state:'unacknowledged',revision:0},analysis_evidence:{source:{width:100,height:100},review_context:{schema_version:'2.0',anchor:'bottom_center',region:{points:[[0,0],[1,0],[1,1],[0,1]]},trace:[]}},review:{state:'supported',frames:[{key:'key',frame_id:'frame',captured_at:'2026-10-26T00:00:00Z',source_pts_ns:'1',bbox:{x:10,y:20,w:20,h:30}}],context_frames:[{key:'marked',frame_id:'frame',layout:'context-marked-v1',width:896,height:448}],submitted_prompts:[{frame_id:'frame',description:'Only inspect this target.',label:'person',caller_template:'v',scope:'target_category_only'}]}} as AlarmEvent
 render(<MemoryRouter><ReviewFrames alarm={alarm}/></MemoryRouter>)
 await screen.findByAltText('关键帧 1')
 expect(screen.getByLabelText('当前判定点')).toHaveAttribute('cx','20')
 expect(screen.getByLabelText('当前判定点')).toHaveAttribute('cy','50')
 expect(screen.getByText('Only inspect this target.')).toBeInTheDocument()
 expect(screen.getByText(/此标记图供人工核对/)).toBeInTheDocument()
})
