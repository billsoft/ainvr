import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiPreviewModal } from '@/pages/AiChannels/AiPreviewModal'

// AI 输出预览：H.265 在不能 WebRTC 的设备上需要 HLS 兜底（设计 §8.3），
// 以前写死 ['webrtc','flv'] 会直接判"无法播放"。
const seen: Array<{ protocols: string[]; videoInfo?: { codec?: string | null } }> = []
vi.mock('@/components/player/VideoPlayer', () => ({
  VideoPlayer: (p: { protocols: string[]; videoInfo?: { codec?: string | null } }) => {
    seen.push(p)
    return null
  },
}))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { listStreams: vi.fn(async () => []) } }))

describe('AiPreviewModal', () => {
  it('协议含 hls，并把 AI 输出编码交给播放器', () => {
    render(<AiPreviewModal channelId="a" channelName="n" effectiveTargetUrl="rtmp://h/live/x_out"
      videoCodec="h265" onClose={() => {}} />)
    const last = seen[seen.length - 1]!
    expect(last.protocols).toContain('hls')
    expect(last.videoInfo?.codec).toBe('h265')
  })
})
