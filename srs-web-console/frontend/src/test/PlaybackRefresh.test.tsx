import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { recordingService } from '@/api/recordingService'
import { DAY_MS, startOfDay } from '@/utils/recording'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
vi.mock('@/pages/Playback/RecordingTimeline', () => ({
  RecordingTimeline: ({ onChangeRange, onSeek, playheadTs }: { onChangeRange: (from: number, to: number) => void; onSeek: (ts: number) => void; playheadTs: number | null }) => (<><output data-testid="cursor">{playheadTs}</output><button onClick={() => onSeek(Date.now() - 3500000)}>seek A</button><button onClick={() => onSeek(Date.now() - 3400000)}>seek B</button>
    <button onClick={() => {
      const from = startOfDay(Date.now() - 30 * DAY_MS)
      onChangeRange(from, from + DAY_MS)
    }}>older recordings</button></>
  ),
}))
// A midnight run may legitimately have no recordings under Today. Freeze the
// fixture clock at midday; this test exercises refresh, not calendar rollover.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00+08:00'))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('queries older-than-14-day recordings and refreshes opened days', async () => {
  const queries = vi.spyOn(recordingService, 'listSegments')
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByText('older recordings'))
  const oldDay = startOfDay(Date.now() - 30 * DAY_MS)
  await waitFor(() => expect(queries).toHaveBeenCalledWith('demo-detect', oldDay, oldDay + DAY_MS, expect.any(AbortSignal)))
  await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument())
  const before = queries.mock.calls.length
  await act(async () => { vi.advanceTimersByTime(15_000) })
  await waitFor(() => expect(queries.mock.calls.length).toBeGreaterThan(before))
})

it('refreshes a cached day even after its tree row is collapsed', async () => {
  const queries = vi.spyOn(recordingService, 'listSegments')
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  await screen.findAllByTestId(/^segment-row-/)
  fireEvent.click(screen.getByRole('button', { name: /^今天/ }))
  const yesterday = screen.queryByRole('button', { name: /^昨天/ })
  if (yesterday) fireEvent.click(yesterday)
  expect(screen.queryAllByTestId(/^segment-row-/)).toHaveLength(0)
  const before = queries.mock.calls.length
  await act(async () => { vi.advanceTimersByTime(5_000) })
  await waitFor(() => expect(queries.mock.calls.length).toBeGreaterThan(before))
})

it('removes a confirmed missing file without starting the video', async () => {
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  const rows = await screen.findAllByTestId(/^segment-row-/)
  const row = rows[0]!
  const testId = row.getAttribute('data-testid')!
  vi.spyOn(recordingService, 'preparePlayback').mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410 }))
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  fireEvent.click(row)
  expect(await screen.findByText(/这段录像已被删除或循环覆盖/)).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByTestId(testId)).not.toBeInTheDocument())
  expect(document.querySelector('video')).toBeNull()
})

it('opens an alarm-linked recording automatically and does not restart on catalogue refresh', async()=>{
 const from=Date.now()-3600000,to=Date.now()-3000000
 const prepare=vi.spyOn(recordingService,'preparePlayback').mockResolvedValue(undefined)
 vi.spyOn(recordingService,'listSegments').mockResolvedValue([{id:'linked-segment',channelId:'demo-detect',startTs:from-1000,endTs:to+1000,playable:true,sizeBytes:1000,durationMs:to-from+2000} as import('@/types/recording').RecordingSegment])
 const router=createMemoryRouter([{path:'/playback/:channelId',element:<PlaybackPage/>}],
  {initialEntries:[`/playback/demo-detect?from=${from}&to=${to}&autoplay=1`]})
 render(<RouterProvider router={router}/> )
 await waitFor(()=>expect(prepare).toHaveBeenCalledTimes(1))
 await act(async()=>{vi.advanceTimersByTime(5000)})
 expect(prepare).toHaveBeenCalledTimes(1)
})
it('recovers media failure once at the selected position and stops retrying on persistent errors', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  const from=Date.now()-3600000,to=Date.now()-3000000
  vi.spyOn(recordingService,'listSegments').mockResolvedValue([{id:'recovery',channelId:'demo-detect',startTs:from-20000,endTs:to+1000,playable:true,sizeBytes:1000,durationMs:to-from+21000} as import('@/types/recording').RecordingSegment])
  const router=createMemoryRouter([{path:'/playback/:channelId',element:<PlaybackPage/>}],
    {initialEntries:[`/playback/demo-detect?from=${from}&to=${to}&autoplay=1`]})
  render(<RouterProvider router={router}/>)
  await waitFor(()=>expect(document.querySelector('video')).not.toBeNull())
  const first=document.querySelector('video')!
  fireEvent.error(first)
  await waitFor(()=>expect(document.querySelector('video')).not.toBe(first))
  expect(prepare).toHaveBeenCalledTimes(2)
  const second=document.querySelector('video')!
  Object.defineProperties(second,{readyState:{configurable:true,value:4},duration:{configurable:true,value:621}})
  fireEvent.loadedMetadata(second)
  expect(second.currentTime).toBe(20)
  fireEvent.error(second)
  await screen.findAllByText(/录像仍无法播放/)
  expect(prepare).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button',{name:'重新加载录像'}))
  await waitFor(()=>expect(prepare).toHaveBeenCalledTimes(3))
})

it('moves the cursor before preflight completes and cancels obsolete selections', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  const from=Date.now()-3600000,to=Date.now()-3000000
  vi.spyOn(recordingService,'listSegments').mockResolvedValue([{id:'pending',channelId:'demo-detect',startTs:from,endTs:to,playable:true,sizeBytes:1000,durationMs:to-from} as import('@/types/recording').RecordingSegment])
  const resolves: (() => void)[] = []
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockImplementation(() => new Promise<void>(resolve => resolves.push(resolve)))
  const router=createMemoryRouter([{path:'/playback/:channelId',element:<PlaybackPage/>}], {initialEntries:[`/playback/demo-detect?from=${from}&to=${to}`]})
  render(<RouterProvider router={router}/>)
  await screen.findByTestId('segment-row-pending')
  fireEvent.click(screen.getByText('seek A'))
  expect(screen.getByTestId('cursor')).toHaveTextContent(String(Date.now()-3500000))
  expect(screen.getByTestId('recording-player-seek-veil')).toHaveTextContent('正在加载')
  fireEvent.click(screen.getByText('seek B'))
  expect(prepare.mock.calls[0]![1]!.aborted).toBe(true)
  await act(async () => { resolves[0]!() })
  expect(document.querySelector('video')).toBeNull()
  expect(screen.getByTestId('cursor')).toHaveTextContent(String(Date.now()-3400000))
  await act(async () => { resolves[1]!() })
  expect(document.querySelector('video')).not.toBeNull()
  fireEvent.click(screen.getByText('seek A'))
  expect(prepare).toHaveBeenCalledTimes(2)
})
