import { useEffect, useState } from 'react'
import { request } from '@/api/httpClient'
import { channelService } from '@/api/channelService'
import { onvifService, onvifError } from '@/api/onvifService'
import type { ChannelWithStatus, ChannelStatus } from '@/types/channel'

interface InputState {
  generation?: string
  state: string
  error?: string
  audioWarning?: string
  audioCodec?: string
}
const states: Record<string, string> = {
  waiting: '等待拉流',
  connecting: '正在连接',
  streaming: '正在接收视频',
  reconnecting: '正在恢复连接',
  blocked: '需要修正配置',
  error: '连接失败',
}
const reasons: Record<string, string> = {
  authentication_failed: '媒体认证失败，请检查账号权限和密码',
  unsupported_video_codec: '视频编码不支持，请重新选择码流',
  source_unavailable: '摄像头暂时无媒体，正在重试',
  audio_capacity_exceeded: '音频转换并发已满，当前仅接入视频',
  audio_processing_failed: '音频处理失败，已降级为仅视频',
  unsupported_audio_codec: '当前音频编码不支持，仅接入视频',
  no_audio: '当前码流无音频',
}

export function InputDiagnostics({
  channel,
  onStatus,
}: {
  channel: ChannelWithStatus
  onStatus?: (status: ChannelStatus) => void
}) {
  const [published, setPublished] = useState<boolean | null>(null)
  const [state, setState] = useState<InputState | null>(null),
    [controlError, setControlError] = useState(''),
    [unavailable, setUnavailable] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!document.hidden) {
        const [media, control, current] = await Promise.allSettled([
          request<{ data: { channels: Record<string, InputState> } }>('/ingest/status'),
          channel.onvif ? onvifService.status() : Promise.resolve(null),
          channelService.get(channel.id),
        ])
        if (active) {
          setUnavailable(media.status === 'rejected')
          setPublished(
            current.status === 'fulfilled' && current.value ? current.value.status.online : null,
          )
          if (current.status === 'fulfilled' && current.value) onStatus?.(current.value.status)
          const value = media.status === 'fulfilled' ? media.value.data.channels[channel.id] : null
          setState(
            value && (!value.generation || value.generation === channel.inputGeneration)
              ? value
              : null,
          )
          setControlError(
            control.status === 'fulfilled' && control.value
              ? (control.value.channels?.[channel.id]?.error ?? '')
              : '',
          )
        }
      }
      if (active) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [channel.id, channel.inputGeneration, channel.onvif?.deviceId, onStatus])
  async function retry() {
    if (!channel.onvif || busy) return
    setBusy(true)
    setMessage('')
    try {
      await onvifService.probe(channel.onvif.deviceId)
      setMessage('设备已重新读取，正在恢复关联通道。')
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const enabled = channel.upstream.inputEnabled !== false
  return (
    <section
      className="mt-3 rounded-panel border border-line bg-surface p-4 text-sm"
      aria-label="摄像头接入诊断"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">摄像头接入状态</h3>
        {channel.onvif && (
          <button className="btn-secondary min-h-11" disabled={busy} onClick={() => void retry()}>
            {busy ? '正在读取…' : '重新读取设备'}
          </button>
        )}
      </div>
      <p className="mt-2">
        {!enabled
          ? '输入已停用'
          : unavailable
            ? '拉流服务状态暂不可用'
            : state
              ? (states[state.state] ?? '等待状态更新')
              : '等待接入任务'}{' '}
        · SRS{' '}
        {published === null ? '发布状态待更新' : published ? '已收到发布流' : '尚未收到发布流'}
      </p>
      {state?.error && (
        <p className="mt-2 text-warning-700">
          {reasons[state.error] ?? '接入尚未成功，请检查设备和拉流配置。'}
        </p>
      )}
      {controlError && (
        <p className="mt-2 text-warning-700">设备控制：{onvifError(new Error(controlError))}</p>
      )}
      {enabled && state && (
        <p className="mt-2 text-ink-subtle">
          音频：
          {state.audioWarning
            ? (reasons[state.audioWarning] ?? '当前音频不可用')
            : state.audioCodec
              ? `${state.audioCodec.toUpperCase()}${['pcm_alaw', 'pcm_mulaw', 'adpcm_g726', 'adpcm_g726le'].includes(state.audioCodec) ? ' → AAC' : ''}`
              : channel.upstream.inputAudioMode === 'off'
                ? '仅视频'
                : '等待媒体探测'}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-ink-subtle">
          {message}
        </p>
      )}
    </section>
  )
}
