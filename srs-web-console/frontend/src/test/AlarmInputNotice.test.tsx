import {render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import {request} from '@/api/httpClient'
import {AlarmInputNotice} from '@/pages/AlarmCenter/AlarmInputNotice'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
beforeEach(()=>{vi.clearAllMocks()})
it('warns about missing new alarms and statistics when frame reception is blocked',async()=>{
 vi.mocked(request).mockResolvedValue({observation_journal:{state:'degraded',channel_issues:[{reason:'source_binding_mismatch'}]}})
 render(<MemoryRouter><AlarmInputNotice/></MemoryRouter>)
 expect(await screen.findByRole('alert')).toHaveTextContent('新告警和流量可能缺失')
 expect(screen.getByRole('link',{name:'查看运行状态'})).toHaveAttribute('href','/dashboard')
})
it('historical ignored counts do not become a current fault after recovery',async()=>{
 vi.mocked(request).mockResolvedValue({observation_journal:{state:'ready',ignored:30000,last_ignored_reason:'source_binding_mismatch',channel_issues:[]}})
 render(<MemoryRouter><AlarmInputNotice/></MemoryRouter>)
 await waitFor(()=>expect(request).toHaveBeenCalledOnce())
 expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
