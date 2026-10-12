import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { configService } from '@/api/configService'
import { ChannelScheduleDialog } from '@/pages/Playback/ChannelScheduleDialog'
import type { RecorderChannel } from '@/types/recording'

vi.mock('@/api/configService', () => ({ configService: {
  listDocuments: vi.fn(async () => [{ name: 'settings', updatedAt: '2026-10-07T01:00:00.000Z', config: {
    channelSchedules: { c: { enabled: true, hours: [] } },
  } }]),
  getApplyOperation: vi.fn(async () => null),
  applyChanges: vi.fn(async () => ({ id: '1', status: 'succeeded', stage: '已生效', deadline: Date.now() + 1000 })),
} }))

describe('schedule drafts', () => {
  it('loads unpublished empty schedule and preserves edits across channel refresh', async () => {
    const channel = { id: 'c', name: 'camera', recording: true, scheduleHours: [0, 1] } as RecorderChannel
    const props = { open: true, channels: [channel], onClose: vi.fn(), onSaved: vi.fn() }
    const { rerender } = render(<ChannelScheduleDialog {...props} />)
    await waitFor(() => expect(screen.getByTestId('schedule-save')).not.toBeDisabled())
    expect(screen.getByTestId('hour-c-0')).toHaveAttribute('data-on', 'false')
    fireEvent.click(screen.getByTestId('hour-c-0'))
    rerender(<ChannelScheduleDialog {...props} channels={[{ ...channel }]} />)
    expect(screen.getByTestId('hour-c-0')).toHaveAttribute('data-on', 'true')
    fireEvent.click(screen.getByTestId('schedule-save'))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(configService.applyChanges).toHaveBeenCalledWith([expect.objectContaining({ expectedUpdatedAt: '2026-10-07T01:00:00.000Z' })])
  })
})

describe('编码与 H.265 状态（设计 §8.4④）', () => {
  it('H.265 通道带编码徽标；缺组件/无 IDR 时在行内说明原因', async () => {
    const channels = [
      { id: 'a', name: '停车场', recording: false, recordingState: 'codec_error', codec: 'h265',
        recordingDetail: '缺少 H.265 录像组件 FFmpeg 8.1.2，请在板上执行 sudo ./install.sh --only python 补装' },
      { id: 'b', name: '后门', recording: true, recordingState: 'recording', codec: 'h265', codecWarning: 'no_idr',
        recordingDetail: 'H.265 源已 15 秒没有 IDR 关键帧' },
      { id: 'c', name: '大门', recording: true, recordingState: 'recording', codec: 'h264' },
    ] as RecorderChannel[]
    render(<ChannelScheduleDialog open channels={channels} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByTestId('schedule-codec-a')).toHaveTextContent('H.265')
    expect(screen.queryByTestId('schedule-codec-c')).toBeNull()
    expect(screen.getByTestId('schedule-codec-warning-a')).toHaveTextContent('--only python')
    expect(screen.getByTestId('schedule-codec-warning-b')).toHaveTextContent('没有 IDR')
    expect(screen.queryByTestId('schedule-codec-warning-c')).toBeNull()
  })
})
