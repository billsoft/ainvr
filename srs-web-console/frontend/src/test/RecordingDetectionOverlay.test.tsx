import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RecordingDetectionOverlay } from '@/pages/Playback/RecordingDetectionOverlay'
import { drawDetections } from '@/components/player/detectionDrawing'

vi.mock('@/components/player/detectionDrawing', () => ({ drawDetections: vi.fn() }))
let paint: FrameRequestCallback
let display: VideoFrameRequestCallback
let video: HTMLVideoElement
let ref: { current: HTMLVideoElement }
const payload = { frames: [{ timeMs: 1000, payload: { v: 1, det: [{ b: [1, 2, 3, 4], n: 'face' }] } }] }

beforeEach(() => {
  video = document.createElement('video')
  video.currentTime = 1
  ref = { current: video }
  Object.defineProperties(video, {
    videoWidth: { value: 100 }, videoHeight: { value: 100 },
    readyState: { value: 4 }, seeking: { value: false, configurable: true },
  })
  video.requestVideoFrameCallback = vi.fn(cb => { display = cb; return 1 })
  video.cancelVideoFrameCallback = vi.fn()
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 100 } as DOMRect)
  vi.stubGlobal('requestAnimationFrame', vi.fn(cb => { paint = cb; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })))
  vi.mocked(drawDetections).mockClear()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem('srs-console-token') })

it('uses the shared authenticated request client', async () => {
  localStorage.setItem('srs-console-token', 'test-token')
  render(<RecordingDetectionOverlay videoRef={ref} segmentId="a" currentTime={1} />)
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Console-Token': 'test-token' })
})

it('draws against presented media time, retains a paused frame, clears during seek', async () => {
  render(<RecordingDetectionOverlay videoRef={ref} segmentId="a" currentTime={1} />)
  await waitFor(() => expect(screen.queryByText('识别框加载中…')).toBeNull())
  act(() => { display(0, { mediaTime: 1 } as VideoFrameCallbackMetadata); paint(0) })
  expect(vi.mocked(drawDetections).mock.lastCall?.[1]).toHaveLength(1)
  act(() => { paint(60000) })
  expect(vi.mocked(drawDetections).mock.lastCall?.[1]).toHaveLength(1)
  Object.defineProperty(video, 'seeking', { value: true })
  vi.mocked(drawDetections).mockClear()
  act(() => { paint(61000) })
  expect(drawDetections).not.toHaveBeenCalled()
})

it('switch disables metadata requests and canvas drawing', async () => {
  const view = render(<RecordingDetectionOverlay videoRef={ref} segmentId="a" currentTime={1} />)
  await waitFor(() => expect(screen.queryByText('识别框加载中…')).toBeNull())
  view.rerender(<RecordingDetectionOverlay videoRef={ref} segmentId="a" currentTime={20} enabled={false} />)
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.mocked(drawDetections).mockClear()
  act(() => { paint(0) })
  expect(drawDetections).not.toHaveBeenCalled()
})

it('failed metadata request exposes retry without interrupting video', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('timeout'))
  render(<RecordingDetectionOverlay videoRef={ref} segmentId="a" currentTime={1} />)
  const retry = await screen.findByRole('button', { name: '识别框读取失败，重试' })
  fireEvent.click(retry)
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByText('识别框读取失败，重试')).toBeNull())
})
