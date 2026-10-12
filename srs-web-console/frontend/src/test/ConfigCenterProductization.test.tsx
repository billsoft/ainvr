import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/api/configService', () => ({ configService: {
  listDocuments: async () => [], listServiceStates: async () => [], getApplyOperation: async () => null,
  getPgInfo: async () => ({ host: 'postgres', port: '5432', database: 'console', user: 'console', connected: true }),
} }))
vi.mock('@/api/systemService', () => ({ systemService: { getSettings: async () => ({ adminPasswordSet: false }) } }))
// 2026-09-22：网络管理并入第 6 个分类，切进去会真的调 networkService，独立测试页已下线
const { listInterfacesMock } = vi.hoisted(() => ({
  listInterfacesMock: vi.fn(async () => [
    { name: 'eth0', kind: 'ethernet', state: 'connected', connected: true, carrier: true, connection: 'Wired', system: false,
      mac: 'aa:bb:cc:dd:ee:ff', mtu: 1500, ipv4: { method: 'auto', addresses: ['192.168.1.10/24'], gateway: '192.168.1.1', dns: [] },
      ipv6: { method: 'disabled', addresses: [], gateway: null, dns: [] } },
  ]),
}))
vi.mock('@/api/networkService', () => ({
  networkService: {
    listInterfaces: listInterfacesMock,
    getPending: vi.fn(async () => null),
    getFallback: vi.fn(async () => null),
    confirm: vi.fn(async () => undefined),
    revert: vi.fn(async () => undefined),
    applyIpConfig: vi.fn(async () => ({ rollbackSeconds: 30 })),
    scanWifi: vi.fn(async () => []),
    wifiConnect: vi.fn(async () => undefined),
    wifiDisconnect: vi.fn(async () => undefined),
  },
}))
import ConfigCenter from '@/pages/ConfigCenter'
describe('六类配置页面', () => {
  it('only exposes six categories and no developer/publish controls', async () => {
    render(<MemoryRouter><ConfigCenter /></MemoryRouter>)
    await screen.findByText('监看与轮询')
    for (const title of ['基础配置', '数据库配置', '流媒体配置', 'AI微服务配置', '录像微服务配置', '网络管理']) {
      expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument()
    }
    for (const name of ['刷新', '发布变更', '总览', '服务状态', '版本历史', '审计日志', 'JSON']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: /数据库配置/ }))
    expect(await screen.findByText('参数库')).toBeInTheDocument()
    expect(screen.getByText('AI识别历史库（识别快照存储）')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /流媒体配置/ }))
    expect(screen.getByText('流媒体服务连接')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /AI微服务配置/ }))
    expect(screen.getByText('AI 识别服务连接')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /录像微服务配置/ }))
    expect(screen.getByText('分段')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /管理录像计划/ })).toHaveAttribute('href', '/playback?schedule=1')
  })
  it.each([['recorder', '分段'], ['ai-service', 'AI 识别服务连接'], ['invalid', '监看与轮询']])('supports category link %s', async (category, label) => {
    render(<MemoryRouter initialEntries={[`/config-center?category=${category}`]}><ConfigCenter /></MemoryRouter>)
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  it('切到「网络管理」：展示真实网卡列表，不接「发布变更」流程', async () => {
    render(<MemoryRouter><ConfigCenter /></MemoryRouter>)
    await screen.findByText('监看与轮询')
    fireEvent.click(screen.getByRole('button', { name: /网络管理/ }))
    expect(await screen.findByText('eth0')).toBeInTheDocument()
    expect(screen.getByText(/直接生效，不走「发布变更」/)).toBeInTheDocument()
    await waitFor(() => expect(listInterfacesMock).toHaveBeenCalled())
  })

  it('带 ?category=network 打开时直接落在「网络管理」', async () => {
    render(<MemoryRouter initialEntries={['/config-center?category=network']}><ConfigCenter /></MemoryRouter>)
    expect(await screen.findByText('eth0')).toBeInTheDocument()
  })
})
