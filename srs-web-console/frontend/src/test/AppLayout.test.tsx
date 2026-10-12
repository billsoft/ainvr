import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from 'react-router-dom'
import { router } from '@/router'
import { useMonitorStore } from '@/store/monitor'
import { vi } from 'vitest'

vi.mock('@/api/brandingService', () => ({ brandingService: { get: vi.fn().mockResolvedValue({
  productName: 'AINVR', subtitle: '智能视频管理平台', shortName: 'AINVR', versionLabel: '',
  tagline: '', copyrightHolder: '', copyrightStartYear: null, contactName: '', contactPhone: '',
}) } }))

vi.mock('@/api/observabilityService', () => ({ observabilityService: { summary: vi.fn().mockResolvedValue({
  snapshot: { ts: Date.now(), services: [
    { id: 'backend', healthy: true }, { id: 'srs', healthy: true }, { id: 'ai-service', healthy: true }, { id: 'recorder', healthy: true },
  ] }, settings: {}, sources: [], applyError: null,
}) } }))

describe('AppLayout 全局布局', () => {
  it('渲染六个主导航项', () => {
    render(<RouterProvider router={router} />)
    const nav = screen.getByRole('navigation', { name: '主导航' })
    expect(nav).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /仪表盘/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /AI 通道/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /接入管理/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /实时监看/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /系统配置/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /关于/ })).toBeInTheDocument()
  })

  it('顶栏显示产品名与核心服务聚合状态', async () => {
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('AINVR')).toBeInTheDocument()
    expect(await screen.findByTestId('system-status')).toHaveTextContent('4/4 服务正常')
  })

  it('侧边栏显示简称与版本号（来自品牌配置）', async () => {
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('AINVR v0.2.0')).toBeInTheDocument()
  })

  it('聚焦态下点击「实时监看」重置回全景', async () => {
    const user = userEvent.setup()
    useMonitorStore.setState({ focusedChannelId: 'some-channel-id' })
    render(<RouterProvider router={router} />)
    await user.click(screen.getByRole('link', { name: /实时监看/ }))
    expect(useMonitorStore.getState().focusedChannelId).toBeNull()
  })
})
