import {act,cleanup,render} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {AuthGate} from '@/components/auth/AuthGate'
import {useAuthStore} from '@/store/auth'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

beforeEach(()=>{
 vi.useFakeTimers()
 vi.mocked(request).mockReset().mockResolvedValue({code:0,data:{required:true}} as never)
 useAuthStore.setState({required:true,token:'t'.repeat(64),setupRequired:false})
})
afterEach(()=>{cleanup();vi.useRealTimers()})
const renewals=()=>vi.mocked(request).mock.calls.filter(([p,o])=>p==='/auth/media-session'&&o?.method==='POST').length

it('renews the live-video cookie every 30 minutes while the console stays open',async()=>{
 render(<AuthGate><div>wall</div></AuthGate>)
 await act(async()=>{await vi.advanceTimersByTimeAsync(0)})
 const first=renewals()
 await act(async()=>{await vi.advanceTimersByTimeAsync(30*60_000)})
 expect(renewals()).toBe(first+1)
 await act(async()=>{await vi.advanceTimersByTimeAsync(5*60*60_000)})
 expect(renewals()).toBe(first+11)
})

it('does not renew for a signed-out console',async()=>{
 useAuthStore.setState({token:null})
 render(<AuthGate><div>wall</div></AuthGate>)
 await act(async()=>{await vi.advanceTimersByTimeAsync(31*60_000)})
 expect(renewals()).toBe(0)
})
