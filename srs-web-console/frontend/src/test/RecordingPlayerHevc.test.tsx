import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordingPlayer } from '@/pages/Playback/RecordingPlayer'
import { getCodecSupport, type CodecSupport } from '@/utils/codec'
import type { RecordingSegment } from '@/types/recording'

// 回放前判定本机能否播放 H.265 分段（设计 §8.4④）：不能就明确说明并保留下载，
// 不让 <video> 黑屏或只报笼统的"加载失败"。
vi.mock('@/utils/codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/codec')>()
  return { ...actual, getCodecSupport: vi.fn(actual.getCodecSupport) }
})

const none: CodecSupport = {
  webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0,
  encodedTransform: null, videoFrameCallback: false,
}

function seg(codec: 'h264' | 'h265', width = 3840, height = 2160): RecordingSegment {
  return {
    id: 's1', channelId: 'c', startTs: 0, endTs: 60_000, durationMs: 60_000, sizeBytes: 1,
    codec, width, height, hasAudio: false, seiPresent: false, storage: 'local' as never, playable: true,
  }
}

const props = { channelName: '大门', offsetMs: 0, playUrl: '/p.mp4', downloadUrl: '/d.mp4' }

describe('RecordingPlayer H.265 能力判定', () => {
  afterEach(() => vi.mocked(getCodecSupport).mockReset())

  it('本机不能播 H.265 → 说明原因 + 下载入口，不挂 <video>', () => {
    vi.mocked(getCodecSupport).mockReturnValue(none)
    render(<RecordingPlayer {...props} segment={seg('h265')} />)
    expect(screen.getByTestId('recording-codec-unsupported')).toHaveTextContent('无法播放 H.265 录像')
    expect(screen.getByRole('link', { name: /下载此段/ })).toHaveAttribute('href', '/d.mp4')
    expect(screen.getByTestId('recording-player').querySelector('video')).toBeNull()
  })

  it('档位不够（设备到 L4.1，4K 分段需要 L5）同样拦下', () => {
    vi.mocked(getCodecSupport).mockReturnValue({ ...none, fileHevcMaxLevel: 123 })
    render(<RecordingPlayer {...props} segment={seg('h265')} />)
    expect(screen.getByTestId('recording-codec-unsupported')).toBeInTheDocument()
  })

  it('能播 → 正常挂 <video>；H.264 永不拦', () => {
    vi.mocked(getCodecSupport).mockReturnValue({ ...none, fileHevcMaxLevel: 153 })
    const { unmount } = render(<RecordingPlayer {...props} segment={seg('h265')} />)
    expect(screen.getByTestId('recording-player').querySelector('video')).not.toBeNull()
    unmount()
    vi.mocked(getCodecSupport).mockReturnValue(none)
    render(<RecordingPlayer {...props} segment={seg('h264')} />)
    expect(screen.getByTestId('recording-player').querySelector('video')).not.toBeNull()
  })
})
