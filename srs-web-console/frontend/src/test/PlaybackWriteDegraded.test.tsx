import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { RecordingTimeline } from '@/pages/Playback/RecordingTimeline'
import { recordingService } from '@/api/recordingService'
import { recordingBadge } from '@/pages/Channels/recordingBadge'
import type { RecorderChannel } from '@/types/recording'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
afterEach(() => { vi.restoreAllMocks() })

// 存储写得慢 → 录像服务按完整画面组丢弃继续录；界面必须在人本来会看的位置明确告警。

it('storage card warns when writes cannot keep up and the timeline marks dropped ranges', async () => {
  const stats = recordingService.stats.bind(recordingService)
  vi.spyOn(recordingService, 'stats').mockImplementation(async () => ({
    ...(await stats()), writeDegradedChannels: 1, droppedMsLastHour: 95_000,
  }))
  const now = Date.now()
  vi.spyOn(recordingService, 'listDrops').mockResolvedValue([
    { startTs: now - 20 * 60_000, endTs: now - 19 * 60_000, droppedMs: 60_000, reason: 'backlog' },
  ])
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <PlaybackPage /> }],
    { initialEntries: ['/playback/demo-detect'] })
  render(<RouterProvider router={router} />)
  const warning = await screen.findByTestId('storage-write-warning')
  expect(warning).toHaveTextContent('录像缺口')
  expect(warning).toHaveTextContent('95 秒')
  expect(warning.getAttribute('title')).toContain('可能来自写入积压或停止录制')
  const mark = await screen.findByTestId('timeline-drop-mark')
  expect(mark).not.toHaveClass('pointer-events-none')
  expect(mark.getAttribute('title')).toMatch(/写入积压丢弃 60 秒/)
  expect(within(screen.getByTestId('recording-timeline')).getByText(/琥珀：未保存录像/)).toBeInTheDocument()
})

it('no warning and no legend entry when nothing was dropped', async () => {
  render(<RecordingTimeline win={{ from: 0, to: 3_600_000 }} segments={[]} playheadTs={null}
    onSeek={() => {}} onChangeRange={() => {}} />)
  expect(screen.queryByTestId('timeline-drop-mark')).toBeNull()
  expect(screen.queryByText(/琥珀/)).toBeNull()
})

it('channel badge shows recording-with-drops as a warning, stalled as a storage fault', () => {
  const base = { id: 'c', name: 'c', kind: 'source', recording: true, recordingState: 'recording',
    sourceOnline: true, codec: 'h264', scheduleEnabled: true } as RecorderChannel
  const degraded = recordingBadge({ ...base, writeState: 'degraded', recordingDetail: '近 1 小时丢弃约 95 秒' }, false)
  expect(degraded).toMatchObject({ label: '录像中 · 近1小时有缺口', tone: 'warning', detail: '近 1 小时丢弃约 95 秒' })
  expect(recordingBadge({ ...base, writeState: 'degraded', writeBacklogActive: true }, false))
    .toMatchObject({ label: '录像中 · 写入积压', tone: 'warning' })
  expect(recordingBadge({ ...base, writeState: 'ok' }, false)).toMatchObject({ label: '录像中', tone: 'success' })
  expect(recordingBadge({ ...base, recording: false, recordingState: 'storage_error' }, false))
    .toMatchObject({ label: '存储异常', tone: 'danger' })
  expect(recordingBadge(undefined, true)).toMatchObject({ label: '状态未知' })
})

it('H.265：缺读端组件是故障、无 IDR/开放 GOP 是警告，徽标带录像服务给出的说明', () => {
  const base = { id: 'c', name: 'c', kind: 'source', recording: true, recordingState: 'recording',
    sourceOnline: true, codec: 'h265', scheduleEnabled: true } as RecorderChannel
  expect(recordingBadge({ ...base, recording: false, recordingState: 'codec_error', recordingDetail: '缺少 H.265 录像组件 FFmpeg 8.1.2' }, false))
    .toMatchObject({ label: '缺少 H.265 组件', tone: 'danger', detail: '缺少 H.265 录像组件 FFmpeg 8.1.2' })
  expect(recordingBadge({ ...base, codecWarning: 'no_idr', recordingDetail: '已 15 秒没有 IDR' }, false))
    .toMatchObject({ label: '录像中 · 源无关键帧', tone: 'warning', detail: '已 15 秒没有 IDR' })
  expect(recordingBadge({ ...base, codecWarning: 'open_gop' }, false))
    .toMatchObject({ label: '录像中 · 开放 GOP', tone: 'warning' })
})
