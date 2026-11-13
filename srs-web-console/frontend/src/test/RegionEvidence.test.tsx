import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {BehaviorEvidence} from '@/pages/AlarmCenter/BehaviorEvidence'
import {request,requestBlob} from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn(),requestBlob:vi.fn()}))
it('region evidence switches exact frame and region layer without inventing a target crop',async()=>{
 Object.defineProperty(URL,'createObjectURL',{value:vi.fn().mockReturnValue('blob:region'),configurable:true})
 Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true})
 vi.mocked(request).mockResolvedValue({state:'available',evidence:{kind:'region_frame',variants:['processed'],image_width:1920,image_height:1080,pinned:true,retention:'alarm',expires_at:'2099-01-01T00:00:00Z',frames:[{frame_id:'first',captured_at:'2026-11-12T00:00:00Z',count:0},{frame_id:'last',captured_at:'2026-11-12T00:00:01Z',count:0}],region:{points:[[.1,.1],[.9,.1],[.9,.9]],erp_wrap:false}}})
 vi.mocked(requestBlob).mockResolvedValue(new Blob(['jpeg'],{type:'image/jpeg'}))
 render(<BehaviorEvidence eventId={'a'.repeat(64)}/>);
 expect(await screen.findByRole('img',{name:'该区域告警发生时的完整画面'})).toBeInTheDocument()
 expect(screen.queryByText(/不是完整画面/)).not.toBeInTheDocument()
 expect(screen.getByLabelText('区域证据关键帧')).toHaveValue('last')
 fireEvent.change(screen.getByLabelText('区域证据关键帧'),{target:{value:'first'}})
 await waitFor(()=>expect(requestBlob).toHaveBeenLastCalledWith(expect.stringContaining('frame=first'),expect.any(AbortSignal)))
 expect(screen.getByLabelText('发生时的布防区')).toBeInTheDocument()
 fireEvent.click(screen.getByLabelText('显示布防区'))
 expect(screen.queryByLabelText('发生时的布防区')).not.toBeInTheDocument()
})
