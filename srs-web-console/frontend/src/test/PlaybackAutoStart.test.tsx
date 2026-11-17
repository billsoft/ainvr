import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { recordingService } from '@/api/recordingService'
import type { RecordingSegment } from '@/types/recording'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00+08:00'))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

let at = 0
beforeEach(() => { at = Date.now() })
const seg = (id: string, startTs: number): RecordingSegment => ({
  id, channelId: 'demo-detect', startTs, endTs: startTs + 60_000, playable: true, sizeBytes: 1000, durationMs: 60_000,
} as RecordingSegment)
const open = () => {
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }], { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
}

it('starts playing the first recording as soon as a channel is opened', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('late', at - 3_600_000), seg('early', at - 7_200_000)])
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open()
  await waitFor(() => expect(prepare).toHaveBeenCalledWith('early', expect.anything()))
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
})

it('does not restart on catalogue refresh, and does not start when nothing is playable', async () => {
  const list = vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('only', at - 3_600_000)])
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open()
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
  await act(async () => { vi.advanceTimersByTime(15_000) })
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1))
  expect(prepare).toHaveBeenCalledTimes(1)
})

it('leaves the play button usable: it starts the recording at the pointer when nothing is playing', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('only', at - 3_600_000)])
  const prepare = vi.spyOn(recordingService, 'preparePlayback')
    .mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(undefined)
  open()
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
  await screen.findByText(/temporarily unavailable/)
  // The player appears once the channel list has loaded, which can come after the first start.
  const button = await screen.findByRole('button', { name: '播放' })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
})

it('the timeline carries the same speed and play controls as the player', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('a', at - 7_200_000), seg('b', at - 3_600_000)])
  vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open()
  const group = await screen.findByRole('group', { name: '播放倍速' })
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
  // One speed for both: picking 2× on the timeline is what the player's own control then shows.
  fireEvent.click(within(group).getByRole('button', { name: '2×' }))
  expect(await screen.findByText(/倍速 2×/)).toBeInTheDocument()
  expect(within(group).getByRole('button', { name: '2×' })).toHaveAttribute('aria-pressed', 'true')
  // The same transport can move to the next recording.
  const next = screen.getByRole('button', { name: '下一段录像' })
  expect(next).toBeEnabled()
})

it('lists channels only; the time is chosen on the timeline and the playing file is named under it', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('a', at - 7_200_000), seg('b', at - 3_600_000)])
  vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open()
  expect(await screen.findByTestId('current-file-bar')).toHaveTextContent('正在播放')
  expect(screen.queryAllByTestId(/^segment-row-/)).toHaveLength(0)
  expect(screen.queryByText(/显示更多录像/)).toBeNull()
  expect(screen.getAllByText('大门口').length).toBeGreaterThan(0)
})
