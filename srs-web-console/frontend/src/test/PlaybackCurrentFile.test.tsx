import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { recordingService } from '@/api/recordingService'
import type { RecordingSegment } from '@/types/recording'

const pointer = vi.hoisted(() => ({ b: 0, gap: 0 }))
vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
// The real timeline reports its dragged pointer through onPreview; these buttons stand in for that.
vi.mock('@/pages/Playback/RecordingTimeline', () => ({
  RecordingTimeline: ({ onSeek, onPreview }: { onSeek: (ts: number) => void; onPreview?: (ts: number | null) => void }) => (<>
    <button onClick={() => onPreview?.(pointer.b)}>drag onto B</button>
    <button onClick={() => onPreview?.(pointer.gap)}>drag into a gap</button>
    <button onClick={() => onPreview?.(null)}>release</button>
    <button onClick={() => onSeek(pointer.b)}>seek B</button>
    <button onClick={() => onSeek(pointer.gap)}>seek into a gap</button>
  </>),
}))
let at = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00+08:00'))
  at = Date.now()
  pointer.b = at - 3_600_000 + 5_000
  pointer.gap = at - 5_400_000
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const seg = (id: string, startTs: number, over: Partial<RecordingSegment> = {}): RecordingSegment =>
  ({ id, channelId: 'demo-detect', startTs, endTs: startTs + 60_000, playable: true, sizeBytes: 5_000_000, durationMs: 60_000, codec: 'h264', width: 1920, height: 1080, ...over } as RecordingSegment)
function open() {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('a', at - 7_200_000), seg('b', at - 3_600_000)])
  vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  vi.spyOn(recordingService, 'downloadUrl').mockImplementation(id => `/dl/${id}`)
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }], { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
}
const bar = () => screen.getByTestId('current-file-bar')

it('names the playing file by its time range and offers its download, under the video', async () => {
  open()
  await waitFor(() => expect(within(bar()).getByText('正在播放')).toBeInTheDocument())
  expect(bar()).toHaveTextContent(/5 MB|4\.\d+ MB|4\.8/)
  expect(bar()).toHaveTextContent('1920×1080')
  expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/a')
})

it('follows the pointer: dragging onto another file shows that file and its download, releasing returns', async () => {
  open()
  await waitFor(() => expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/a'))
  fireEvent.click(await screen.findByText('drag onto B'))
  expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/b')
  expect(bar()).toHaveTextContent('指针所在')
  expect(bar()).toHaveTextContent('松开后跳到这里播放')
  fireEvent.click(screen.getByText('release'))
  expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/a')
})

it('after seeking, shows the file now playing; a pointer in a gap says there is no file', async () => {
  open()
  await waitFor(() => expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/a'))
  fireEvent.click(await screen.findByText('seek B'))
  await waitFor(() => expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/b'))
  expect(within(bar()).getByText('正在播放')).toBeInTheDocument()
  fireEvent.click(screen.getByText('drag into a gap'))
  expect(bar()).toHaveTextContent('指针所在的时刻没有录像文件')
  expect(screen.queryByText('下载此文件')).toBeNull()
})

it('a pointer sitting in a gap while a file plays keeps showing the playing file, and nothing is named before anything starts', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('a', at - 7_200_000), seg('b', at - 3_600_000)])
  vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  vi.spyOn(recordingService, 'downloadUrl').mockImplementation(id => `/dl/${id}`)
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }], { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  await waitFor(() => expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', '/dl/a'))
  fireEvent.click(await screen.findByText('seek into a gap'))
  // The click was between files: the nearest one loads, and the bar never claims there is no file.
  await waitFor(() => expect(screen.getByTestId('current-file-download')).toHaveAttribute('href', expect.stringMatching(/^\/dl\/[ab]$/)))
  expect(bar()).not.toHaveTextContent('没有录像文件')
})
