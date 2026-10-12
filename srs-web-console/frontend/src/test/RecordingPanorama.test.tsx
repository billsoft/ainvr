import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { RecordingPlayer } from '@/pages/Playback/RecordingPlayer'
import type { RecordingSegment } from '@/types/recording'

vi.mock('@/components/player/PanoramaView', () => ({
  PanoramaView: ({ video, resetToken, onError }: { video: HTMLVideoElement; resetToken: number; onError: (s: string) => void }) =>
    <button data-testid="pano" data-src={video.getAttribute('src')} data-reset={resetToken} onClick={() => onError('全景不可用')}>模拟故障</button>,
}))
vi.mock('@/pages/Playback/RecordingDetectionOverlay', () => ({
  RecordingDetectionOverlay: ({ drawFrame }: { drawFrame?: unknown }) => <canvas data-testid="overlay" data-panorama={!!drawFrame} />,
}))
const segment = (id: string): RecordingSegment => ({ id, channelId: 'c', startTs: 0, endTs: 60000, durationMs: 60000,
  sizeBytes: 1, codec: 'h264', width: 3840, height: 1920, hasAudio: false, seiPresent: true, storage: 'local' as never, playable: true })
const props = { channelName: 'AI', offsetMs: 0, downloadUrl: '/download' }

it('reuses decoded video, preserves time and speed, resets view and follows segment replacements', () => {
  const view = render(<RecordingPlayer {...props} segment={segment('a')} playUrl="/a.mp4" />)
  const video = view.container.querySelector('video')!
  video.currentTime = 12
  fireEvent.click(screen.getByRole('button', { name: '倍速 1×' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: '2×' }))
  fireEvent.click(screen.getByRole('button', { name: '开启360°观看' }))
  expect(view.container.querySelector('video')).toBe(video)
  expect(video.currentTime).toBe(12)
  expect(video.playbackRate).toBe(2)
  expect(screen.getByTestId('overlay')).toHaveAttribute('data-panorama', 'true')
  fireEvent.click(screen.getByRole('button', { name: '重置视角' }))
  expect(screen.getByTestId('pano')).toHaveAttribute('data-reset', '1')
  view.rerender(<RecordingPlayer {...props} segment={segment('b')} playUrl="/b.mp4" />)
  expect(screen.getByTestId('pano')).toHaveAttribute('data-src', '/b.mp4')
  expect(view.container.querySelectorAll('video')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('pano'))
  expect(screen.queryByTestId('pano')).toBeNull()
  expect(screen.getByText('全景不可用')).toBeInTheDocument()
  expect(screen.getByTestId('overlay')).toHaveAttribute('data-panorama', 'false')
})

it('toggles fullscreen in either view and synchronizes browser exit', async () => {
  let active: Element | null = null
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active })
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: function(this: HTMLElement) {
    active = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve()
  } })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: () => {
    active = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve()
  } })
  try {
    render(<RecordingPlayer {...props} segment={segment('a')} playUrl="/a.mp4" />)
    for (const label of ['开启360°观看', '关闭360°观看']) {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏' })))
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(active).toBe(screen.getByTestId('recording-player'))
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '退出全屏' })))
      expect(active).toBeNull()
    }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏' })))
    act(() => { active = null; document.dispatchEvent(new Event('fullscreenchange')) })
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument()
  } finally {
    Reflect.deleteProperty(document, 'fullscreenElement')
    Reflect.deleteProperty(document, 'exitFullscreen')
    Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen')
  }
})
