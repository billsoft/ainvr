import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SystemTimeNotice } from '@/components/layout/SystemTimeNotice'

const { svc } = vi.hoisted(() => ({ svc: { get: vi.fn(), setTime: vi.fn(), setNtpServers: vi.fn() } }))
vi.mock('@/api/systemTimeService', () => ({ systemTimeService: svc, SYSTEM_TIME_CHANGED_EVENT: 'ainvr:system-time-changed' }))

const base = {
  epoch_ms: 1791525000000, timezone: 'Asia/Shanghai', ntp_enabled: true, ntp_synchronized: false,
  manually_set: false, valid: true, min_valid_epoch_ms: 1767225600000, ntp_servers: [] as string[],
}
const renderNotice = () => render(<MemoryRouter><SystemTimeNotice /></MemoryRouter>)

describe('全局时间提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    try { sessionStorage.clear() } catch { /* ignore */ }
  })

  it('开机后尚未对时、也没人工校准：黄色提示并引导去校准', async () => {
    svc.get.mockResolvedValue(base)
    renderNotice()
    expect(await screen.findByText(/开机后尚未对时/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '校准时间' })).toHaveAttribute('href', '/config-center?category=time')
  })

  it('已同步或本次开机已人工校准：不提示', async () => {
    svc.get.mockResolvedValueOnce({ ...base, ntp_synchronized: true })
    const { unmount } = renderNotice()
    await waitFor(() => expect(svc.get).toHaveBeenCalled())
    expect(screen.queryByText(/尚未对时/)).toBeNull()
    unmount()
    svc.get.mockResolvedValueOnce({ ...base, manually_set: true })
    renderNotice()
    await waitFor(() => expect(svc.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/尚未对时/)).toBeNull()
  })

  it('时间无效：红色提示，不能关闭', async () => {
    svc.get.mockResolvedValue({ ...base, valid: false })
    renderNotice()
    expect(await screen.findByText(/设备时间无效/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭提示' })).toBeNull()
  })

  it('黄色提示可以关闭，本次会话不再出现', async () => {
    svc.get.mockResolvedValue(base)
    const { unmount } = renderNotice()
    fireEvent.click(await screen.findByRole('button', { name: '关闭提示' }))
    expect(screen.queryByText(/尚未对时/)).toBeNull()
    unmount()
    renderNotice()
    await waitFor(() => expect(svc.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/尚未对时/)).toBeNull()
  })

  it('读取失败时不打扰用户', async () => {
    svc.get.mockRejectedValue(new Error('系统助手未配置'))
    renderNotice()
    await waitFor(() => expect(svc.get).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
