import {render,screen,fireEvent} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {MemoryRouter} from 'react-router-dom'
import {ReviewFrames} from '@/pages/AlarmCenter/ReviewFrames'
import type {AlarmEvent} from '@/api/alarmEventService'
vi.mock('@/api/httpClient',()=>({request:vi.fn().mockResolvedValue({jpeg_base64:'test'})}))
it('shows one key moment at a time, defaults to the last frame, and hides unavailable model input',async()=>{
 const frames=['entry_before','entry_after','exit_before','exit_after'].map((role,i)=>({key:`frame${i}`,frame_id:`frame${i}`,roles:[role],source_pts_ns:String(i),captured_at:`2026-10-23T10:00:0${i}Z`,bbox:{x:1,y:1,w:20,h:30}}))
 const alarm={alarm_id:'a',input_stream_id:'camera',review:{frames}} as AlarmEvent
 render(<MemoryRouter><ReviewFrames alarm={alarm}/></MemoryRouter>)
 expect(await screen.findByAltText('关键帧 4')).toBeInTheDocument()
 expect(screen.queryByAltText('关键帧 1')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'模型输入预览'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:/进入前/}))
 expect(screen.getByAltText('关键帧 1')).toBeInTheDocument()
 expect(screen.queryByAltText('关键帧 4')).not.toBeInTheDocument()
 expect(screen.getByRole('link',{name:'查看关键帧 1 此刻录像'})).toHaveAttribute('target','_blank')
})
