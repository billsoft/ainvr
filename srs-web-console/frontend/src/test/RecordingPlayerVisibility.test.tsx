import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})

/** jsdom 不实现真实播放：play/pause 只做状态翻转并派发对应事件 */
function mockMediaControls() {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
  play.mockImplementation(function (this: HTMLVideoElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  pause.mockImplementation(function (this: HTMLVideoElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  })
  return { play, pause }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function renderAndPlayFirstSegment() {
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  const row = (await screen.findAllByTestId(/^segment-row-/))[0]!
  fireEvent.click(row)
  const video = await screen.findByTestId('recording-player')
  const v = video.querySelector('video') as HTMLVideoElement
  Object.defineProperty(v, 'readyState', { configurable: true, value: 4 })
  await act(async () => {
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('canplay'))
  })
  return v
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => { vi.restoreAllMocks() })

it('页面切到后台时主动暂停并保留指针，回前台自动续播', async () => {
  const { play, pause } = mockMediaControls()
  const v = await renderAndPlayFirstSegment()
  await waitFor(() => expect(play).toHaveBeenCalled())
  expect(screen.getAllByTestId('timeline-playhead').length).toBeGreaterThan(0)
  const playCallsAfterStart = play.mock.calls.length

  await act(async () => { setVisibility('hidden') })
  expect(pause.mock.calls.length).toBeGreaterThan(0)
  expect(screen.getByTestId('recording-player-hide-paused')).toBeInTheDocument()
  // 暂停期间时间轴指针不消失
  expect(screen.getAllByTestId('timeline-playhead').length).toBeGreaterThan(0)

  await act(async () => { setVisibility('visible') })
  expect(play.mock.calls.length).toBeGreaterThan(playCallsAfterStart)
  await waitFor(() => expect(screen.queryByTestId('recording-player-hide-paused')).toBeNull())
  expect(v.paused).toBe(false)
  expect(screen.queryByText('录像加载失败')).toBeNull()
})

it('人工暂停后切后台再回来不自动续播，且不显示后台暂停提示', async () => {
  const { play } = mockMediaControls()
  await renderAndPlayFirstSegment()
  await waitFor(() => expect(play).toHaveBeenCalled())

  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  expect(screen.queryByTestId('recording-player-hide-paused')).toBeNull()
  const playCallsAfterManualPause = play.mock.calls.length

  await act(async () => { setVisibility('hidden') })
  await act(async () => { setVisibility('visible') })
  expect(play.mock.calls.length).toBe(playCallsAfterManualPause)
  expect(screen.queryByTestId('recording-player-hide-paused')).toBeNull()
})

it('回前台自动起播被浏览器拒绝时不报错，给出可点击的继续播放入口', async () => {
  const { play } = mockMediaControls()
  await renderAndPlayFirstSegment()
  await waitFor(() => expect(play).toHaveBeenCalled())

  await act(async () => { setVisibility('hidden') })
  expect(screen.getByTestId('recording-player-hide-paused')).toBeInTheDocument()
  play.mockImplementationOnce(function (this: HTMLVideoElement) {
    return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
  })

  await act(async () => { setVisibility('visible') })
  // 拒绝自动播放不允许升级成"录像加载失败"
  expect(screen.queryByText('录像加载失败')).toBeNull()
  const resume = screen.getByRole('button', { name: /继续播放/ })
  expect(resume).toBeInTheDocument()

  // 用户点一下即可恢复（此时 play mock 已恢复为 resolve 实现）
  await act(async () => { fireEvent.click(resume) })
  await waitFor(() => expect(screen.queryByTestId('recording-player-hide-paused')).toBeNull())
})
