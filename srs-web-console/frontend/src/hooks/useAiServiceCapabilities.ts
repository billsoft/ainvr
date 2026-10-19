import { useEffect, useState } from 'react'
import { aiChannelService } from '@/api/aiChannelService'
import type { AiServiceHealth } from '@/types/aiChannel'

/** ai-service 能力（设计 §8.4③）：由 /health 的 capabilities 声明，不按版本号推断 */
export interface AiServiceCapabilities {
  targetPresenceReview?: boolean
  analyticsNotifications?: boolean
  /** 能处理 H.265 源（输出同为 H.265） */
  h265: boolean
  /** 能输出 Enhanced RTMP 写法 */
  enhanced: boolean
}

/** 纯函数：health → 能力。没有 capabilities 字段 = 旧版 ai-service，只支持 H.264 */
export function capabilitiesFromHealth(health: AiServiceHealth | null): AiServiceCapabilities | null {
  if (!health) return null
  const codecs = health.capabilities?.codecs ?? []
  const formats = health.capabilities?.publish_formats ?? []
  return { h265: codecs.includes('h265'), enhanced: formats.includes('enhanced'), ...(health.capabilities?.target_presence_review===true?{targetPresenceReview:true}:{}), ...(health.capabilities?.analytics_notifications===true?{analyticsNotifications:true}:{}) }
}

/** enabled 时取一次 /ai/health；取不到（AI 服务不可达）为 null——调用方按"未知"处理 */
export function useAiServiceCapabilities(enabled: boolean): AiServiceCapabilities | null {
  const [caps, setCaps] = useState<AiServiceCapabilities | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void aiChannelService.health()
      .then((h) => { if (!cancelled) setCaps(capabilitiesFromHealth(h)) })
      .catch(() => { if (!cancelled) setCaps(null) })
    return () => { cancelled = true }
  }, [enabled])
  return caps
}
