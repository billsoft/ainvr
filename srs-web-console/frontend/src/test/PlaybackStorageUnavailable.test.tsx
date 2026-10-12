import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { recordingService } from '@/api/recordingService'
import type { RecordingSegment } from '@/types/recording'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
afterEach(() => { vi.restoreAllMocks() })

// 存储读不到时，列表不能是一排点不动、也不说原因的灰色条目
// （2026-09-24 NAS 故障时用户误以为"有录像却看不了"）。
function segmentsWhere(playable: (index: number) => boolean) {
  const list = recordingService.listSegments.bind(recordingService)
  vi.spyOn(recordingService, 'listSegments').mockImplementation(async (...args) =>
    (await list(...args)).map((s: RecordingSegment, i: number) => ({ ...s, playable: playable(i) })))
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
}

it('replaces the list with an explanation when no segment is readable', async () => {
  vi.spyOn(recordingService, 'health').mockResolvedValue({
    ok: true, version: 'x', storageHealthy: false, storageKind: 'smb',
    message: 'NAS 自动恢复失败（第 3 次）：挂载超时；240s 后重试',
  })
  segmentsWhere(() => false)
  renderPage()
  const panel = await screen.findByTestId('storage-unavailable-panel')
  expect(panel).toHaveTextContent('录像暂时无法播放')
  expect(panel).toHaveTextContent('NAS 自动恢复失败（第 3 次）')
  expect(panel).toHaveTextContent(/段录像仍保存在存储上/)
  expect(screen.queryAllByTestId(/^segment-row-/)).toHaveLength(0)
})

it('keeps readable segments and explains the greyed-out ones', async () => {
  segmentsWhere(i => i % 2 === 0)
  renderPage()
  const note = await screen.findByTestId('unplayable-segments-note')
  expect(note).toHaveTextContent(/段录像所在存储暂时无法访问/)
  expect(screen.queryByTestId('storage-unavailable-panel')).toBeNull()
  expect((await screen.findAllByTestId(/^segment-row-/)).length).toBeGreaterThan(0)
})

it('shows neither panel nor note when every segment is playable', async () => {
  renderPage()
  await screen.findAllByTestId(/^segment-row-/)
  await waitFor(() => expect(screen.queryByText('正在加载录像…')).toBeNull())
  expect(screen.queryByTestId('storage-unavailable-panel')).toBeNull()
  expect(screen.queryByTestId('unplayable-segments-note')).toBeNull()
})
