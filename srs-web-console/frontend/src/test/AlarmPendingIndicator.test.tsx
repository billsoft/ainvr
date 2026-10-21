import {afterEach,expect,it,vi} from 'vitest'
import {render,screen,waitFor,cleanup} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {AlarmPendingIndicator} from '@/components/layout/AlarmPendingIndicator'
import {alarmEventService} from '@/api/alarmEventService'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{summary:vi.fn()}}))
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('shows total pending and links to the pending all-time list',async()=>{
 vi.mocked(alarmEventService.summary).mockResolvedValue({pending:202,as_of:new Date().toISOString()})
 render(<MemoryRouter><AlarmPendingIndicator/></MemoryRouter>)
 const link=await screen.findByRole('link',{name:'待确认告警 202 条'})
 expect(link.getAttribute('href')).toBe('/alarms?status=pending&range=all')
})
it('shows unknown instead of zero on transport failure',async()=>{
 vi.mocked(alarmEventService.summary).mockRejectedValue(new Error('offline'))
 render(<MemoryRouter><AlarmPendingIndicator/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.summary).toHaveBeenCalledOnce())
 expect(screen.getByRole('link',{name:'待确认告警数量未知'})).toBeTruthy()
 expect(screen.queryByText('0')).toBeNull()
})
it('rejects invalid counts rather than displaying a misleading number',async()=>{
 vi.mocked(alarmEventService.summary).mockResolvedValue({pending:-1,as_of:new Date().toISOString()})
 render(<MemoryRouter><AlarmPendingIndicator/></MemoryRouter>)
 await waitFor(()=>expect(alarmEventService.summary).toHaveBeenCalledOnce())
 expect(screen.getByRole('link',{name:'待确认告警数量未知'})).toBeTruthy()
})
