import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { RecordingPlayer } from '@/pages/Playback/RecordingPlayer'
import type { RecordingSegment } from '@/types/recording'
vi.mock('@/pages/Playback/RecordingDetectionOverlay', () => ({
  RecordingDetectionOverlay: () => <canvas data-testid="overlay" />,
}))
it('switching SEI recordings keeps exactly one current video and overlay', () => {
  const segment = (id: string): RecordingSegment => ({
    id, channelId: 'c', startTs: 0, endTs: 60000, durationMs: 60000,
    sizeBytes: 1, codec: 'h264', width: 3840, height: 1920,
    hasAudio: false, seiPresent: true, storage: 'local' as never, playable: true,
  })
  const props = { channelName: 'AI', offsetMs: 0, downloadUrl: '/download' }
  const view = render(<RecordingPlayer {...props} segment={segment('a')} playUrl="/a.mp4" />)
  for (const id of ['b', 'c', 'a', 'd']) {
    view.rerender(<RecordingPlayer {...props} segment={segment(id)} playUrl={`/${id}.mp4`} />)
    expect(view.container.querySelectorAll('video')).toHaveLength(1)
    expect(view.container.querySelector('video')).toHaveAttribute('src', `/${id}.mp4`)
    expect(view.container.querySelectorAll('[data-testid="overlay"]')).toHaveLength(1)
  }
})
