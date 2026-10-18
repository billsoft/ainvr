import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { CopyButton } from '@/components/common/CopyButton'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ProtocolTag } from '@/components/common/ProtocolTag'
import { ChannelPipelineDiagram, type PipelineProcessNode } from '@/components/pipeline/ChannelPipelineDiagram'
import { AiChannelWizard } from '@/pages/AiChannels/AiChannelWizard'
import { aiServiceRtmpBase } from '@/features/aiChannelForm'
import { AiPreviewModal } from '@/pages/AiChannels/AiPreviewModal'
import { useAiChannelsStore } from '@/store/aiChannels'
import { useChannelsStore } from '@/store/channels'
import { channelService } from '@/api/channelService'
import { buildPlayUrl, buildPushUrl, formatBitrate, formatDuration } from '@/utils/format'
import { isAiChannelOf, getAiModelLabel, getAiOutputShortName } from '@/utils/channelMatching'
import { DOWNSTREAM_LABEL, UPSTREAM_LABEL, type ChannelWithStatus } from '@/types/channel'
import type { AiChannel } from '@/types/aiChannel'
import { useAiServiceCapabilities } from '@/hooks/useAiServiceCapabilities'
import { formatCodec, getCodecSupport, hevcLevelIdc, isH265, planLivePlayback } from '@/utils/codec'
import { useServerRtcHevc } from '@/hooks/useServerRtcHevc'
import { PublishCredential } from './PublishCredential'

/** 通道详情页：基本信息 + 全协议推/拉流地址 + AI 处理链路图（T 型） */
/** H.265 通道：本机能否播放、识别框模式、源流准入观察（设计 §8.4①） */
function H265PlaybackInfo({ ch, aiChannels }: { ch: ChannelWithStatus; aiChannels: AiChannel[] }) {
  const rtcHevc = useServerRtcHevc(true)
  const support = getCodecSupport()
  const plan = planLivePlayback(ch.status.videoCodec, support, { rtcHevc }, ch.downstream.protocols, hevcLevelIdc({
    level: ch.status.videoLevel, width: ch.status.videoWidth, height: ch.status.videoHeight,
  }))
  const overlay = !support.encodedTransform
    ? '不可用（此浏览器取不到逐帧识别数据）'
    : support.videoFrameCallback
      ? '逐帧或近似（播放时按浏览器能力自动判定）'
      : '近似（此浏览器没有逐帧显示回调）'
  const playback = plan.kind === 'pending'
    ? '正在检测…'
    : plan.kind === 'webrtc'
      ? `WebRTC 实时播放 · 识别框：${overlay}`
      : plan.kind === 'hls' || plan.kind === 'unsupported'
        ? plan.reason
        : 'WebRTC 实时播放'
  const bframes = aiChannels.some((a) => a.stats.source_bframes)
  const demuxDropped = aiChannels.reduce((n, a) => n + (a.stats.demux_dropped_frames ?? 0), 0)
  return (
    <div className="mt-3 rounded-panel border border-line bg-surface px-4 py-3 text-xs shadow-card" data-testid="h265-playback-info">
      <p className="text-ink-subtle"><span className="font-medium text-ink">本机播放（H.265）：</span>{playback}</p>
      {bframes && (
        <p className="mt-1 text-warning-700">⚠ 源流含 B 帧：WebRTC 播放可能卡顿或花屏，建议在相机上关闭 B 帧</p>
      )}
      {demuxDropped > 0 && (
        <p className="mt-1 text-warning-700">AI 服务解析此源时已丢弃 {demuxDropped} 帧（输入损坏或等待关键帧），请检查网络与相机</p>
      )}
    </div>
  )
}

