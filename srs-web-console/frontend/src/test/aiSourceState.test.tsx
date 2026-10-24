import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { aiPresentationState, sourceAvailability } from '@/features/aiSourceState'
import { AiChannelCard } from '@/pages/AiChannels/AiChannelCard'
import type { AiChannel } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'

const ai = { id: 'a', name: '后门', state: 'error', config: {
  stream: { url: 'rtmp://127.0.0.1:1935/live/8k' }, model: { name: 'yolo26', adapter: 'yolo26_bpu' },
  inference_fps: 10, publish: { enabled: true, effective_target_url: 'rtmp://127.0.0.1/live/8kai' },
}, stats: { last_error: '初始化失败: Open media: Input/output error', inference_fps_actual: 0 } } as AiChannel
const source = { upstream: { app: 'live', stream: '8k' }, status: {
  srsOnline: true, online: false, inputState: 'waiting-source',
} } as ChannelWithStatus

describe('source-aware AI state', () => {
  it('requires a fresh, healthy SRS snapshot for the correct server', () => {
    expect(sourceAvailability(ai, [source], 1000, 2000)).toBe('offline')
    expect(sourceAvailability(ai, [source], 1000, 17000)).toBe('unknown')
    expect(sourceAvailability(ai, [source], 0, 2000)).toBe('unknown')
    expect(sourceAvailability(ai, [], 1000, 2000)).toBe('unknown')
    expect(sourceAvailability(ai, [{ ...source, status: { ...source.status, srsOnline: false } }], 1000, 2000)).toBe('unknown')
    expect(sourceAvailability({ ...ai, config: { ...ai.config, stream: { ...ai.config.stream, url: 'rtmp://other-server/live/8k' } } }, [source], 1000, 2000)).toBe('unknown')
  })
  it('distinguishes connected without video from video flowing', () => {
    expect(sourceAvailability(ai, [{ ...source, status: { ...source.status, inputState: 'waiting-video' } }], 1000, 2000)).toBe('waiting-video')
    expect(sourceAvailability(ai, [{ ...source, status: { ...source.status, online: true } }], 1000, 2000)).toBe('online')
  })
  it('does not hide genuine failures or claim a stopped channel is retrying', () => {
    expect(aiPresentationState(ai, 'offline')).toBe('waiting-source')
    expect(aiPresentationState(ai, 'online')).toBe('error')
    expect(aiPresentationState(ai, 'unknown')).toBe('error')
    expect(aiPresentationState({ ...ai, state: 'starting' }, 'offline')).toBe('waiting-source')
    expect(aiPresentationState({ ...ai, state: 'starting' }, 'online')).toBe('starting')
    for (const error of ['初始化失败: 模型加载失败', '实际 SPS 无效或截断', 'LICENSE_REQUIRED']) {
      expect(aiPresentationState({ ...ai, stats: { ...ai.stats, last_error: error } }, 'offline')).toBe('error')
    }
    expect(aiPresentationState({ ...ai, config: { ...ai.config, manually_stopped: true } }, 'offline')).toBe('idle')
    expect(aiPresentationState({ ...ai, state: 'running' }, 'offline')).toBe('running')
  })
  it('shows an actionable waiting message, retains diagnostics, and recovers on new status', () => {
    const props = { channel: ai, disabled: false, sourceAvailability: 'offline' as const,
      onStart: vi.fn(), onStop: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onViewResult: vi.fn(), onPreview: vi.fn() }
    const { rerender } = render(<AiChannelCard {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent('系统正在自动重试')
    expect(screen.getByText('诊断详情')).toBeInTheDocument()
    expect(screen.queryByTestId('ai-card-last-error')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '播放衍生流' })).toBeDisabled()
    rerender(<AiChannelCard {...props} sourceAvailability="online" />)
    expect(screen.getByTestId('ai-card-last-error')).toHaveTextContent('Open media')
    rerender(<AiChannelCard {...props} channel={{ ...ai, state: 'running' }} sourceAvailability="online" />)
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
