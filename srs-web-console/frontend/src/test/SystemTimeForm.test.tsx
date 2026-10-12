import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SystemTimeForm } from '@/pages/ConfigCenter/SystemTimeForm'

const { svc } = vi.hoisted(() => ({ svc: { get: vi.fn(), setTime: vi.fn(), setNtpServers: vi.fn() } }))
vi.mock('@/api/systemTimeService', () => ({ systemTimeService: svc, SYSTEM_TIME_CHANGED_EVENT: 'ainvr:system-time-changed' }))

const NOW = new Date('2026-10-09T14:00:00+08:00').getTime()
const base = {
  epoch_ms: NOW, timezone: 'Asia/Shanghai', ntp_enabled: true, ntp_synchronized: false,
  manually_set: false, valid: true, min_valid_epoch_ms: 1767225600000, ntp_servers: [] as string[],
}

describe('系统配置 · 日期和时间', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    svc.setTime.mockResolvedValue({ ...base, manually_set: true, restarted: ['录像服务', 'AI 识别服务'] })
    svc.setNtpServers.mockResolvedValue(base)
  })
  afterEach(() => { vi.useRealTimers() })

  it('显示设备与电脑的时间差，以及开机后尚未对时的状态', async () => {
    svc.get.mockResolvedValue({ ...base, epoch_ms: NOW - 22 * 60_000 })
    render(<SystemTimeForm />)
    expect(await screen.findByText('设备比电脑慢 22 分钟')).toBeInTheDocument()
    expect(screen.getByText(/开机后尚未对时/)).toBeInTheDocument()
  })

  it('已与时间服务器同步时如实显示', async () => {
    svc.get.mockResolvedValue({ ...base, ntp_synchronized: true })
    render(<SystemTimeForm />)
    expect(await screen.findByText('已与时间服务器同步')).toBeInTheDocument()
    expect(screen.getByText('与电脑时间一致')).toBeInTheDocument()
  })

  it('时间无效（早于 2026 年）时醒目提示业务已暂停', async () => {
    svc.get.mockResolvedValue({ ...base, epoch_ms: 1735689600000, valid: false })
    render(<SystemTimeForm />)
    expect(await screen.findByText(/时间无效/)).toBeInTheDocument()
    expect(screen.getByText(/录像与 AI 已暂停/)).toBeInTheDocument()
  })

  it('一键使用电脑时间校准：确认后按电脑当前时间设置，并告知会重启录像与 AI', async () => {
    svc.get.mockResolvedValue({ ...base, epoch_ms: NOW - 3_600_000 })
    render(<SystemTimeForm />)
    fireEvent.click(await screen.findByRole('button', { name: '使用电脑时间校准' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('重启录像服务和 AI 识别服务')
    vi.setSystemTime(NOW + 5000)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认校准' }))
    await waitFor(() => expect(svc.setTime).toHaveBeenCalledWith(NOW + 5000))
    expect(await screen.findByText(/录像服务、AI 识别服务正在重启/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('手动设置：与电脑时间相差超过 1 天要二次确认并提示会消耗授权', async () => {
    svc.get.mockResolvedValue(base)
    render(<SystemTimeForm />)
    fireEvent.change(await screen.findByLabelText('设备时间'), { target: { value: '2062-10-09T14:00:00' } })
    fireEvent.click(screen.getByRole('button', { name: '设置时间' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/相差 \d+ 天/)
    expect(dialog).toHaveTextContent('消耗授权')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认校准' }))
    await waitFor(() => expect(svc.setTime).toHaveBeenCalledWith(new Date('2062-10-09T14:00:00').getTime()))
  })

  it('手动设置：相差不大时不出现授权警告', async () => {
    svc.get.mockResolvedValue(base)
    render(<SystemTimeForm />)
    fireEvent.change(await screen.findByLabelText('设备时间'), { target: { value: '2026-10-09T15:30:00' } })
    fireEvent.click(screen.getByRole('button', { name: '设置时间' }))
    expect(screen.getByRole('dialog')).not.toHaveTextContent('消耗授权')
  })

  it('手动设置：早于 2026-01-01 直接拒绝，不弹确认也不提交', async () => {
    svc.get.mockResolvedValue(base)
    render(<SystemTimeForm />)
    fireEvent.change(await screen.findByLabelText('设备时间'), { target: { value: '2025-12-31T23:00:00' } })
    fireEvent.click(screen.getByRole('button', { name: '设置时间' }))
    expect(screen.getByText('时间不能早于 2026-01-01')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(svc.setTime).not.toHaveBeenCalled()
  })

  it('时间服务器：预填已有地址，按逗号/空格拆分保存', async () => {
    svc.get.mockResolvedValue({ ...base, ntp_servers: ['192.168.0.1'] })
    render(<SystemTimeForm />)
    const input = await screen.findByLabelText('时间服务器地址')
    expect(input).toHaveValue('192.168.0.1')
    fireEvent.change(input, { target: { value: '192.168.0.1， ntp.lan' } })
    fireEvent.click(screen.getByRole('button', { name: '保存时间服务器' }))
    await waitFor(() => expect(svc.setNtpServers).toHaveBeenCalledWith(['192.168.0.1', 'ntp.lan']))
  })

  it('校时失败时显示原因', async () => {
    svc.get.mockResolvedValue(base)
    svc.setTime.mockRejectedValue(new Error('时间必须在 2026-01-01 到 2100-01-01 之间'))
    render(<SystemTimeForm />)
    fireEvent.click(await screen.findByRole('button', { name: '使用电脑时间校准' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认校准' }))
    expect(await screen.findByText(/时间必须在 2026-01-01/)).toBeInTheDocument()
  })
})