export default function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [ch, setCh] = useState<ChannelWithStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const host = window.location.hostname

  // AI 处理（归属该通道的 AI 通道）
  const { channels: allAiChannels, serviceUnreachable, listStreams } = useAiChannelsStore()
  const srsChannels = useChannelsStore((s) => s.channels)
  const fetchSrsChannels = useChannelsStore((s) => s.fetchChannels)
  const [showAddWizard, setShowAddWizard] = useState(false)
  const aiCapabilities = useAiServiceCapabilities(showAddWizard)
  const [previewAiChannel, setPreviewAiChannel] = useState<AiChannel | null>(null)
  const [streams, setStreams] = useState<Awaited<ReturnType<typeof listStreams>>>([])

  // 进入页面时拉一次 AI 通道列表（只有在详情页才加载，避免仪表盘等页面
  // 也跟着打 AI 服务的请求——大部分用户可能从来不用 AI 功能）。
  useEffect(() => {
    if (id) {
      void useAiChannelsStore.getState().fetchChannels()
    }
  }, [id])

  useEffect(() => {
    let alive = true
    setLoading(true)
    if (!id) return undefined
    channelService.get(id).then((c) => {
      if (alive) {
        setCh(c)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [id])

  // 打开向导时刷新 SRS 通道列表 + AI 流列表，确保下拉和在线状态是最新的
  async function handleOpenWizard() {
    await Promise.all([
      fetchSrsChannels(),
      listStreams().then(setStreams).catch(() => setStreams([])),
    ])
    setShowAddWizard(true)
  }



  // 筛选归属本通道的 AI 处理
  const myAiChannels = ch && !serviceUnreachable
    ? allAiChannels.filter((ai) => isAiChannelOf(ai, ch))
    : []

  // 转成 T 型图的节点格式
  const processNodes: PipelineProcessNode[] = myAiChannels.map((ai) => ({
    id: ai.id,
    label: getAiModelLabel(ai.config.model.adapter, ai.config.model.name),
    state: ai.state,
    fps: ai.stats.inference_fps_actual,
    p95Ms: ai.stats.timing.total.p95_ms,
    streamUrl: ai.config.stream.url,
    outputStream: getAiOutputShortName(ai),
    onPlayStream: ai.config.publish.enabled
      ? () => setPreviewAiChannel(ai)
      : undefined,
  }))

  if (loading) {
    return <p className="p-6 text-sm text-ink-faint" data-testid="detail-loading">加载中…</p>
  }
  if (!ch) {
    return (
      <p className="p-6 text-sm text-ink-faint" data-testid="detail-missing">
        通道不存在或已被删除。
      </p>
    )
  }

  const input = { host, app: ch.upstream.app, stream: ch.upstream.stream }
  // 优先用后端按当前系统设置（协议主机名覆盖）算好的地址；没有就退回本地计算
  // （mock 测试环境下 ch.urls 不存在，靠这个 fallback 保证测试不受影响）
  const pushUrl = ch.urls?.push?.[ch.upstream.protocol] ?? buildPushUrl(ch.upstream.protocol, input)
  const clip = 'overflow-hidden text-ellipsis whitespace-nowrap'

  return (
    <section className="mx-auto max-w-4xl">
      <Link
        to="/channels"
        className="inline-flex items-center gap-1 text-sm text-ink-subtle hover:text-primary"
      >
        <ArrowLeft size={15} aria-hidden /> 返回列表
      </Link>

      <div className="mt-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink" data-testid="detail-name">
            {ch.name}
          </h2>
          {ch.description && <p className="mt-0.5 text-sm text-ink-subtle">{ch.description}</p>}
        </div>
        <StatusBadge online={ch.status.online} />
      </div>

      {/* T 型数据流图 */}
      {ch && !serviceUnreachable && (
        <ChannelPipelineDiagram
          className="mt-4"
          inputName={`${ch.upstream.app}/${ch.upstream.stream}`}
          inputOnline={ch.status.online}
          processes={processNodes}
          onAddProcess={handleOpenWizard}
        />
      )}

      {/* AI 服务不可达提示 */}
      {ch && serviceUnreachable && (
        <div className="mt-4 rounded-panel border border-warning-200 bg-warning-50 p-4">
          <p className="text-sm font-medium text-warning-700">AI 服务不可达</p>
          <p className="mt-1 text-xs text-warning-600">
            AI 微服务连接失败，无法显示 AI 处理链路。请在
            <Link to="/config-center?category=ai-service" className="mx-1 font-medium underline">
              系统配置
            </Link>
            中检查 AI 服务连接。
          </p>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface p-4 shadow-card sm:grid-cols-4">
        {[
          ['上行协议', UPSTREAM_LABEL[ch.upstream.protocol]],
          ['流名', `${ch.upstream.app}/${ch.upstream.stream}`],
          ['观看人数', ch.status.online ? String(ch.status.viewerCount) : '-'],
          ['码率', ch.status.online ? formatBitrate(ch.status.bitrateKbps) : '-'],
          ['运行时长', ch.status.online ? formatDuration(ch.status.durationSec) : '-'],
          ['视频编码', formatCodec(ch.status.videoCodec)
            + (ch.status.videoWidth && ch.status.videoHeight ? ` · ${ch.status.videoWidth}×${ch.status.videoHeight}` : '')
            + (ch.status.videoLevel ? ` · L${ch.status.videoLevel}` : '')],
          ['音频编码', ch.status.audioCodec ?? '-'],
          ['默认播放', DOWNSTREAM_LABEL[ch.downstream.primary]],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-faint">{k}</dt>
            <dd className={`mt-0.5 font-mono text-sm text-ink ${clip}`}>{v}</dd>
          </div>
        ))}
      </dl>

      {ch.status.online && isH265(ch.status.videoCodec) && (
        <H265PlaybackInfo ch={ch} aiChannels={myAiChannels} />
      )}

      <div className="mt-4 rounded-panel border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-3 text-sm font-medium text-ink">
          推流地址（上行）
        </div>
        <div className="p-4">
          {ch.upstream.protocol === 'webrtc' && <PublishCredential id={ch.id} />}
          {pushUrl ? (
            <div className="flex items-center justify-between gap-3">
              <code
                className={`min-w-0 flex-1 rounded-base bg-surface-page px-3 py-2 font-mono text-xs text-ink ${clip}`}
                data-testid="push-url"
              >
                {pushUrl}
              </code>
              <CopyButton value={pushUrl} />
            </div>
          ) : (
            <p className="text-sm text-ink-subtle">
              RTSP 来源由系统自动拉流，无需手动推流。源地址：
              <code className="font-mono text-xs">{ch.upstream.rtspUrl}</code>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-panel border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-3 text-sm font-medium text-ink">
          播放地址（下行，{ch.downstream.protocols.length} 个协议）
        </div>
        <div className="flex flex-col divide-y divide-line/60">
          {ch.downstream.protocols.map((p) => {
            const url = ch.urls?.play?.[p] ?? buildPlayUrl(p, input)
            return (
              <div key={p} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ProtocolTag label={DOWNSTREAM_LABEL[p]} />
                  <code className={`min-w-0 flex-1 font-mono text-xs text-ink ${clip}`} data-testid={`play-${p}`}>
                    {url}
                  </code>
                </div>
                <CopyButton value={url} />
              </div>
            )
          })}
        </div>
        <div className="border-t border-line px-4 py-2.5 text-xs text-ink-faint">
          💡 上面的协议只决定生成哪些播放地址，不是访问控制开关：流媒体服务当前对所有协议全局放行。
        </div>
      </div>

      {/* 添加 AI 处理向导 */}
      {showAddWizard && ch && (
        <AiChannelWizard
          open={showAddWizard}
          mode="create"
          streams={streams}
          srsChannels={srsChannels}
          aiChannels={allAiChannels}
          lockedSource={{
            // ai-service 拉流用的地址,不是浏览器播放地址(见 aiServiceRtmpBase)
            url: `${aiServiceRtmpBase(allAiChannels)}/${ch.upstream.app}/${ch.upstream.stream}`,
            displayLabel: ch.name,
            online: ch.status.online,
            h265: isH265(ch.status.videoCodec),
          }}
          aiCapabilities={aiCapabilities}
          onRefreshStreams={async () => {
            try { setStreams(await listStreams()) } catch { setStreams([]) }
          }}
          onClose={() => setShowAddWizard(false)}
          onSubmit={async (patch) => {
            await useAiChannelsStore.getState().createChannel(patch as import('@/types/aiChannel').AiChannelCreatePatch)
            setShowAddWizard(false)
            await useAiChannelsStore.getState().fetchChannels()
          }}
        />
      )}

      {/* 衍生流播放弹窗 */}
      {previewAiChannel && previewAiChannel.config.publish.enabled && (
        <AiPreviewModal
          channelId={previewAiChannel.id}
          channelName={previewAiChannel.name}
          effectiveTargetUrl={previewAiChannel.config.publish.effective_target_url}
          videoCodec={previewAiChannel.stats.publish?.codec ?? previewAiChannel.stats.video_codec}
          onClose={() => setPreviewAiChannel(null)}
        />
      )}
    </section>
  )
}
