import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamingConfigForm } from '@/pages/ConfigCenter/StreamingConfigForm'

const { listInterfaces } = vi.hoisted(() => ({ listInterfaces: vi.fn() }))
vi.mock('@/api/networkService', () => ({ networkService: { listInterfaces } }))
vi.mock('@/api/systemService', () => ({ systemService: { getSummary: vi.fn() } }))

const nic = (name: string, kind: string, addresses: string[], extra: Record<string, unknown> = {}) => ({
  name, kind, state: '', connected: true, carrier: true, connection: null, system: false, mac: null, mtu: null,
  speed: null, ipv4: { method: 'manual', addresses, gateway: null, dns: [] },
  ipv6: { method: 'auto', addresses: [], gateway: null, dns: [] }, ...extra,
})

function doc(config: Record<string, unknown>) {
  return { service: 'srs', group: 'system', name: 'settings', config } as never
}

function setup(rtcCandidateIp?: string) {
  const onSavePartial = vi.fn(async () => undefined)
  render(<StreamingConfigForm backendDoc={undefined}
    srsDoc={doc(rtcCandidateIp === undefined ? {} : { rtcCandidateIp })} onSavePartial={onSavePartial} />)
  return onSavePartial
}

describe('StreamingConfigForm · WebRTC 播放地址', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listInterfaces.mockResolvedValue([
      nic('wlP1p1s0', 'wifi', ['192.168.100.183/17']),
      nic('enP8p1s0', 'ethernet', ['10.0.0.8/24'], { connected: false }),
      nic('docker0', 'bridge', ['172.17.0.1/16'], { system: true }),
    ])
  })

  it('未设置时默认自动，保存写空值（按浏览器访问地址）', async () => {
    const save = setup()
    const auto = screen.getByRole('radio', { name: /自动（推荐）/ })
    expect(auto).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: /指定地址/ }))
    await userEvent.click(auto)
    await userEvent.click(screen.getByRole('button', { name: '保存 WebRTC 播放地址' }))
    expect(save).toHaveBeenCalledWith('srs', 'system', 'settings', { rtcCandidateIp: '' }, 'WebRTC 播放地址：自动')
  })

  it('指定地址：下拉列出本机网口 IPv4（去掉前缀长度，不列系统虚拟网卡），选中后保存', async () => {
    const save = setup()
    await userEvent.click(screen.getByRole('radio', { name: /指定地址/ }))
    const select = await screen.findByRole('combobox', { name: '本机网口地址' })
    await waitFor(() => expect(screen.getByRole('option', { name: /无线网卡 wlP1p1s0 · 192\.168\.100\.183/ })).toBeInTheDocument())
    expect(screen.getByRole('option', { name: /有线网口 enP8p1s0（未连接） · 10\.0\.0\.8/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /172\.17\.0\.1/ })).not.toBeInTheDocument()
    await userEvent.selectOptions(select, '10.0.0.8')
    await userEvent.click(screen.getByRole('button', { name: '保存 WebRTC 播放地址' }))
    expect(save).toHaveBeenCalledWith('srs', 'system', 'settings', { rtcCandidateIp: '10.0.0.8' }, 'WebRTC 播放地址：指定 10.0.0.8')
  })

  it('已保存的地址回显为指定模式；不在网口列表里的地址回显为手动输入', async () => {
    setup('203.0.113.10')
    expect(screen.getByRole('radio', { name: /指定地址/ })).toBeChecked()
    expect(await screen.findByRole('textbox', { name: '手动输入地址' })).toHaveValue('203.0.113.10')
  })

  it('手动输入：非法字符不能保存', async () => {
    const save = setup()
    await userEvent.click(screen.getByRole('radio', { name: /指定地址/ }))
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: '本机网口地址' }), '__custom__')
    await userEvent.type(screen.getByRole('textbox', { name: '手动输入地址' }), '1.2.3.4;evil')
    expect(screen.getByText('地址只能包含字母、数字、点、短横线')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存 WebRTC 播放地址' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })

  it('读不到网口时仍可手动输入', async () => {
    listInterfaces.mockRejectedValueOnce(new Error('down'))
    const save = setup()
    await userEvent.click(screen.getByRole('radio', { name: /指定地址/ }))
    expect(await screen.findByText('暂时读不到本机网口，请手动输入地址。')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '手动输入地址' }), '192.168.1.5')
    await userEvent.click(screen.getByRole('button', { name: '保存 WebRTC 播放地址' }))
    expect(save).toHaveBeenCalledWith('srs', 'system', 'settings', { rtcCandidateIp: '192.168.1.5' }, expect.any(String))
  })

  it('用名称打开本页时，自动模式提示改用 IP 或指定地址（测试环境主机名为 localhost）', async () => {
    setup()
    expect(await screen.findByText(/当前通过名称「localhost」打开本页/)).toBeInTheDocument()
  })
})
