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

describe('版式：内容多时只在中间滚动', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    id: `ch${i}`, name: `通道 ${i}`, recording: i === 0, scheduleEnabled: i === 0, scheduleHours: i === 0 ? [0, 1] : [], sourceOnline: true,
  })) as RecorderChannel[]

  it('滚动区是普通容器（fieldset 在它里面），头部与底部操作栏不在滚动区内', async () => {
    render(<ChannelScheduleDialog open channels={many} onClose={vi.fn()} onSaved={vi.fn()} />)
    const scroll = await screen.findByTestId('schedule-scroll')
    expect(scroll.tagName).toBe('DIV')
    expect(scroll.className).toMatch(/overflow-y-auto/)
    expect(scroll.querySelector('fieldset')).not.toBeNull()
    expect(scroll.parentElement!.tagName).not.toBe('FIELDSET')
    expect(scroll.contains(screen.getByTestId('schedule-save'))).toBe(false)
    expect(scroll.contains(screen.getByRole('button', { name: '关闭' }))).toBe(false)
  })

  it('未启用的通道只占一行，勾选后才展开 24 个小时格', async () => {
    // 已保存的计划里只有 ch0 启用，其余通道没有计划（即未启用）
    vi.mocked(configService.listDocuments).mockResolvedValueOnce([
      { name: 'settings', updatedAt: '2026-10-07T01:00:00.000Z', config: { channelSchedules: { ch0: { enabled: true, hours: [0, 1] } } } },
    ] as never)
    render(<ChannelScheduleDialog open channels={many} onClose={vi.fn()} onSaved={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('schedule-save')).not.toBeDisabled())
    expect(screen.getAllByRole('button', { name: /^通道 0 \d+ 点/ })).toHaveLength(24)
    expect(screen.queryByTestId('hour-ch1-0')).toBeNull()
    fireEvent.click(screen.getByTestId('schedule-toggle-ch1'))
    expect(screen.getAllByRole('button', { name: /^通道 1 \d+ 点/ })).toHaveLength(24)
  })
})
