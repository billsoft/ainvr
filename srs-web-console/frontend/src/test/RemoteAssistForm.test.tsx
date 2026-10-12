import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RemoteAssistForm } from '@/pages/ConfigCenter/RemoteAssistForm'
import { RemoteAssistIndicator } from '@/components/layout/RemoteAssistIndicator'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getStatus: vi.fn(),
    listEvents: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    updateServer: vi.fn(),
    test: vi.fn(),
  },
}))
vi.mock('@/api/remoteAssistService', () => ({ remoteAssistService: mocks }))

function status(overrides: Record<string, unknown> = {}) {
  return {
    installed: true, enabled: false, running: false, state: 'disabled', message: null,
    server: { host: 'relay.example.com', port: 443 }, credentials: true, sessions: 0, enabled_at: null,
    ...overrides,
  }
}

describe('RemoteAssistForm（系统配置 · 远程协助）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStatus.mockResolvedValue(status())
    mocks.listEvents.mockResolvedValue([
      { ts: Date.parse('2026-10-05T15:08:00+08:00'), type: 'disabled', actor: 'admin', detail: null },
      { ts: Date.parse('2026-10-05T14:41:00+08:00'), type: 'server_changed', actor: 'admin', detail: 'relay.example.com:443' },
      { ts: Date.parse('2026-10-05T14:30:00+08:00'), type: 'session_ended', actor: null, detail: '持续约 26 分钟' },
    ])
    mocks.enable.mockResolvedValue(undefined)
    mocks.disable.mockResolvedValue(undefined)
  })

  it('关闭状态：显示开关、中转服务器、凭据状态和记录', async () => {
    render(<RemoteAssistForm />)
    const sw = await screen.findByRole('switch', { name: '远程协助开关' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('已关闭')).toBeInTheDocument()
    expect(screen.getByLabelText('服务器地址')).toHaveValue('relay.example.com')
    expect(screen.getByLabelText('端口')).toHaveValue('443')
    expect(screen.getByLabelText('服务器地址')).toHaveAttribute('readonly')
    expect(screen.getByText(/接入凭据：已写入/)).toBeInTheDocument()
    expect(await screen.findByText('关闭远程协助')).toBeInTheDocument()
    expect(screen.getByText('修改中转服务器为 relay.example.com:443')).toBeInTheDocument()
    expect(screen.getByText('远程连接结束，持续约 26 分钟')).toBeInTheDocument()
  })

  it('开启前必须确认，确认后才调用并刷新状态', async () => {
    const user = userEvent.setup()
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('switch', { name: '远程协助开关' }))
    expect(screen.getByText(/技术支持人员可以通过中转服务器远程登录本设备/)).toBeInTheDocument()
    expect(screen.getByText(/直到您在此关闭/)).toBeInTheDocument()
    expect(mocks.enable).not.toHaveBeenCalled()
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connecting', enabled_at: Date.now() }))
    await user.click(screen.getByRole('button', { name: '确认开启' }))
    expect(mocks.enable).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('连接中')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '远程协助开关' })).toHaveAttribute('aria-checked', 'true')
  })

  it('取消确认不做任何操作', async () => {
    const user = userEvent.setup()
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('switch', { name: '远程协助开关' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(mocks.enable).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '确认开启' })).not.toBeInTheDocument()
  })

  it('关闭前提示会话会断开，确认后调用关闭', async () => {
    const user = userEvent.setup()
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected', sessions: 1, enabled_at: Date.now() - 3 * 86400_000 }))
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('switch', { name: '远程协助开关' }))
    expect(screen.getByText(/已建立的远程连接会立即断开/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(mocks.disable).toHaveBeenCalledTimes(1)
  })

  it('已连接且有人接入：显示正在远程操作、会话数和开启时长，开启期间不能修改中转服务器', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected', sessions: 1, enabled_at: Date.now() - 3 * 86400_000 }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('正在远程操作')).toBeInTheDocument()
    expect(screen.getByText('当前远程连接')).toBeInTheDocument()
    expect(screen.getByText('1 个')).toBeInTheDocument()
    expect(screen.getByText(/不代表已通过身份验证/)).toBeInTheDocument()
    expect(screen.getByText(/已开启 3 天/)).toBeInTheDocument()
    expect(screen.getByText('远程协助开启或仍在运行时不能修改，请先关闭远程协助')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument()
  })

  it('已连接但无人接入：显示等待技术支持接入，不显示正在操作提示', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected', sessions: 0, enabled_at: Date.now() }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('已连接 · 等待接入')).toBeInTheDocument()
    expect(screen.getByText(/技术支持登录后这里会显示“正在远程操作”/)).toBeInTheDocument()
    expect(screen.queryByText(/技术支持正在远程操作本设备/)).not.toBeInTheDocument()
  })

  it('有远程连接时醒目提示正在操作，并说明可随时关闭', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected', sessions: 2, enabled_at: Date.now() }))
    render(<RemoteAssistForm />)
    const banner = await screen.findByText(/技术支持正在远程操作本设备（2 个远程连接）/)
    expect(banner).toHaveTextContent('关闭远程协助')
    expect(screen.getByText('2 个')).toBeInTheDocument()
  })

  it('连接异常时即使残留连接数也不显示正在操作（以连接状态为准）', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'error', message: '连接中转服务器超时', sessions: 1 }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('连接失败')).toBeInTheDocument()
    expect(screen.queryByText('正在远程操作')).not.toBeInTheDocument()
  })

  it('显示本机机器码供技术支持核对（四位一组）', async () => {
    mocks.getStatus.mockResolvedValue(status({ machine_code: 'X3TZMPW0TWQJX9MH7NWXM0MM' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('X3TZ-MPW0-TWQJ-X9MH-7NWX-M0MM')).toBeInTheDocument()
    expect(screen.getByText('本机机器码')).toBeInTheDocument()
  })

  it('还没读到机器码时不显示空的机器码', async () => {
    render(<RemoteAssistForm />)
    expect(await screen.findByText('已关闭')).toBeInTheDocument()
    expect(screen.queryByText('本机机器码')).not.toBeInTheDocument()
  })

  it('修改中转服务器：需要管理员密码，保存后退出编辑', async () => {
    const user = userEvent.setup()
    mocks.updateServer.mockResolvedValue({ host: 'b.example.com', port: 8443 })
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('button', { name: '修改' }))
    const host = screen.getByLabelText('服务器地址')
    expect(host).not.toHaveAttribute('readonly')
    await user.clear(host); await user.type(host, 'b.example.com')
    await user.clear(screen.getByLabelText('端口')); await user.type(screen.getByLabelText('端口'), '8443')
    await user.type(screen.getByLabelText('管理员密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.updateServer).toHaveBeenCalledWith('b.example.com', 8443, 'pw')
    await waitFor(() => expect(screen.queryByLabelText('管理员密码')).not.toBeInTheDocument())
  })

  it('修改中转服务器：端口无效时就地提示，不提交', async () => {
    const user = userEvent.setup()
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('button', { name: '修改' }))
    await user.clear(screen.getByLabelText('端口')); await user.type(screen.getByLabelText('端口'), '70000')
    await user.type(screen.getByLabelText('管理员密码'), 'pw')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('端口必须是 1–65535 的整数')).toBeInTheDocument()
    expect(mocks.updateServer).not.toHaveBeenCalled()
  })

  it('修改中转服务器：保存失败时显示原因并保持编辑', async () => {
    const user = userEvent.setup()
    mocks.updateServer.mockRejectedValue(new Error('管理员密码不正确'))
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('button', { name: '修改' }))
    await user.type(screen.getByLabelText('管理员密码'), 'bad')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('管理员密码不正确')).toBeInTheDocument()
    expect(screen.getByLabelText('管理员密码')).toBeInTheDocument()
  })

  it('连接失败：显示中文原因', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'error', message: '连接中转服务器超时，请检查本机网络' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('连接失败')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('连接中转服务器超时，请检查本机网络')
  })

  it('组件未安装：说明原因且开关不可用', async () => {
    mocks.getStatus.mockResolvedValue(status({ installed: false, state: 'unavailable', message: '远程协助组件未安装，请升级设备软件' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('远程协助组件未安装，请升级设备软件')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '远程协助开关' })).toBeDisabled()
  })

  it('未写入凭据时提示联系供应商', async () => {
    mocks.getStatus.mockResolvedValue(status({ credentials: false }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText(/接入凭据：未写入，请联系供应商/)).toBeInTheDocument()
  })

  it('检测连通性：显示结果', async () => {
    const user = userEvent.setup()
    mocks.test.mockResolvedValue({ ok: true, latency_ms: 35, message: '中转服务器可以连接' })
    render(<RemoteAssistForm />)
    await user.click(await screen.findByRole('button', { name: '检测连通性' }))
    expect(await screen.findByText('中转服务器可以连接（延迟 35 毫秒）')).toBeInTheDocument()
  })

  it('已取消自启但进程仍在运行：显示正在关闭，可再次关闭，不能修改服务器', async () => {
    const user = userEvent.setup()
    mocks.getStatus.mockResolvedValue(status({ enabled: false, running: true, state: 'stopping', message: '远程协助已关闭，但连接程序仍在运行，请再次关闭或稍后刷新' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('正在关闭')).toBeInTheDocument()
    expect(screen.getByText(/连接程序仍在运行/)).toBeInTheDocument()
    const sw = screen.getByRole('switch', { name: '远程协助开关' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument()
    await user.click(sw)
    await user.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(mocks.disable).toHaveBeenCalledTimes(1)
    expect(mocks.enable).not.toHaveBeenCalled()
  })

  it('云端暂停：保留客户开关，说明由供应商暂停且恢复后自动连接', async () => {
    const user = userEvent.setup()
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'suspended', message: '供应商已在中转服务器上暂停本设备的远程协助，恢复后会自动重新连接，无需操作' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('云端已暂停')).toBeInTheDocument()
    expect(screen.getByText(/恢复后会自动重新连接/)).toBeInTheDocument()
    expect(screen.queryByText('连接失败')).not.toBeInTheDocument()
    const sw = screen.getByRole('switch', { name: '远程协助开关' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await user.click(sw)
    expect(screen.getByRole('button', { name: '确认关闭' })).toBeInTheDocument()
  })

  it('状态未知：不当成已关闭，不允许修改服务器', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: null, running: null, state: 'unknown', message: '暂时无法确认远程协助状态，请稍后刷新' }))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('状态未知')).toBeInTheDocument()
    expect(screen.queryByText('已关闭')).not.toBeInTheDocument()
    expect(screen.getByText('暂时无法确认远程协助状态，请稍后刷新')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument()
  })

  describe('与轮询的竞争', () => {
    afterEach(() => { vi.useRealTimers() })

    it('确认框锁定点击时的目标：确认期间状态被别处改变，也只执行原来的动作', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<RemoteAssistForm />)
      await user.click(await screen.findByRole('switch', { name: '远程协助开关' }))
      mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      await user.click(screen.getByRole('button', { name: '确认开启' }))
      expect(mocks.enable).toHaveBeenCalledTimes(1)
      expect(mocks.disable).not.toHaveBeenCalled()
    })

    it('操作前发出的旧查询晚到，不会覆盖操作后的新状态', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<RemoteAssistForm />)
      const sw = await screen.findByRole('switch', { name: '远程协助开关' })
      let resolveStale!: (value: unknown) => void
      mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve }))
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connecting', enabled_at: Date.now() }))
      await user.click(sw)
      await user.click(screen.getByRole('button', { name: '确认开启' }))
      expect(await screen.findByText('连接中')).toBeInTheDocument()
      await act(async () => { resolveStale(status()) })
      expect(screen.getByText('连接中')).toBeInTheDocument()
      expect(screen.queryByText('已关闭')).not.toBeInTheDocument()
    })
  })

  it('状态读取失败时显示提示', async () => {
    mocks.getStatus.mockRejectedValue(new Error('暂时无法读取远程协助状态，请稍后重试'))
    render(<RemoteAssistForm />)
    expect(await screen.findByText('暂时无法读取远程协助状态，请稍后重试')).toBeInTheDocument()
  })
})

