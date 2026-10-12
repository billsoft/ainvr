import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChannelWizard } from '@/pages/Channels/ChannelWizard'
import { mockChannels } from '@/mock/channels'
import type { ChannelCreateInput } from '@/api/channelService'
import { ingestService } from '@/api/ingestService'

function renderWizard(overrides?: Partial<Parameters<typeof ChannelWizard>[0]>) {
  const onSubmit = vi.fn()
  render(
    <ChannelWizard
      open
      mode="create"
      initial={null}
      onClose={() => {}}
      onSubmit={onSubmit}
      {...overrides}
    />,
  )
  return { onSubmit }
}

describe('ChannelWizard 三步向导', () => {
  it('步骤 1：空名称点下一步被拦截并显示错误', async () => {
    const user = userEvent.setup()
    renderWizard()
    await user.click(screen.getByTestId('wizard-next'))
    expect(screen.getByText('请输入通道名称')).toBeInTheDocument()
    // 仍在步骤 1（推流配置字段未出现）
    expect(screen.queryByTestId('wizard-stream')).not.toBeInTheDocument()
  })

  it('完整流程：填信息→配置流名→选协议→提交参数正确', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderWizard()
    // step 1
    await user.type(screen.getByTestId('wizard-name'), '测试摄像头')
    await user.click(screen.getByTestId('wizard-next'))
    // step 2
    await user.type(screen.getByTestId('wizard-stream'), 'test_cam_01')
    await user.click(screen.getByTestId('wizard-next'))
    // step 3：默认 webrtc+flv+hls+rtmp 已选（webrtc 优先，延迟最低），提交
    await user.click(screen.getByTestId('wizard-submit'))
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    const input = onSubmit.mock.calls[0]![0] as ChannelCreateInput
    expect(input.name).toBe('测试摄像头')
    expect(input.upstream).toEqual({
      protocol: 'rtmp',
      app: 'live',
      stream: 'test_cam_01',
      rtspUrl: undefined,
      rtspTransport: undefined,
      inputUsername: undefined,
      inputPassword: undefined,
      inputEnabled: true,
    })
    expect(input.downstream).toEqual({ protocols: ['webrtc', 'flv', 'hls', 'rtmp'], primary: 'webrtc' })
  })

  it('步骤 2：非法流名被拦截', async () => {
    const user = userEvent.setup()
    renderWizard()
    await user.type(screen.getByTestId('wizard-name'), 'X')
    await user.click(screen.getByTestId('wizard-next'))
    await user.type(screen.getByTestId('wizard-stream'), '非法 流名!')
    await user.click(screen.getByTestId('wizard-next'))
    expect(screen.getByText(/流名只能包含/)).toBeInTheDocument()
  })

  it('步骤 3：全部取消协议后提交报错；primary 联动', async () => {
    const user = userEvent.setup()
    renderWizard()
    await user.type(screen.getByTestId('wizard-name'), 'X')
    await user.click(screen.getByTestId('wizard-next'))
    await user.type(screen.getByTestId('wizard-stream'), 's1')
    await user.click(screen.getByTestId('wizard-next'))
    // 取消默认的 webrtc、flv、hls、rtmp（四者现在都默认勾选）
    await user.click(screen.getByTestId('proto-webrtc'))
    await user.click(screen.getByTestId('proto-flv'))
    await user.click(screen.getByTestId('proto-hls'))
    await user.click(screen.getByTestId('proto-rtmp'))
    await user.click(screen.getByTestId('wizard-submit'))
    expect(screen.getByText('至少启用一个下行协议')).toBeInTheDocument()
    // 只启用 webrtc → primary 自动联动为 webrtc
    await user.click(screen.getByTestId('proto-webrtc'))
    const primary = screen.getByTestId('wizard-primary') as HTMLSelectElement
    expect(primary.value).toBe('webrtc')
  })

  it('does not allow camera pulling before the worker capability arrives', async () => {
    const user = userEvent.setup()
    renderWizard()
    const button = screen.getByRole('button', { name: 'RTSP 摄像头拉流' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(screen.queryByTestId('wizard-rtsp')).toBeNull()
  })

  it('enables RTSP only when ready and submits transport and write-only credentials', async () => {
    const mock = vi.spyOn(ingestService, 'capabilities').mockResolvedValue({
      rtmp: { enabled: true }, rtsp: { enabled: true }, srt: { enabled: false }, webrtc: { enabled: true },
    } as any)
    try {
      const user = userEvent.setup()
      const { onSubmit } = renderWizard()
      const button = screen.getByRole('button', { name: 'RTSP 摄像头拉流' })
      await vi.waitFor(() => expect(button).not.toBeDisabled())
      await user.click(button)
      await user.type(screen.getByTestId('wizard-name'), '相机')
      await user.type(screen.getByTestId('wizard-rtsp'), 'rtsp://camera/live')
      await user.click(screen.getByTestId('wizard-next'))
      await user.type(screen.getByTestId('wizard-stream'), 'camera_rtsp')
      await user.click(screen.getByTestId('wizard-next'))
      await user.click(screen.getByTestId('wizard-submit'))
      expect(onSubmit.mock.calls[0]?.[0].upstream).toMatchObject({ protocol: 'rtsp', rtspTransport: 'tcp', inputEnabled: true })
    } finally { mock.mockRestore() }
  })

  it('编辑模式：回填 initial 值', async () => {
    const user = userEvent.setup()
    const ch = mockChannels[0]!
    renderWizard({ mode: 'edit', initial: ch })
    expect((screen.getByTestId('wizard-name') as HTMLInputElement).value).toBe(ch.name)
    await user.click(screen.getByTestId('wizard-next'))
    expect((screen.getByTestId('wizard-app') as HTMLInputElement).value).toBe('live')
    expect((screen.getByTestId('wizard-stream') as HTMLInputElement).value).toBe('cam_main_door')
    // 进入步骤 3 后按钮文案为"保存修改"
    await user.click(screen.getByTestId('wizard-next'))
    expect(screen.getByRole('button', { name: '保存修改' })).toBeInTheDocument()
  })

  it('编辑模式：没改接入协议时，接入能力查询失败也能保存（如只改名称）', async () => {
    const mock = vi.spyOn(ingestService, 'capabilities').mockRejectedValue(new Error('offline'))
    try {
      const user = userEvent.setup()
      const base = mockChannels[0]!
      const ch = { ...base, upstream: { ...base.upstream, protocol: 'srt' as const } }
      const { onSubmit } = renderWizard({ mode: 'edit', initial: ch })
      await user.type(screen.getByTestId('wizard-name'), '改')
      await user.click(screen.getByTestId('wizard-next'))
      await user.click(screen.getByTestId('wizard-next'))
      await user.click(screen.getByTestId('wizard-submit'))
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
      expect(onSubmit.mock.calls[0]![0].upstream.protocol).toBe('srt')
    } finally { mock.mockRestore() }
  })

})
