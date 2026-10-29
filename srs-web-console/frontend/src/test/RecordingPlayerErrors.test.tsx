import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RecordingPlayer } from '@/pages/Playback/RecordingPlayer'
import type { RecordingSegment } from '@/types/recording'

vi.mock('@/pages/Playback/RecordingDetectionOverlay', () => ({ RecordingDetectionOverlay: () => <canvas /> }))
const segment: RecordingSegment = { id: 'segment-a', channelId: 'output-a', startTs: 100000, endTs: 166666,
  durationMs: 66666, sizeBytes: 1, codec: 'h264', width: 1920, height: 1080, hasAudio: false,
  seiPresent: true, storage: 'local' as never, playable: true }
let now = 0
beforeEach(() => {
  now = 0; vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function prepare(offsetMs = 20000) {
  const onError = vi.fn(), onTimeUpdate = vi.fn()
  const props = { channelName: 'AI output', segment, offsetMs, playUrl: '/a.mp4', downloadUrl: null, onError, onTimeUpdate }
  const view = render(<RecordingPlayer {...props} />)
  const video = view.container.querySelector('video')!
  Object.defineProperties(video, { readyState: { configurable: true, value: 4 }, duration: { configurable: true, value: 66.666 },
    seeking: { configurable: true, value: false }, error: { configurable: true, value: null } })
  fireEvent.loadedMetadata(video)
  return { ...view, video, onError, onTimeUpdate, props }
}
it.each(['timeUpdate', 'seeked'] as const)('accepts decoded forward progress when %s is delivered after the exact seek instant', event => {
  const { video, onError, onTimeUpdate } = prepare()
  expect(video.currentTime).toBe(20)
  now = 4000; video.currentTime = 23.7588
  fireEvent[event](video)
  expect(screen.queryByTestId('recording-player-seek-veil')).not.toBeInTheDocument()
  expect(onTimeUpdate).toHaveBeenLastCalledWith(123758.8)
  act(() => { vi.advanceTimersByTime(15000) })
  expect(screen.queryByText('录像加载失败')).not.toBeInTheDocument()
  expect(onError).not.toHaveBeenCalled()
})
it.each(['AbortError', 'NotAllowedError'])('does not call a recoverable %s play rejection a corrupt or missing recording', async name => {
  const { video, onError } = prepare(0); fireEvent.seeked(video)
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('play interrupted', name))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '播放' })) })
  expect(screen.queryByText('录像加载失败')).not.toBeInTheDocument()
  expect(onError).not.toHaveBeenCalled()
})
it('retains real media errors even when a play promise says AbortError', async () => {
  const { video, onError } = prepare(0); fireEvent.seeked(video)
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } })
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('interrupted', 'AbortError'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '播放' })) })
  expect(screen.getByText('录像加载失败')).toBeInTheDocument(); expect(onError).toHaveBeenCalled()
})
it('retains native decode errors and genuine unresolved positioning timeouts', () => {
  const { video, onError } = prepare()
  Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
  video.currentTime = 0; now = 15000
  act(() => { vi.advanceTimersByTime(15000) })
  expect(screen.getByText('录像加载失败')).toBeInTheDocument(); expect(onError).toHaveBeenCalledTimes(1)
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } })
  fireEvent.error(video); expect(onError).toHaveBeenCalledTimes(2)
})
it('does not accept an arbitrary jump far beyond the requested target as a landed seek', () => {
  const { video, onError } = prepare(); now = 1000; video.currentTime = 50
  fireEvent.timeUpdate(video)
  expect(screen.getByTestId('recording-player-seek-veil')).toBeInTheDocument()
  now = 15000; act(() => { vi.advanceTimersByTime(15000) })
  expect(screen.getByText('录像加载失败')).toBeInTheDocument(); expect(onError).toHaveBeenCalledTimes(1)
})
it('ignores an old source play rejection after another source is mounted', async () => {
  const { video, rerender, props, onError } = prepare(0); fireEvent.seeked(video)
  let reject!: (reason: unknown) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  fireEvent.click(screen.getByRole('button', { name: '播放' }))
  rerender(<RecordingPlayer {...props} segment={{ ...segment, id: 'segment-b' }} playUrl="/b.mp4" />)
  await act(async () => { reject(new DOMException('old request', 'NotSupportedError')) })
  expect(screen.queryByText('录像加载失败')).not.toBeInTheDocument(); expect(onError).not.toHaveBeenCalled()
})
it('ignores an old seek play rejection after a newer seek on the same source', async () => {
  const { video, rerender, props, onError } = prepare(0); fireEvent.seeked(video)
  let reject!: (reason: unknown) => void
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  fireEvent.click(screen.getByRole('button', { name: '播放' }))
  rerender(<RecordingPlayer {...props} offsetMs={30000} seekVersion={2} />)
  await act(async () => { reject(new DOMException('old seek', 'NotSupportedError')) })
  expect(screen.queryByText('录像加载失败')).not.toBeInTheDocument(); expect(onError).not.toHaveBeenCalled()
})
it('never uses elapsed time as proof when assigning the requested seek did not succeed', () => {
  const { video, onError } = prepare()
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 23.7588, set: () => undefined })
  fireEvent.canPlay(video)
  now = 4000; fireEvent.timeUpdate(video)
  expect(screen.getByTestId('recording-player-seek-veil')).toBeInTheDocument()
  now = 15000; act(() => { vi.advanceTimersByTime(15000) })
  expect(screen.getByText('录像加载失败')).toBeInTheDocument(); expect(onError).toHaveBeenCalledTimes(1)
})
it('does not let an earlier seek event publish time for a newer seek token', () => {
  const { video, rerender, props, onTimeUpdate } = prepare()
  rerender(<RecordingPlayer {...props} offsetMs={30000} seekVersion={2} />)
  now = 4000; video.currentTime = 23.7588; fireEvent.timeUpdate(video)
  expect(screen.getByTestId('recording-player-seek-veil')).toBeInTheDocument(); expect(onTimeUpdate).not.toHaveBeenCalled()
  video.currentTime = 30.2; fireEvent.seeked(video)
  expect(screen.queryByTestId('recording-player-seek-veil')).not.toBeInTheDocument()
  expect(onTimeUpdate).toHaveBeenLastCalledWith(130200)
})