describe('RemoteAssistIndicator（顶栏提醒）', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { vi.useRealTimers() })
  const show = () => render(<MemoryRouter><RemoteAssistIndicator /></MemoryRouter>)

  it('开启时显示并链接到远程协助页', async () => {
    mocks.getStatus.mockResolvedValue(status({ enabled: true, running: true, state: 'connected' }))
    show()
    const link = await screen.findByRole('link', { name: /远程协助已开启/ })
    expect(link).toHaveAttribute('href', '/config-center?category=remote-assist')
  })

  it('有人远程登录时顶栏显示正在远程操作', async () => {
    mocks.getStatus.mockResolvedValueOnce(status({ enabled: true, running: true, state: 'connected', sessions: 1 }))
    show()
    expect(await screen.findByRole('link', { name: /技术支持正在远程操作/ })).toBeInTheDocument()
  })

  it('顶栏在开启期间 15 秒内刷新，及时反映接入和离开', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.getStatus.mockResolvedValueOnce(status({ enabled: true, running: true, state: 'connected', sessions: 0 }))
      .mockResolvedValueOnce(status({ enabled: true, running: true, state: 'connected', sessions: 1 }))
    show()
    expect(await screen.findByRole('link', { name: /远程协助已开启/ })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(await screen.findByRole('link', { name: /技术支持正在远程操作/ })).toBeInTheDocument()
  })

  it('明确关闭时不显示；从未读到状态时也不显示', async () => {
    mocks.getStatus.mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error('x'))
    const { unmount } = show()
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled())
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    unmount()
    show()
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('已开启后查询失败：保留提醒并显示状态待确认', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.getStatus.mockResolvedValueOnce(status({ enabled: true, running: true, state: 'connected' }))
      .mockRejectedValueOnce(new Error('登录已过期'))
    show()
    expect(await screen.findByRole('link', { name: /远程协助已开启/ })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(await screen.findByRole('link', { name: /远程协助状态待确认/ })).toBeInTheDocument()
  })

  it('状态未知或进程仍在运行时都要提醒', async () => {
    mocks.getStatus.mockResolvedValueOnce(status({ enabled: null, running: null, state: 'unknown' }))
    const { unmount } = show()
    expect(await screen.findByRole('link', { name: /远程协助状态待确认/ })).toBeInTheDocument()
    unmount()
    mocks.getStatus.mockResolvedValueOnce(status({ enabled: false, running: true, state: 'stopping' }))
    show()
    expect(await screen.findByRole('link', { name: /远程协助仍在运行/ })).toBeInTheDocument()
  })
})
