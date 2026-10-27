import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { request } from '@/api/httpClient'
import { channelService } from '@/api/channelService'
import { GBInputDiagnostics } from '@/pages/Channels/GBInputDiagnostics'
vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
vi.mock('@/api/channelService', () => ({ channelService: { get: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const channel = { id: 'input', status: { online: true }, upstream: { protocol: 'rtmp', inputEnabled: true } } as any
function setup(reason = '', audio = 'pcma', bound = true) {
  vi.mocked(channelService.get).mockResolvedValue(channel)
  vi.mocked(request).mockImplementation(async (url) => url === '/gb28181/bindings'
    ? { items: bound ? [{ binding_id: 'lease', input_id: 'input', enabled: true }] : [] }
    : { state: 'running', inputs: [{ id: 'lease', state: reason === 'media_peer_mismatch' ? 'recovering' : 'streaming', reason, audio }] } as any)
}
describe('GB input diagnostics', () => {
  it('shows actual audio conversion and the current SRS status', async () => {
    setup()
    const status = vi.fn()
    render(<GBInputDiagnostics channel={channel} onStatus={status} />)
    await screen.findByRole('region', { name: '国标摄像头接入诊断' })
    expect(screen.getByText(/PCMA → AAC/)).toBeTruthy()
    expect(screen.getByText(/SRS 已收到发布流/)).toBeTruthy()
    expect(status).toHaveBeenCalledWith(channel.status)
  })
  it('explains rejected RTP origins instead of displaying a raw reason code', async () => {
    setup('media_peer_mismatch')
    render(<GBInputDiagnostics channel={channel} />)
    await screen.findByText(/实际媒体来源与协商地址不一致/)
    expect(screen.queryByText('media_peer_mismatch')).toBeNull()
  })
  it('keeps ordinary RTMP inputs free of GB diagnostics and reports unsupported audio explicitly', async () => {
    setup('', '', false)
    const view = render(<GBInputDiagnostics channel={channel} />)
    await waitFor(() => expect(channelService.get).toHaveBeenCalled())
    expect(screen.queryByRole('region')).toBeNull()
    view.unmount()
    setup('unsupported_audio_codec', 'opus')
    render(<GBInputDiagnostics channel={channel} />)
    await screen.findByText(/当前音频编码不支持/)
    expect(screen.getByText(/不可用，当前仅视频/)).toBeTruthy()
  })
})
