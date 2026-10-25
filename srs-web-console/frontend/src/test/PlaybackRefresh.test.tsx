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
  RecordingTimeline: ({ onChangeRange }: { onChangeRange: (from: number, to: number) => void }) => (
    <button onClick={() => {
      const from = startOfDay(Date.now() - 30 * DAY_MS)
      onChangeRange(from, from + DAY_MS)
    }}>older recordings</button>
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
