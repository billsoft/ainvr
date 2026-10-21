import {render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import {AlarmServiceStatusCard} from '@/pages/Dashboard/AlarmServiceStatusCard'
import {request} from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
beforeEach(()=>{vi.resetAllMocks()})
it('displays disconnected as unknown rather than healthy zero',async()=>{
 vi.mocked(request).mockRejectedValue(Error('not configured'))
 render(<MemoryRouter><AlarmServiceStatusCard/></MemoryRouter>)
 expect(await screen.findByText(/未连接或尚未配置/)).toBeInTheDocument()
 expect(screen.getByRole('region',{name:'告警服务监视'})).toHaveTextContent('—')
 expect(screen.getByRole('link',{name:'服务配置'})).toHaveAttribute('href','/config-center?category=alarm-service')
})
it('shows input delivery backlog and an explicit failed consumer state',async()=>{
 vi.mocked(request).mockResolvedValue({sampled_at:new Date().toISOString(),status:'ready',config:{applied_version:2},storage:{writable:true},input:{received:20,persisted:18,failed:2,last_persisted_at:null},observation_journal:{state:'degraded',pending:123,failed:4}})
 render(<MemoryRouter><AlarmServiceStatusCard/></MemoryRouter>)
 expect(await screen.findByText(/消费异常/)).toBeInTheDocument();expect(screen.getByText('123')).toBeInTheDocument();expect(screen.getByText('18')).toBeInTheDocument()
})

it('evidence storage counters are persistent and separate from transient input counters',async()=>{
 vi.mocked(request).mockResolvedValue({sampled_at:new Date().toISOString(),status:'ready',config:{applied_version:2},storage:{writable:true},input:{received:0,persisted:0,failed:0,last_persisted_at:null},evidence_vault:{enabled:true,used_bytes:1048576,max_bytes:2147483648,counts:{stored:42,pending:2,capturing:1,unavailable:4},last_error:null}})
 render(<MemoryRouter><AlarmServiceStatusCard/></MemoryRouter>)
 expect(await screen.findByText(/告警截图独立保存：已启用/)).toBeInTheDocument()
 expect(screen.getByText(/已保存 42 项 · 待保存 3 项 · 未取得 4 项/)).toBeInTheDocument()
 expect(screen.getByText(/不随重启清零/)).toBeInTheDocument()
})

it('explains a blocked source and offers a rule repair path instead of a healthy zero',async()=>{
 vi.mocked(request).mockResolvedValue({sampled_at:new Date().toISOString(),status:'ready',config:{applied_version:2},storage:{writable:true},input:{received:0,persisted:0,failed:0,last_persisted_at:null},observation_journal:{state:'degraded',pending:10,channel_issues:[{channel_id:'gate',reason:'source_binding_unavailable',state:'blocked'}]}})
 render(<MemoryRouter><AlarmServiceStatusCard/></MemoryRouter>)
 expect(await screen.findByRole('alert')).toHaveTextContent('统计可能不完整')
 expect(screen.getByRole('alert')).toHaveTextContent('来源绑定未完成')
 expect(screen.getByRole('link',{name:'检查分析规则'})).toHaveAttribute('href','/alarm-analysis')
})
