import {afterEach,expect,it,vi} from 'vitest'
import {flowService} from '@/api/flowService'
import {subscribeLiveCounts} from '@/features/flowLiveCounts'
vi.mock('@/api/flowService',()=>({flowService:{live:vi.fn()},startOfToday:()=>new Date('2026-10-23T00:00:00Z')}))
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks()})
it('shares one two-second poll, reports stale errors and recovers',async()=>{
 vi.useFakeTimers();vi.mocked(flowService.live).mockResolvedValue({items:[]})
 const a=vi.fn(),b=vi.fn(),off=subscribeLiveCounts('test-camera',a),off2=subscribeLiveCounts('test-camera',b)
 await vi.advanceTimersByTimeAsync(0);expect(flowService.live).toHaveBeenCalledTimes(1)
 expect(a.mock.lastCall?.[1].stale).toBe(false)
 vi.mocked(flowService.live).mockRejectedValueOnce(Error('offline'))
 await vi.advanceTimersByTimeAsync(2000);expect(flowService.live).toHaveBeenCalledTimes(2);expect(a.mock.lastCall?.[1].stale).toBe(true)
 await vi.advanceTimersByTimeAsync(2000);expect(b.mock.lastCall?.[1].stale).toBe(false)
 off();off2();await vi.advanceTimersByTimeAsync(10000);expect(flowService.live).toHaveBeenCalledTimes(3)
})
it('never overlaps a slow query when the arming page saves',async()=>{
 vi.useFakeTimers();let resolve!:(v:{items:[]})=>void
 vi.mocked(flowService.live).mockReturnValue(new Promise(r=>{resolve=r}))
 const off=subscribeLiveCounts('slow-camera',vi.fn())
 window.dispatchEvent(new Event('ainvr-arming-saved'));await vi.advanceTimersByTimeAsync(10000)
 expect(flowService.live).toHaveBeenCalledTimes(1);off();resolve({items:[]});await vi.advanceTimersByTimeAsync(10000)
 expect(flowService.live).toHaveBeenCalledTimes(1)
})
