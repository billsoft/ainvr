import type { ChannelWithStatus } from '@/types/channel'
import { UPSTREAM_LABEL } from '@/types/channel'
import type { GBBinding } from '@/pages/Channels/gbTypes'

export interface MonitorSource {
  protocol: string
  text: string
  detail: string
}

/** Resolve configured input identity, never infer camera protocol from a bridge stream. */
export function buildMonitorSources(
  channels: readonly ChannelWithStatus[],
  outputIds: ReadonlyMap<string, string>,
  variants: ReadonlyMap<string, readonly ChannelWithStatus[]>,
  gbBindings: readonly GBBinding[] | null,
): Map<string, MonitorSource> {
  const byId = new Map(channels.map(channel => [channel.id, channel]))
  const parents = new Map<string, Set<string>>()
  for (const [sourceId, outputs] of variants) {
    for (const output of outputs) {
      const ids = parents.get(output.id) ?? new Set<string>()
      ids.add(sourceId)
      parents.set(output.id, ids)
    }
  }
  const gb = new Map(gbBindings?.map(binding => [binding.input_id, binding]))
  const isOutput = (channel: ChannelWithStatus) => outputIds.has(`${channel.upstream.app}/${channel.upstream.stream}`)
  return new Map(channels.map(channel => {
    let source: ChannelWithStatus | undefined = channel
    const seen = new Set<string>()
    while (source && isOutput(source)) {
      if (seen.has(source.id)) { source = undefined; break }
      seen.add(source.id)
      const ids = parents.get(source.id)
      source = ids?.size === 1 ? byId.get([...ids][0]!) : undefined
    }
    if (!source) return [channel.id, {
      protocol: '来源待确认', text: 'AI 输出 · 原始来源不可用',
      detail: 'AI 输出的原始输入未找到或关联不唯一，暂不推断摄像头信息。',
    }]
    const binding = gb.get(source.id)
    const protocol = source.onvif ? 'ONVIF / RTSP' : binding ? 'GB/T 28181'
      : source.registered === false || (gbBindings === null && source.upstream.protocol === 'rtmp')
        ? '来源待确认' : UPSTREAM_LABEL[source.upstream.protocol]
    // Show only the host: neither URL userinfo, path nor query credentials.
    let host = ''
    if (source.upstream.rtspUrl) {
      try {
        const url = new URL(source.upstream.rtspUrl)
        if (url.protocol === 'rtsp:') host = url.host
      } catch { /* Keep the safe stream identity when an old URL is malformed. */ }
    }
    const stream = `${source.upstream.app}/${source.upstream.stream}`
    const detail = [
      `原始输入：${source.name}`, `接入协议：${protocol}`, `视频流：${stream}`,
      host && `设备地址：${host}`,
      binding && `国标设备：${binding.device_id}；视频通道：${binding.channel_id}；网关转发：RTMP`,
      source.registered === false && '未登记的直播流，摄像头接入方式尚未确认',
      gbBindings === null && source.upstream.protocol === 'rtmp' && !source.onvif && '接入来源信息暂未就绪，不将内部 RTMP 转发视为摄像头协议',
    ].filter(Boolean).join('；')
    return [channel.id, {
      protocol, text: isOutput(channel) ? `来源：${source.name}` : `输入：${host || stream}`, detail,
    }]
  }))
}
