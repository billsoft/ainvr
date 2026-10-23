import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {beforeEach,expect,it,vi} from 'vitest'
import {ClearFlowDialog} from '@/pages/Flow/ClearFlowDialog'
import {flowService} from '@/api/flowService'
vi.mock('@/api/flowService',()=>({flowService:{clear:vi.fn()}}))
const scope={counterId:'ship',counterName:'登船',label:'后门 · 热区 1',bindingIds:['old'],from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'}
beforeEach(()=>vi.mocked(flowService.clear).mockReset())
it('cancel, close and Escape do not clear data',()=>{
 const onClose=vi.fn();render(<ClearFlowDialog scope={scope} onClose={onClose} onCleared={vi.fn()}/> )
 fireEvent.click(screen.getByRole('button',{name:'取消'}));fireEvent.click(screen.getByRole('button',{name:'关闭'}));fireEvent.keyDown(document,{key:'Escape'})
 expect(onClose).toHaveBeenCalledTimes(3);expect(flowService.clear).not.toHaveBeenCalled()
})
it('retry keeps the operation identity and exact range; only success refreshes parent',async()=>{
 vi.mocked(flowService.clear).mockRejectedValueOnce(Error('暂不可用')).mockResolvedValueOnce({cleared:true})
 const done=vi.fn();render(<ClearFlowDialog scope={scope} onClose={vi.fn()} onCleared={done}/> )
 fireEvent.click(screen.getByRole('button',{name:'确认清理'}));await screen.findByRole('alert')
 expect(done).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'重试清理'}));await waitFor(()=>expect(done).toHaveBeenCalledTimes(1))
 const calls=vi.mocked(flowService.clear).mock.calls;expect(calls[0]).toEqual(calls[1]);expect(calls[0]).toEqual(['ship',{binding_ids:['old'],from:scope.from,to:scope.to},expect.any(String)])
})
