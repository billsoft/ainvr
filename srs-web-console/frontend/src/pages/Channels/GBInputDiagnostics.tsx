import { useEffect, useState } from 'react'
import { request } from '@/api/httpClient'
import { channelService } from '@/api/channelService'
import type { ChannelStatus, ChannelWithStatus } from '@/types/channel'

interface Binding {
  binding_id: string
  input_id: string
  enabled: boolean
}
interface Input {
  id: string
  state: string
  reason?: string
  audio?: string
}
const states: Record<string, string> = {
  disabled: '输入已停用',
  waiting_device: '等待设备注册',
  inviting: '正在请求摄像头码流',
  waiting_media: '等待摄像头发送音视频',
  publishing: '正在发布到流媒体服务',
  streaming: '视频接入正常',
  recovering: '正在恢复连接',
}
const reasons: Record<string, string> = {
  media_peer_mismatch: '实际媒体来源与协商地址不一致，已拒绝发布；请检查设备或 NVR 媒体地址。',
  media_receiver_unavailable: '国标媒体接收服务暂不可用，正在重试。',
  media_connect_failed: '未能连接摄像头的媒体端口，正在重试。',
  media_timeout: '设备已响应点播，但未收到可用视频。',
  media_lost: '摄像头媒体已中断，正在重新请求。',
  invite_failed: '点播未成功，请检查设备目录、协议和媒体传输方式。',
  srs_publish_timeout: '尚未完成流媒体发布，正在恢复。',
  bridge_start_failed: '媒体桥接未能启动，请检查运行日志。',
  bridge_exited: '媒体桥接已中断，正在恢复。',
  device_offline: '设备尚未注册或已离线。',
  device_session_changed: '设备重新注册，正在建立新的媒体会话。',
  device_ended_session: '设备结束了媒体会话，正在重新请求。',
  audio_tracks_changed: '设备音轨发生变化，正在重新接入。',
  unsupported_video_codec: '当前视频编码不支持，请在摄像头端选择 H.264 或 H.265。',
  unsupported_audio_codec: '当前音频编码不支持，视频继续接入。',
}

export function GBInputDiagnostics({
  channel,
  onStatus,
}: {
  channel: ChannelWithStatus
  onStatus?: (status: ChannelStatus) => void
}) {
  const [binding, setBinding] = useState<Binding | null>(null)
  const [input, setInput] = useState<Input | null>(null)
  const [globalState, setGlobalState] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [published, setPublished] = useState(channel.status.online)
  useEffect(() => {
    setBinding(null)
    setInput(null)
    setPublished(channel.status.online)
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!document.hidden) {
        const results = await Promise.allSettled([
          request<{ items: Binding[] }>('/gb28181/bindings'),
          request<{ state?: string; inputs?: Input[] }>('/gb28181/status'),
          channelService.get(channel.id),
        ])
        if (!active) return
        const [bindings, status, current] = results
        if (bindings.status === 'fulfilled') {
          const selected = bindings.value.items.find((b) => b.input_id === channel.id) ?? null
          setBinding(selected)
          setInput(status.status === 'fulfilled'
            ? status.value.inputs?.find((s) => s.id === selected?.binding_id) ?? null : null)
        }
        setUnavailable(bindings.status === 'rejected' || status.status === 'rejected')
        setGlobalState(status.status === 'fulfilled' ? status.value.state ?? '' : '')
        if (current.status === 'fulfilled' && current.value) {
          setPublished(current.value.status.online)
          onStatus?.(current.value.status)
        }
      }
      if (active) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [channel.id, onStatus])
  if (!binding) return null
  const disabled = !binding.enabled || channel.upstream.inputEnabled === false
  const audio = input?.audio?.toLowerCase()
  return (
    <section className="mt-3 rounded-panel border border-line bg-surface p-4 text-sm" aria-label="国标摄像头接入诊断">
      <h3 className="font-medium">国标摄像头接入状态</h3>
      <p className="mt-2">
        {disabled ? '输入已停用' : unavailable ? '国标服务状态暂不可用'
          : globalState === 'disabled' ? '国标接入已全局停用'
          : ['failed', 'unavailable'].includes(globalState) ? '国标服务尚未就绪，请检查服务状态'
          : input ? states[input.state] ?? '等待接入状态更新' : '等待接入任务'}
        {' · '}SRS {published ? '已收到发布流' : '尚未收到发布流'}
      </p>
      {!disabled && input?.reason && (
        <p className="mt-2 text-warning-700">{reasons[input.reason] ?? '接入尚未完成，请查看国标服务日志。'}</p>
      )}
      {!disabled && input?.state === 'streaming' && (
        <p className="mt-2 text-ink-subtle">音频：{input.reason === 'unsupported_audio_codec' ? '不可用，当前仅视频'
          : audio ? `${audio.toUpperCase()}${['g711a', 'g711u', 'pcma', 'pcmu', 'pcm_alaw', 'pcm_mulaw'].includes(audio) ? ' → AAC' : ''}`
          : '当前码流无音轨'}</p>
      )}
    </section>
  )
}
