import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NetworkConfigForm } from '@/pages/ConfigCenter/NetworkConfigForm'

function iface(overrides: Partial<any> = {}) {
  return {
    name: 'eth0', kind: 'ethernet', state: 'connected', connected: true, carrier: true,
    connection: 'Wired connection 1', system: false, mac: 'aa:bb:cc:dd:ee:ff', mtu: 1500,
    ipv4: { method: 'auto', addresses: ['192.168.1.10/24'], gateway: '192.168.1.1', dns: [] },
    ipv6: { method: 'disabled', addresses: [], gateway: null, dns: [] },
    ...overrides,
  }
}

const { mocks } = vi.hoisted(() => ({
  mocks: {
    listInterfaces: vi.fn(),
    getPending: vi.fn(),
    getFallback: vi.fn(),
    confirm: vi.fn(),
    revert: vi.fn(),
    applyIpConfig: vi.fn(),
    scanWifi: vi.fn(),
    wifiConnect: vi.fn(),
    wifiDisconnect: vi.fn(),
  },
}))
vi.mock('@/api/networkService', () => ({ networkService: mocks }))

describe('NetworkConfigForm（配置中心 · 网络管理分类）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listInterfaces.mockResolvedValue([iface()])
    mocks.getPending.mockResolvedValue(null)
    mocks.getFallback.mockResolvedValue(null)
  })

  it('渲染网卡列表：名称、类型、连接状态、IP', async () => {
    render(<NetworkConfigForm />)
    expect(await screen.findByText('eth0')).toBeInTheDocument()
    expect(screen.getByText('有线网络')).toBeInTheDocument()
    expect(screen.getByText('已连接')).toBeInTheDocument()
    expect(screen.getByText('192.168.1.10/24')).toBeInTheDocument()
    // 不接「发布变更」，是独立的实时生效模型
    expect(screen.getByText(/直接生效，不走「发布变更」/)).toBeInTheDocument()
  })

  it('应用 IP 配置成功后立即显示确认横幅——不等下一次 load() 成功回来才显示 (回归)', async () => {
    const user = userEvent.setup()
    mocks.applyIpConfig.mockResolvedValue({ rollbackSeconds: 30 })
    // 关键：apply 成功之后，handleIpApplied 里那次 load() 触发的 getPending
    // 全部失败——修复前，这会把刚设置好的 pending 直接覆盖成 null，横幅消失。
    // 这里模拟"最坏情况"：apply 刚改的正是当前访问用的网卡，紧接着的一次
    // 状态轮询自然更容易失败。
    mocks.getPending.mockRejectedValue(new Error('网络抖动'))

    render(<NetworkConfigForm />)
    await screen.findByText('eth0')
    await user.click(screen.getByRole('button', { name: /IP 配置/ }))
    await screen.findByText('eth0 · IP 配置')
    await user.click(screen.getByRole('button', { name: '应用配置' }))

    // 横幅必须马上出现（乐观状态），不依赖后续任何一次网络请求成功
    expect(await screen.findByRole('alert')).toHaveTextContent('网络配置变更待确认')
    expect(screen.getByRole('alert')).toHaveTextContent('eth0')
    expect(screen.getByRole('button', { name: '确认变更' })).toBeInTheDocument()
  })

  it('待确认横幅显示后，轮询纠偏请求失败不能把横幅冲掉 (回归)', async () => {
    // 用假时钟推进 2s 一次的纠偏轮询；避免在假时钟下混用 findBy*/waitFor
    // ——它们内部靠真实 setTimeout 轮询 DOM，时钟冻结后会一直等不到，整个
    // 测试挂死到 vitest 默认的 5000ms testTimeout 才失败。全程改用同步的
    // getByRole + act() 手动推进，不依赖任何真实定时器。
    vi.useFakeTimers()
    try {
      mocks.getPending.mockResolvedValueOnce({ iface: 'eth0', state: 'waiting_confirm', remaining: 30 })

      render(<NetworkConfigForm />)
      await act(async () => {}) // 落地 mount 时 load() 里已 resolve 的 mock promise
      expect(screen.getByRole('alert')).toHaveTextContent('网络配置变更待确认')

      // 2s 一次的纠偏轮询这次失败：修复前 sync() 会把失败也当成"已无待确认
      // 变更"直接 setPending(null)，横幅应该消失才对——这里验证修复后的
      // 行为：失败时保持原状，横幅不能凭空消失
      mocks.getPending.mockRejectedValueOnce(new Error('网络抖动'))
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) }) // 恰好一次轮询

      expect(screen.getByRole('alert')).toHaveTextContent('网络配置变更待确认')
    } finally {
      vi.useRealTimers()
    }
  })

  describe('自动确认：经被修改网卡的新地址持续可访问才确认，连不上就照常回滚', () => {
    // 按 1 秒步进推进假时钟（单次大跨度推进时 React 到 act 结束才提交渲染、登记新定时器）
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 1_000) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    }
    const waiting = { id: 'c1', iface: 'eth0', state: 'waiting_confirm', remaining: 60 }
    /** 浏览器正是通过 eth0 的地址 192.168.1.10 访问本页 */
    const VIA_ETH0 = '192.168.1.10'

    it('持续可访问约 10 秒后自动确认，只确认一次并收起横幅', async () => {
      vi.useFakeTimers()
      try {
        mocks.getPending.mockResolvedValue(waiting)
        mocks.confirm.mockResolvedValue(undefined)
        render(<NetworkConfigForm accessHost={VIA_ETH0} />)
        await act(async () => {})
        expect(screen.getByRole('alert')).toHaveTextContent('约 10 秒后将自动确认')
        await advance(8_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
        await advance(5_000)
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
        expect(mocks.confirm).toHaveBeenCalledWith('c1')
        expect(screen.queryByRole('alert')).toBeNull()
        await advance(10_000)
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('中途有一次访问失败就重新计时：改完连不上时不会被自动确认', async () => {
      vi.useFakeTimers()
      try {
        let failing = false
        mocks.getPending.mockImplementation(async () => {
          if (failing) throw new Error('连不上')
          return waiting
        })
        mocks.confirm.mockResolvedValue(undefined)
        render(<NetworkConfigForm accessHost={VIA_ETH0} />)
        await act(async () => {})
        await advance(6_000)
        failing = true
        await advance(4_000)
        failing = false
        await advance(8_000) // 恢复后不足 10 秒连续可访问
        expect(mocks.confirm).not.toHaveBeenCalled()
        await advance(4_000)
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('设备还在应用配置（applying）时不计时', async () => {
      vi.useFakeTimers()
      try {
        mocks.getPending.mockResolvedValue({ ...waiting, state: 'applying' })
        render(<NetworkConfigForm accessHost={VIA_ETH0} />)
        await act(async () => {})
        await advance(20_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('经别的网卡访问（如经 WiFi 改有线）：页面可达不能证明被改网卡正常，不自动确认，提示手动确认', async () => {
      vi.useFakeTimers()
      try {
        mocks.getPending.mockResolvedValue(waiting)
        render(<NetworkConfigForm accessHost="192.168.1.99" />)
        await act(async () => {})
        expect(screen.getByRole('alert')).toHaveTextContent('请检查后手动')
        expect(screen.getByRole('alert')).not.toHaveTextContent('约 10 秒后将自动确认')
        await advance(30_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('经出厂兜底地址访问：兜底地址始终在线，不能证明主地址正常，不自动确认', async () => {
      vi.useFakeTimers()
      try {
        mocks.listInterfaces.mockResolvedValue([iface({
          ipv4: { method: 'manual', addresses: ['10.250.100.1/24', '192.168.1.10/24'], gateway: null, dns: [] },
        })])
        mocks.getFallback.mockResolvedValue({ interface: 'eth0', address: '10.250.100.1', prefix: 24, reachable: true })
        mocks.getPending.mockResolvedValue(waiting)
        render(<NetworkConfigForm accessHost="10.250.100.1" />)
        await act(async () => {})
        await advance(30_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
        expect(screen.getByRole('alert')).toHaveTextContent('请检查后手动')
      } finally {
        vi.useRealTimers()
      }
    })

    it('改完后的新地址出现在网卡上才开始计时（地址随轮询刷新）', async () => {
      vi.useFakeTimers()
      try {
        let addr = '192.168.1.10/24'
        mocks.listInterfaces.mockImplementation(async () => [iface({
          ipv4: { method: 'manual', addresses: [addr], gateway: null, dns: [] },
        })])
        mocks.getPending.mockResolvedValue(waiting)
        mocks.confirm.mockResolvedValue(undefined)
        render(<NetworkConfigForm accessHost="192.168.1.20" />)
        await act(async () => {})
        await advance(12_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
        addr = '192.168.1.20/24'
        await advance(14_000)
        expect(mocks.confirm).toHaveBeenCalledWith('c1')
      } finally {
        vi.useRealTimers()
      }
    })

    it('换成另一次变更（ID 变了）重新计时，确认的是新变更', async () => {
      vi.useFakeTimers()
      try {
        let current = waiting
        mocks.getPending.mockImplementation(async () => current)
        mocks.confirm.mockResolvedValue(undefined)
        render(<NetworkConfigForm accessHost={VIA_ETH0} />)
        await act(async () => {})
        await advance(8_000)
        current = { ...waiting, id: 'c2' }
        await advance(4_000)
        expect(mocks.confirm).not.toHaveBeenCalled()
        await advance(10_000)
        expect(mocks.confirm).toHaveBeenCalledTimes(1)
        expect(mocks.confirm).toHaveBeenCalledWith('c2')
      } finally {
        vi.useRealTimers()
      }
    })

    it('自动确认过一次后，下一次变更照样能自动确认（状态不残留）', async () => {
      vi.useFakeTimers()
      try {
        let current: typeof waiting | null = waiting
        mocks.getPending.mockImplementation(async () => current)
        mocks.confirm.mockImplementation(async () => { current = null })
        render(<NetworkConfigForm accessHost={VIA_ETH0} />)
        await act(async () => {})
        await advance(12_000)
        expect(mocks.confirm).toHaveBeenCalledWith('c1')
        expect(screen.queryByRole('alert')).toBeNull()

        current = { ...waiting, id: 'c2' }
        fireEvent.click(screen.getByRole('button', { name: '刷新' }))
        await act(async () => {})
        expect(screen.getByRole('alert')).toBeInTheDocument()
        await advance(12_000)
        expect(mocks.confirm).toHaveBeenCalledTimes(2)
        expect(mocks.confirm).toHaveBeenLastCalledWith('c2')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('IP 配置弹窗：回滚时间可整个删空再输入，超出范围提示且不提交；点遮罩/按 Esc 不关闭', async () => {
    const user = userEvent.setup()
    mocks.applyIpConfig.mockResolvedValue({ rollbackSeconds: 120 })
    render(<NetworkConfigForm />)
    await screen.findByText('eth0')
    await user.click(screen.getByRole('button', { name: /IP 配置/ }))
    await screen.findByText('eth0 · IP 配置')
    const input = screen.getByRole('textbox', { name: '自动回滚时间（秒）' })
    await user.clear(input)
    expect(input).toHaveValue('')
    await user.type(input, '1')
    expect(input).toHaveValue('1')
    await user.click(screen.getByRole('button', { name: '应用配置' }))
    expect(await screen.findByText('自动回滚时间需为 5–300 之间的整数秒')).toBeInTheDocument()
    expect(mocks.applyIpConfig).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('dialog'))
    expect(screen.getByText('eth0 · IP 配置')).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '120')
    await user.click(screen.getByRole('button', { name: '应用配置' }))
    await waitFor(() => expect(mocks.applyIpConfig).toHaveBeenCalled())
    expect(mocks.applyIpConfig.mock.calls[0]![1].rollback_seconds).toBe(120)
  })

  it('IP 配置弹窗默认回滚时间为 60 秒', async () => {
    const user = userEvent.setup()
    render(<NetworkConfigForm />)
    await screen.findByText('eth0')
    await user.click(screen.getByRole('button', { name: /IP 配置/ }))
    await screen.findByText('eth0 · IP 配置')
    expect(screen.getByRole('textbox', { name: '自动回滚时间（秒）' })).toHaveValue('60')
  })

  it('待确认变更存在时，其它网卡的 IP 配置/WiFi 按钮禁用并带提示', async () => {
    mocks.listInterfaces.mockResolvedValue([
      iface({ name: 'eth0' }),
      iface({ name: 'wlan0', kind: 'wifi' }),
    ])
    mocks.getPending.mockResolvedValue({ iface: 'eth0', state: 'waiting_confirm', remaining: 20 })

    render(<NetworkConfigForm />)
    await screen.findByRole('alert')

    const wlanRow = screen.getByText('wlan0').closest('li')!
    expect(within(wlanRow).getByRole('button', { name: /IP 配置/ })).toBeDisabled()
    expect(within(wlanRow).getByRole('button', { name: /WiFi/ })).toBeDisabled()

    const ethRow = screen.getByText('eth0').closest('li')!
    expect(within(ethRow).getByRole('button', { name: /IP 配置/ })).not.toBeDisabled()
  })

  it('确认变更：调用 confirm 并收起横幅', async () => {
    const user = userEvent.setup()
    mocks.getPending.mockResolvedValue({ id: 'm1', iface: 'eth0', state: 'waiting_confirm', remaining: 20 })
    mocks.confirm.mockResolvedValue(undefined)

    render(<NetworkConfigForm />)
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: '确认变更' }))

    expect(mocks.confirm).toHaveBeenCalledWith('m1')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('WiFi 弹窗：可以切到手动模式连接隐藏网络', async () => {
    const user = userEvent.setup()
    mocks.listInterfaces.mockResolvedValue([iface({ name: 'wlan0', kind: 'wifi' })])
    mocks.scanWifi.mockResolvedValue([])
    mocks.wifiConnect.mockResolvedValue(undefined)

    render(<NetworkConfigForm />)
    await screen.findByText('wlan0')
    await user.click(screen.getByRole('button', { name: /WiFi/ }))
    await screen.findByText('wlan0 · WiFi')

    await user.click(screen.getByRole('button', { name: /连接隐藏网络/ }))
    await user.type(screen.getByLabelText(/网络名称/), 'MyHiddenNet')
    // 默认勾选"需要密码"但没填密码时连接按钮应保持禁用；取消勾选表示开放网络
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
    await user.click(screen.getByLabelText(/需要密码/))
    await user.click(screen.getByRole('button', { name: '连接' }))
    // 切换无线网络会中断经由它的视频流：必须先确认
    expect(mocks.wifiConnect).not.toHaveBeenCalled()
    expect(screen.getByText(/视频流会中断/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认连接' }))

    await waitFor(() => expect(mocks.wifiConnect).toHaveBeenCalledWith('wlan0', 'MyHiddenNet', null, true))
  })

  it('WiFi 弹窗：从扫描列表选一个开放网络连接时显式传 hidden:false (回归)', async () => {
    const user = userEvent.setup()
    mocks.listInterfaces.mockResolvedValue([iface({ name: 'wlan0', kind: 'wifi' })])
    mocks.scanWifi.mockResolvedValue([
      { ssid: 'OpenNet', bssid: 'aa:aa:aa:aa:aa:aa', mode: 'infra', channel: 6, rate: '54 Mbit/s', signal: 80, security: '', active: false },
    ])
    mocks.wifiConnect.mockResolvedValue(undefined)

    render(<NetworkConfigForm />)
    await screen.findByText('wlan0')
    await user.click(screen.getByRole('button', { name: /WiFi/ }))
    await screen.findByText('OpenNet')
    await user.click(screen.getByText('OpenNet'))
    await user.click(screen.getByRole('button', { name: '连接' }))
    await user.click(screen.getByRole('button', { name: '确认连接' }))

    // hidden 必须显式传 false，不能让它 undefined 掉——JSON.stringify 会
    // 直接丢掉这个 key，虽然 os-helper 端 bool(body.get('hidden', False))
    // 缺省也是 False、这次巧合对了，但那是运气不是契约
    await waitFor(() => expect(mocks.wifiConnect).toHaveBeenCalledWith('wlan0', 'OpenNet', null, false))
  })

  describe('兜底网卡：只读兜底地址与可编辑主地址分开', () => {
    const fb = { interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: true }
    const wired = (addresses: string[]) => iface({
      name: 'enP8p1s0', connection: 'factory-fallback',
      ipv4: { method: 'manual', addresses, gateway: null, dns: [] },
    })

    it('还没设主地址时列表显示"主地址未设置"，兜底地址单独标为只读', async () => {
      mocks.listInterfaces.mockResolvedValue([wired(['10.250.100.1/24'])])
      mocks.getFallback.mockResolvedValue(fb)
      render(<NetworkConfigForm />)
      const row = (await screen.findAllByText('enP8p1s0')).map(e => e.closest('li')).find(Boolean)!
      expect(within(row).getByText('主地址未设置')).toBeInTheDocument()
      expect(within(row).getByText('兜底 10.250.100.1/24（只读）')).toBeInTheDocument()
    })

    it('设了主地址后两个地址同时显示', async () => {
      mocks.listInterfaces.mockResolvedValue([wired(['192.168.100.185/17', '10.250.100.1/24'])])
      mocks.getFallback.mockResolvedValue(fb)
      render(<NetworkConfigForm />)
      const row = (await screen.findAllByText('enP8p1s0')).map(e => e.closest('li')).find(Boolean)!
      expect(within(row).getByText('192.168.100.185/17')).toBeInTheDocument()
      expect(within(row).getByText('兜底 10.250.100.1/24（只读）')).toBeInTheDocument()
      expect(within(row).queryByText('主地址未设置')).toBeNull()
    })

    it('IP 配置弹窗：不预填兜底地址，不提供自动获取，说明兜底地址始终保留', async () => {
      const user = userEvent.setup()
      mocks.listInterfaces.mockResolvedValue([wired(['10.250.100.1/24'])])
      mocks.getFallback.mockResolvedValue(fb)
      render(<NetworkConfigForm />)
      await screen.findAllByText('enP8p1s0')
      await user.click(screen.getByRole('button', { name: /IP 配置/ }))
      await screen.findByText('enP8p1s0 · IP 配置')
      expect(screen.getByText(/出厂兜底地址 10\.250\.100\.1\/24 始终保留/)).toBeInTheDocument()
      const addr = screen.getByPlaceholderText('192.168.1.100') as HTMLInputElement
      expect(addr.value).toBe('')
      const v4Mode = screen.getAllByRole('combobox')[0]!
      expect(within(v4Mode).queryByRole('option', { name: /自动/ })).toBeNull()
      expect(within(v4Mode).getByRole('option', { name: '手动' })).toBeInTheDocument()
    })

    it('主地址不能落在兜底网段里', async () => {
      const user = userEvent.setup()
      mocks.listInterfaces.mockResolvedValue([wired(['10.250.100.1/24'])])
      mocks.getFallback.mockResolvedValue(fb)
      render(<NetworkConfigForm />)
      await screen.findAllByText('enP8p1s0')
      await user.click(screen.getByRole('button', { name: /IP 配置/ }))
      await screen.findByText('enP8p1s0 · IP 配置')
      await user.type(screen.getByPlaceholderText('192.168.1.100'), '10.250.100.5')
      await user.click(screen.getByRole('button', { name: '应用配置' }))
      expect(await screen.findByText(/不能使用出厂兜底地址所在网段/)).toBeInTheDocument()
      expect(mocks.applyIpConfig).not.toHaveBeenCalled()
    })
  })

  it('没走 provisioning 的设备（fallback 为 null）不显示兜底地址卡片', async () => {
    render(<NetworkConfigForm />)
    await screen.findByText('eth0')
    expect(screen.queryByText('出厂兜底地址')).toBeNull()
  })

  it('展示出厂兜底地址信息卡片：地址、挂载网卡、在线状态', async () => {
    mocks.getFallback.mockResolvedValue({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: false })
    render(<NetworkConfigForm />)
    await screen.findByText('出厂兜底地址')
    expect(screen.getByText('10.250.100.1/24')).toBeInTheDocument()
    expect(screen.getByText('enP8p1s0')).toBeInTheDocument()
    expect(screen.getByText('当前不可达')).toBeInTheDocument()
  })

  it('恢复出厂网络设置：确认后对兜底网卡应用 disabled/disabled，立即显示待确认横幅', async () => {
    const user = userEvent.setup()
    mocks.getFallback.mockResolvedValue({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: true })
    mocks.applyIpConfig.mockResolvedValue({ rollbackSeconds: 30 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<NetworkConfigForm />)
    await screen.findByText('出厂兜底地址')
    await user.click(screen.getByRole('button', { name: '恢复出厂网络设置' }))

    expect(confirmSpy).toHaveBeenCalled()
    expect(mocks.applyIpConfig).toHaveBeenCalledWith('enP8p1s0', {
      ipv4: { method: 'disabled' },
      ipv6: { method: 'disabled' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('网络配置变更待确认')
    expect(screen.getByRole('alert')).toHaveTextContent('enP8p1s0')
    confirmSpy.mockRestore()
  })

  it('取消确认对话框时不调用 applyIpConfig', async () => {
    const user = userEvent.setup()
    mocks.getFallback.mockResolvedValue({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: true })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<NetworkConfigForm />)
    await screen.findByText('出厂兜底地址')
    await user.click(screen.getByRole('button', { name: '恢复出厂网络设置' }))

    expect(mocks.applyIpConfig).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('兜底网卡自己有待确认变更时，恢复出厂网络设置按钮禁用', async () => {
    mocks.getFallback.mockResolvedValue({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: true })
    mocks.getPending.mockResolvedValue({ iface: 'enP8p1s0', state: 'waiting_confirm', remaining: 20 })

    render(<NetworkConfigForm />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '恢复出厂网络设置' })).toBeDisabled()
  })

  it('待确认变更在别的网卡上时，恢复出厂网络设置按钮不受影响 (回归)', async () => {
    // 之前 disabled={acting || !!pending} 太粗——只要任何网卡有待确认变更
    // 就把这个按钮也锁了，但恢复出厂只改兜底网卡自己，不该被别的网卡的
    // 待确认状态拖累。
    mocks.getFallback.mockResolvedValue({ interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: true })
    mocks.getPending.mockResolvedValue({ iface: 'eth0', state: 'waiting_confirm', remaining: 20 })

    render(<NetworkConfigForm />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '恢复出厂网络设置' })).not.toBeDisabled()
  })
})
