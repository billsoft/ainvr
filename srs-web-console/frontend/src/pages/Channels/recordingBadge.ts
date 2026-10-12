import type { RecorderChannel } from '@/types/recording'
import type { PipelineState } from './ChannelTable'

/**
 * 通道列表"录像"徽标：一处判定录像服务返回的运行时状态。
 * 写得慢（writeState=degraded）仍在录，但按完整画面组丢弃过，用警告色明示；
 * 写入卡死由录像服务走存储熔断，表现为 storage_error。
 */
export function recordingBadge(recorder: RecorderChannel | undefined, unavailable: boolean): PipelineState {
  if (unavailable) return { label: '状态未知', tone: 'danger', detail: '录像服务不可达', to: '/dashboard?tab=logs&source=recorder' }
  if (!recorder) return { label: '未纳管', tone: 'muted', detail: '录像服务尚未发现该通道', to: '/playback?schedule=1' }
  if (recorder.recordingState === 'storage_error') return { label: '存储异常', tone: 'danger', detail: recorder.recordingDetail, to: '/dashboard?tab=logs&source=recorder' }
  if (recorder.recordingState === 'codec_error') return { label: '缺少 H.265 组件', tone: 'danger', detail: recorder.recordingDetail, to: '/playback?schedule=1' }
  const playback = `/playback/${encodeURIComponent(recorder.id)}`
  if (recorder.recording && recorder.codecWarning === 'no_idr') return { label: '录像中 · 源无关键帧', tone: 'warning', detail: recorder.recordingDetail, to: playback }
  if (recorder.recording && recorder.codecWarning === 'open_gop') return { label: '录像中 · 开放 GOP', tone: 'warning', detail: recorder.recordingDetail, to: playback }
  if (recorder.recording && recorder.writeState === 'degraded') return { label: recorder.writeBacklogActive ? '录像中 · 写入积压' : '录像中 · 近1小时有缺口', tone: 'warning', detail: recorder.recordingDetail, to: playback }
  if (recorder.recording) return { label: '录像中', tone: 'success', detail: recorder.recordingDetail, to: playback }
  if (recorder.scheduleEnabled) return { label: recorder.sourceOnline ? '已计划' : '等待视频源', tone: 'warning', detail: recorder.recordingDetail, to: playback }
  return { label: '未启用', tone: 'muted', to: '/playback?schedule=1' }
}
