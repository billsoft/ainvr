import { useState } from 'react'
import { MoreVertical, Play, Square, Eye, Pencil, Trash2 } from 'lucide-react'
import { AiChannelStatusBadge } from '@/components/common/AiChannelStatusBadge'
import { getAiModelDisplayName, type AiChannel } from '@/types/aiChannel'
import { formatCodec, isH265 } from '@/utils/codec'

interface Props {
  channel: AiChannel
  disabled: boolean
  sourceChannelName?: string
  onStart: () => void
  onStop: () => void
  onEdit: () => void
  onDelete: () => void
  onViewResult: () => void
  onPreview: () => void
}

export function AiChannelCard({ channel, disabled, sourceChannelName, onStart, onStop, onEdit, onDelete, onViewResult, onPreview }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { config, stats } = channel
  const canStart = !config.deletion_pending && (channel.state === 'idle' || channel.state === 'error')
  // 出错通道会按退避反复重试；停止是终止重试的唯一入口
  const canStop = channel.state === 'running' || channel.state === 'reconnecting' ||
    (channel.state === 'error' && !config.manually_stopped)
  const receiving = channel.state === 'running'

  return (
    <div className="rounded-panel border border-line bg-surface p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          {sourceChannelName ? (
            <p className="text-sm text-ink-subtle">来源：{sourceChannelName}</p>
          ) : (
            <p className="text-sm text-warning-600">未配置源</p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <p className="truncate text-base font-semibold text-ink">{channel.name}</p>
            {config.deletion_pending
              ? <span className="text-xs font-medium text-danger">删除待完成</span>
              : <AiChannelStatusBadge state={channel.state} />}
            {!config.deletion_pending && config.manually_stopped && (channel.state === 'idle' || channel.state === 'error') && (
              <span className="text-xs text-ink-subtle" data-testid="ai-card-manual-stop">手动停止，服务重启后保持</span>
            )}
            {stats.video_codec && (
              <span
                className={`rounded-base px-1.5 py-0.5 font-mono text-xs ${isH265(stats.video_codec) ? 'bg-primary-50 text-primary-600' : 'bg-surface-page text-ink-subtle'}`}
                title={isH265(stats.video_codec) && stats.publish?.flv_format ? `输出封装：${stats.publish.flv_format}` : undefined}
                data-testid="ai-card-codec"
              >
                {formatCodec(stats.video_codec)}
              </span>
            )}
          </div>
          <p className="mt-1.5 truncate text-sm text-ink-faint" title={config.stream.url}>
            源流 {config.stream.url}
          </p>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-base p-1.5 text-ink-faint hover:bg-surface-page hover:text-ink"
            aria-label="更多操作"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 w-40 rounded-base border border-line bg-surface py-1 shadow-modal">
                {canStart && (
                  <button type="button" disabled={disabled} onClick={() => { setMenuOpen(false); onStart() }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-page disabled:opacity-40">
                    <Play size={15} /> 启动
                  </button>
                )}
                {canStop && (
                  <button type="button" disabled={disabled} onClick={() => { setMenuOpen(false); onStop() }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-page disabled:opacity-40">
                    <Square size={15} /> 停止
                  </button>
                )}
                <button type="button" disabled={disabled || config.deletion_pending} onClick={() => { setMenuOpen(false); onEdit() }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-page disabled:opacity-40">
                  <Pencil size={15} /> 编辑
                </button>
                <button type="button" disabled={disabled} onClick={() => { setMenuOpen(false); onDelete() }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-danger hover:bg-danger-50 disabled:opacity-40">
                  <Trash2 size={15} /> {config.deletion_pending ? '重试删除' : '删除'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-ink-subtle">
        <span>模型：{getAiModelDisplayName(config.model)}</span>
        <span>{config.model.adapter === 'locateanything_trt'
          ? `采集：每 ${(1 / config.inference_fps).toFixed(1)} 秒一次（${receiving && stats.inference_fps_actual > 0 ? `实测约 ${(1 / stats.inference_fps_actual).toFixed(1)} 秒` : '等待识别结果'}）`
          : `推理：${config.inference_fps > 0 ? `${config.inference_fps} FPS` : '跟随源流'}（${receiving ? `实测 ${stats.inference_fps_actual?.toFixed?.(1) ?? '0.0'}` : '等待视频恢复'}）`}</span>
        <span>处理耗时 p95：{receiving ? `${stats.timing?.total?.p95_ms?.toFixed?.(1) ?? '0.0'}ms` : '—'}</span>
        {/* 源 30fps、推理 15fps 时每次天然跳 1 帧，这是按设定帧率抽帧，不是
            丢帧；过载丢帧才是推理跟不上源。旧版 ai-service 没有拆分字段，回退
            显示总跳帧数（不能再叫"丢帧"，它大部分是正常抽帧）。 */}
        <span data-testid="ai-card-frames">
          {stats.sampled_skip_count != null && stats.overload_drop_count != null
            ? `抽帧 ${stats.sampled_skip_count} · 过载丢帧 ${stats.overload_drop_count} · 归档反压跳帧 ${stats.archive_backpressure_skip_count ?? 0}`
            : `跳帧 ${stats.dropped_count ?? 0}`}
          {receiving && stats.source_fps && stats.inference_fps_target
            ? config.model.adapter === 'locateanything_trt'
              ? `（源 ${Math.round(stats.source_fps)} FPS → 每 ${(1 / stats.inference_fps_target).toFixed(1)} 秒采集）`
              : `（源 ${Math.round(stats.source_fps)} → 推理 ${Math.round(stats.inference_fps_target)} FPS）`
            : ''}
        </span>
      </div>

      {(channel.state === 'error' || channel.state === 'reconnecting' || config.model.adapter === 'locateanything_trt' || config.model.adapter === 'yoloe_pt') && stats.last_error && (
        <p className="mt-3 rounded-base border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700"
           data-testid="ai-card-last-error">
          ⚠ {stats.last_error}
        </p>
      )}

      {(stats.demux_dropped_frames ?? 0) > 0 && (
        <p className="mt-3 rounded-base border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700"
           data-testid="ai-card-demux">
          ⚠ H.265 源输入异常：已丢弃 {stats.demux_dropped_frames} 帧
          {(stats.demux_resyncs ?? 0) > 0 ? `、重同步 ${stats.demux_resyncs} 次` : ''}（损坏或等待关键帧），请检查网络与相机
        </p>
      )}

      {stats.source_bframes && (
        <p className="mt-3 rounded-base border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700"
           data-testid="ai-card-bframes">
          ⚠ 源流含 B 帧：WebRTC 播放可能卡顿或花屏，建议在相机上关闭 B 帧
        </p>
      )}

      {stats.under_capacity && (
        <p className="mt-3 rounded-base border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700"
           data-testid="ai-card-under-capacity">
          ⚠ 处理速度未达到目标：实测 {stats.inference_fps_actual.toFixed(config.model.adapter === 'locateanything_trt' ? 3 : 1)} / 目标 {stats.inference_fps_target?.toFixed(config.model.adapter === 'locateanything_trt' ? 3 : 1)} FPS。
          请检查解码、帧映射和推理耗时；可降低推理帧率或减少并行通道数。
        </p>
      )}

      {config.publish.enabled && (() => {
        // running 只代表本地发布管线线程还活着，不代表真的在往 SRS 推流
        // 成功；旧版这里是写死的 "SEI ✓" 文案，任何断流都看不出来
        // （2026-09-09 复核：真实生产事故里 au_pushed 仍在正常递增、但
        // SRS 早已收不到流）。
        //
        // degraded 主要看 last_error_at 是否够新，不是看 reconnecting——
        // 复核发现 reconnecting（ReconnectStateMachine.needs_reconnect）
        // 在真实 RTMP-only 断流场景下几乎不可能被前端轮询采样到：
        // on_frame_received() 在"每次从 ES 队列拉到样本"时就会把
        // _reconnect_requested 清成 False，而 RTMP 断流期间本地拉流/推理
        // 完全正常、ES 样本一直在流动，这个清除动作跑在 do_reconnect()
        // 真正执行之前，reconnect_requested 为 true 的窗口只有毫秒级，
        // 前端几秒一次的轮询基本采样不到。last_error_at 才是持续存在、
        // 靠得住的信号，reconnecting 只作为补充（真的连 ES 都断流时会更
        // 持久地为 true）。
        const pub = stats.publish
        const RECENT_ERROR_WINDOW_S = 60
        const nowS = Date.now() / 1000
        const recentError = pub?.last_error_at != null && nowS - pub.last_error_at < RECENT_ERROR_WINDOW_S
        const degraded = !receiving || !pub || !pub.running || (recentError || pub.reconnecting)
        return (
          <p className={`mt-3 text-sm ${degraded ? 'text-danger' : 'text-ink-faint'}`}
             title={degraded && pub?.last_error ? `最近一次错误：${pub.last_error}` : undefined}>
            推流 {config.publish.effective_target_url.split('/').slice(-2).join('/')} ·{' '}
            {!receiving ? 'SEI 等待源视频恢复' : pub && !pub.running
              ? 'SEI ⚠ 输出已停止，请检查原因后重启通道' : degraded ? 'SEI ⚠ 推流异常，重连中' : 'SEI ✓'}
            {pub && !pub.running && pub.last_error?.includes('输出缓存容量不足') && (
              <span className="mt-1 block">等待识别结果所需的缓存超过设备容量，请降低源码率或更换模型后重启。</span>
            )}
          </p>
        )
      })()}

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onViewResult} className="rounded-base border border-line px-3.5 py-2 text-sm text-ink-subtle hover:bg-surface-page">
          <Eye size={14} className="mr-1 inline" aria-hidden />查看结果
        </button>
        <button
          type="button"
          onClick={onPreview}
          disabled={!config.publish.enabled}
          title={!config.publish.enabled ? '该通道未开启推流' : undefined}
          className="rounded-base border border-line px-3.5 py-2 text-sm text-ink-subtle hover:bg-surface-page disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play size={14} className="mr-1 inline" aria-hidden />播放衍生流
        </button>
      </div>
    </div>
  )
}
