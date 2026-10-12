import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import { parseRtmpToPlayTarget } from '@/utils/aiStream'
import { aiChannelService } from '@/api/aiChannelService'
import type { AiStreamOption } from '@/types/aiChannel'

interface Props {
  channelId: string
  channelName: string
  effectiveTargetUrl: string
  /** AI 输出编码（与源相同，ai-service stats 给出）：H.265 时按 §8.3 选播放方式 */
  videoCodec?: string
  onClose: () => void
}

// 识别框开关本身是 VideoPlayer 控件条的一部分（传 aiChannelId 就自动出现），
// 跟实时监看宫格/聚焦大画面用的是同一份实现，这里不用再自己接一遍。
export function AiPreviewModal({ channelId, channelName, effectiveTargetUrl, videoCodec, onClose }: Props) {
  const target = parseRtmpToPlayTarget(effectiveTargetUrl)
  // 档位/分辨率以 SRS 上这条输出流的实测为准（判定本机能否播放该路 H.265）
  const [srsVideo, setSrsVideo] = useState<AiStreamOption | null>(null)
  useEffect(() => {
    if (!target) return
    let alive = true
    aiChannelService.listStreams()
      .then((list) => {
        if (alive) setSrsVideo(list.find((s) => s.app === target.app && s.name === target.stream) ?? null)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [target?.app, target?.stream])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="播放衍生流">
      <div className="w-[640px] rounded-panel bg-surface p-4 shadow-modal">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{channelName} · 衍生流预览</h3>
          <button type="button" onClick={onClose} className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          画面原样输出（SEI 元数据直通，不重新编码）；检测框由浏览器实时叠加，不占用设备算力——
          悬停播放器可在控制栏切换"识别框"显隐
        </p>
        {/* 预览画面统一 16:9 比例，与实时监看/历史回放一致 */}
        <div className="relative mt-3 aspect-video w-full">
          {target ? (
            <VideoPlayer
              title=""
              // 含 hls：H.265 输出在本机/服务端不能 WebRTC 时按 §8.3 以 HLS 兜底；
              // H.264 有 webrtc 时播放器仍只走 WebRTC，行为不变
              protocols={['webrtc', 'flv', 'hls']}
              primary="webrtc"
              stream={{ host: window.location.hostname, app: target.app, stream: target.stream }}
              muted
              showControls
              aiChannelId={channelId}
              videoInfo={{
                codec: srsVideo?.videoCodec ?? videoCodec,
                level: srsVideo?.videoLevel,
                width: srsVideo?.videoWidth,
                height: srsVideo?.videoHeight,
              }}
            />
          ) : (
            <p className="rounded-base border border-line bg-surface-page p-6 text-center text-sm text-ink-subtle">
              推流地址格式无法解析：{effectiveTargetUrl}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
