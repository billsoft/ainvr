import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {BehaviorEvidence} from '@/pages/AlarmCenter/BehaviorEvidence'
import {request,requestBlob} from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn(),requestBlob:vi.fn()}))
beforeEach(()=>{vi.resetAllMocks();Object.defineProperty(URL,'createObjectURL',{value:vi.fn().mockReturnValue('blob:exact-evidence'),configurable:true});Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true})})
it('shows exact target crop, changes variants and releases browser object URLs',async()=>{
 vi.mocked(request).mockResolvedValue({state:'available',evidence:{kind:'target_crop',variants:['processed','original'],image_width:320,image_height:240}});vi.mocked(requestBlob).mockResolvedValue(new Blob(['jpeg'],{type:'image/jpeg'}))
 const view=render(<BehaviorEvidence eventId={'a'.repeat(64)}/>);expect(await screen.findByRole('img')).toHaveAttribute('src','blob:exact-evidence')
 expect(screen.getByText(/不是完整画面/)).toBeInTheDocument();fireEvent.change(screen.getByLabelText('截图版本'),{target:{value:'original'}})
 await waitFor(()=>expect(requestBlob).toHaveBeenLastCalledWith(expect.stringContaining('variant=original'),expect.any(AbortSignal)));view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalled()
})
it('unavailable original identity never loads an unrelated image',async()=>{
 vi.mocked(request).mockResolvedValue({state:'unavailable',reason:'frame_identity_unavailable'})
 render(<BehaviorEvidence eventId={'b'.repeat(64)}/>);expect(await screen.findByText(/完整原帧身份/)).toBeInTheDocument();expect(requestBlob).not.toHaveBeenCalled();expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('clearly distinguishes independently retained crops from expired evidence',async()=>{
 vi.mocked(request).mockResolvedValueOnce({state:'available',evidence:{kind:'target_crop',variants:['processed'],image_width:320,image_height:240,pinned:true,retention:'alarm',expires_at:'2026-11-18T01:00:00Z'}});vi.mocked(requestBlob).mockResolvedValue(new Blob(['jpeg'],{type:'image/jpeg'}))
 const view=render(<BehaviorEvidence eventId={'c'.repeat(64)}/>);expect(await screen.findByRole('img')).toBeInTheDocument();expect(screen.getByText(/已由告警服务独立保存/)).toBeInTheDocument()
 view.unmount();vi.mocked(request).mockResolvedValueOnce({state:'unavailable',reason:'capacity'});vi.mocked(requestBlob).mockClear()
 render(<BehaviorEvidence eventId={'d'.repeat(64)}/>);expect(await screen.findByText(/容量上限清理/)).toBeInTheDocument();expect(requestBlob).not.toHaveBeenCalled()
})

it('paused capture is shown as waiting rather than a saved image',async()=>{
 vi.mocked(request).mockResolvedValue({state:'pending',reason:'capture_disabled'})
 render(<BehaviorEvidence eventId={'e'.repeat(64)}/>);expect(await screen.findByText(/独立保存已暂停/)).toBeInTheDocument();expect(requestBlob).not.toHaveBeenCalled()
})
