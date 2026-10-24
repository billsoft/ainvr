import type { AiChannel } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'
import { isAiChannelOf } from '@/utils/channelMatching'

export type SourceAvailability = 'offline' | 'waiting-video' | 'online' | 'unknown'

// Only interpret local SRS observations for a source on that server. A remote
// source with the same app/name must never inherit the local source's status.
export function sourceAvailability(ai: AiChannel, channels: ChannelWithStatus[], checkedAt: number, now = Date.now()): SourceAvailability {
  if (!checkedAt || now - checkedAt > 15000 || now < checkedAt) return 'unknown'
  const source = channels.find(ch => isAiChannelOf(ai, ch))
  if (!source || source.status.srsOnline !== true) return 'unknown'
  try {
    const host = new URL(ai.config.stream.url).hostname
    const knownHosts = ['127.0.0.1', 'localhost', '[::1]', ...Object.values(source.urls?.play ?? {}).flatMap(url => {
      try { return [new URL(url).hostname] } catch { return [] }
    })]
    if (!knownHosts.includes(host)) return 'unknown'
  } catch { return 'unknown' }
  if (source.status.online) return 'online'
  if (source.status.inputState === 'waiting-source') return 'offline'
  if (source.status.inputState === 'waiting-video') return 'waiting-video'
  return 'unknown'
}

export function aiPresentationState(channel: AiChannel, source: SourceAvailability) {
  if (channel.config.manually_stopped && ['idle', 'error'].includes(channel.state)) return 'idle'
  if (channel.state === 'starting' && (source === 'offline' || source === 'waiting-video')) return 'waiting-source'
  // Keep model, authorization, decoder and unknown failures visible. This narrow
  // legacy error match is corroborated by a fresh SRS snapshot, never used alone.
  const sourceOpenFailure = /^(?:初始化失败: )?Open media: /.test(channel.stats.last_error ?? '')
  if (['error', 'reconnecting'].includes(channel.state) && sourceOpenFailure &&
      (source === 'offline' || source === 'waiting-video')) return 'waiting-source'
  return channel.state
}
