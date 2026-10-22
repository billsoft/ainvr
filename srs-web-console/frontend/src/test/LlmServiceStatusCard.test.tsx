import {afterEach, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {LlmServiceStatusCard} from '../pages/Dashboard/LlmServiceStatusCard'
const request=vi.hoisted(()=>vi.fn())
vi.mock('@/api/httpClient',()=>({request}))
afterEach(()=>{cleanup();request.mockReset()})
function show(){render(<MemoryRouter><LlmServiceStatusCard/></MemoryRouter>)}
it('does not describe an unloaded model as ready just because HTTP is available',async()=>{
  request.mockResolvedValue({ready:false,model:'unloaded',queue:{length:0,capacity:8},requests:{ok:0,failed:0}})
  show()
  expect(await screen.findByText(/大模型微服务 · 模型未加载/)).toBeTruthy()
  expect(screen.queryByText(/大模型微服务 · 模型就绪/)).toBeNull()
})
it('makes the exclusive-model conflict actionable without claiming free memory',async()=>{
  request.mockResolvedValue({ready:false,model:'fault',last_error:'large_model_busy',queue:{length:0,capacity:8},requests:{ok:0,failed:0}})
  show()
  expect(await screen.findByText('其他大模型正在使用资源，请先卸载后重试。')).toBeTruthy()
  expect(screen.getByRole('link',{name:'服务配置'}).getAttribute('href')).toContain('llm-service')
})
it('shows unavailable metrics when the status request fails',async()=>{
  request.mockRejectedValue(new Error('offline'));show()
  expect(await screen.findByText(/未连接或尚未配置/)).toBeTruthy()
  expect(screen.getAllByText('—')).toHaveLength(6)
})
