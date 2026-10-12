import { useEffect, useMemo, useState } from 'react'
import { channelService } from '@/api/channelService'
import { aiChannelService } from '@/api/aiChannelService'
import type { ChannelWithStatus } from '@/types/channel'
import type { AiChannel, AiStreamOption } from '@/types/aiChannel'
import { buildAiOutputChannelIdMap, parseStreamPath } from '@/utils/channelMatching'

/** Each dependency polls independently; optional AI metadata never blocks source video. */
export function useMonitorCatalog() {
  const [channels, setChannels] = useState<ChannelWithStatus[]>([])
  const [ai, setAi] = useState<AiChannel[]>([])
  const [streams, setStreams] = useState<AiStreamOption[]>([])
  const [sourceReady, setSourceReady] = useState(false)
  const [metadataSettled, setMetadataSettled] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    let disposed = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    // Briefly allow normal AI responses to classify outputs before first arrangement.
    // Slow/unavailable AI falls back to the source catalogue without an indefinite wait.
    const grace = setTimeout(() => {
      if (!disposed) setMetadataSettled(true)
    }, 1500)
    function startPoll<T>(key: string, load: () => Promise<T>, receive: (value: T) => void, settled?: () => void) {
      async function poll() {
        try {
          const value = await load()
          if (disposed) return
          receive(value)
          setErrors(previous => ({ ...previous, [key]: '' }))
        } catch {
          if (disposed) return
          setErrors(previous => ({ ...previous, [key]: `${key}更新失败，保留已有数据并自动重试` }))
        } finally {
          if (!disposed) {
            settled?.()
            const timer = setTimeout(() => { timers.delete(timer); void poll() }, 15000)
            timers.add(timer)
          }
        }
      }
      void poll()
    }
    startPoll('接入通道', () => channelService.list(), value => { setChannels(value); setSourceReady(true) })
    startPoll('AI 配置', () => aiChannelService.list(), setAi, () => setMetadataSettled(true))
    startPoll('直播流列表', () => aiChannelService.listStreams(), setStreams)
    return () => { disposed = true; clearTimeout(grace); timers.forEach(clearTimeout) }
  }, [])
  const allChannels = useMemo(() => {
    const keys = new Set(channels.map(c => `${c.upstream.app}/${c.upstream.stream}`))
    const extra = streams.filter(s => !keys.has(`${s.app}/${s.name}`)).map((s): ChannelWithStatus => ({
      id: `__srs_${s.app}_${s.name}`, name: `${s.app}/${s.name}`, description: '',
      createdAt: '', updatedAt: '', registered: false,
      upstream: { protocol: 'rtmp', app: s.app, stream: s.name },
      downstream: { protocols: ['webrtc', 'flv', 'hls', 'rtmp'], primary: 'webrtc' },
      status: { channelId: `__srs_${s.app}_${s.name}`, online: true, viewerCount: s.clients ?? 0, bitrateKbps: s.bitrateKbps,
        videoCodec: s.videoCodec, videoLevel: s.videoLevel, videoWidth: s.videoWidth, videoHeight: s.videoHeight },
    }))
    return [...channels, ...extra]
  }, [channels, streams])
  const outputIds = useMemo(() => buildAiOutputChannelIdMap(ai), [ai])
  const variants = useMemo(() => {
    const result = new Map<string, ChannelWithStatus[]>()
    for (const c of allChannels) {
      const targets = ai.filter(a => {
        const source = parseStreamPath(a.config.stream.url)
        return source?.app === c.upstream.app && source.stream === c.upstream.stream && a.config.publish.enabled
      }).flatMap(a => {
        const target = parseStreamPath(a.config.publish.effective_target_url)
        return allChannels.filter(c => target?.app === c.upstream.app && target.stream === c.upstream.stream)
      })
      if (targets.length) result.set(c.id, targets)
    }
    return result
  }, [allChannels, ai])
  return { allChannels, outputIds, variants, ready: sourceReady && metadataSettled, error: Object.values(errors).filter(Boolean).join('；') }
}
