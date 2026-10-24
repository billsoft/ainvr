import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ScanFace, AlertTriangle, Video } from 'lucide-react'
import { useAiChannelsStore } from '@/store/aiChannels'
import { useChannelsStore } from '@/store/channels'
import { channelService } from '@/api/channelService'
import type { ChannelWithStatus } from '@/types/channel'
import { sourceAvailability, aiPresentationState } from '@/features/aiSourceState'
import { usePolling } from '@/hooks/usePolling'
import { useSettingsStore } from '@/store/settings'
import { aiChannelService } from '@/api/aiChannelService'
import { isAiChannelOf } from '@/utils/channelMatching'
import { getAiModelDisplayName } from '@/types/aiChannel'
import { toast } from '@/store/toast'
import { useAiServiceCapabilities } from '@/hooks/useAiServiceCapabilities'
import { Toaster } from '@/components/ui/Toaster'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { AiChannelWizard } from './AiChannelWizard'
import { AiChannelCard } from './AiChannelCard'
import { AiResultModal } from './AiResultModal'
import { AiPreviewModal } from './AiPreviewModal'
import type { AiChannel, AiChannelCreatePatch, AiChannelUpdatePatch, AiFrameResult, AiStreamOption } from '@/types/aiChannel'

export default function AiChannelsPage() {
  const { channels, loading, serviceUnreachable, fetchChannels, checkHealth, createChannel, updateChannel, deleteChannel, startChannel, stopChannel } = useAiChannelsStore()
  const pollIntervalMs = useSettingsStore((s) => s.settings?.aiService.pollIntervalMs ?? 5000)

  const [wizardOpen, setWizardOpen] = useState(false)
  const aiCapabilities = useAiServiceCapabilities(wizardOpen)
  const [editing, setEditing] = useState<AiChannel | null>(null)
  const [deleting, setDeleting] = useState<AiChannel | null>(null)
  const [viewingResult, setViewingResult] = useState<AiChannel | null>(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [resultData, setResultData] = useState<AiFrameResult | null>(null)
  const [previewing, setPreviewing] = useState<AiChannel | null>(null)
  const [streams, setStreams] = useState<AiStreamOption[]>([])
  const [streamsLoading, setStreamsLoading] = useState(false)
  const [streamsReady, setStreamsReady] = useState(false)
  const [streamsError, setStreamsError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [sourceSnapshot, setSourceSnapshot] = useState<{ channels: ChannelWithStatus[]; checkedAt: number }>({ channels: [], checkedAt: 0 })
  // Independent unfiltered snapshot: access-management search must not hide a source.
  usePolling(async () => {
    try {
      const channels = await channelService.list()
      setSourceSnapshot({ channels, checkedAt: Date.now() })
    } catch {
      setSourceSnapshot({ channels: [], checkedAt: 0 })
    }
  }, 5000)
  const availability = (ch: AiChannel) => serviceUnreachable ? 'unknown' as const :
    sourceAvailability(ch, sourceSnapshot.channels, sourceSnapshot.checkedAt)

  // 筛选器状态
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [modelFilter, setModelFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  // SRS 通道列表（用于匹配源通道）
  const srsChannels = useChannelsStore((s) => s.channels)
  const srsLoading = useChannelsStore((s) => s.loading)
  const fetchSrsChannels = useChannelsStore((s) => s.fetchChannels)

  useEffect(() => {
    void useSettingsStore.getState().fetchSettings()
    void fetchChannels()
    void fetchSrsChannels()
  }, [fetchChannels, fetchSrsChannels])

  // 通道列表轮询（间隔从系统设置的 aiService.pollIntervalMs 读，页面不可见时暂停）。
  // isFailing 读 store 的 serviceUnreachable——服务持续不可达时自动退避轮询
  // 间隔，不用恒定频率一直打一个已知连不上的接口（审计发现 P1-3）。
  usePolling(() => fetchChannels(), pollIntervalMs, true, {
    isFailing: () => useAiChannelsStore.getState().serviceUnreachable,
  })
  // 健康探测独立走 30s（架构 §11.3.2），比列表轮询慢，用于横幅判断
  usePolling(() => checkHealth(), 30000, true, {
    isFailing: () => useAiChannelsStore.getState().serviceUnreachable,
  })

  async function refreshStreams() {
    setStreamsLoading(true)
    setStreamsError(null)
    try {
      const result = await aiChannelService.listStreams()
      if (!Array.isArray(result)) throw new Error('在线流状态响应格式错误')
      setStreams(result)
      setStreamsReady(true)
    } catch (error) {
      setStreamsReady(false)
      setStreamsError('暂时无法获取在线状态，请刷新重试。已配置的通道仍可选择。')
      console.warn('AINVR 在线流状态获取失败', error instanceof Error ? error.message : '未知错误')
    } finally {
      setStreamsLoading(false)
    }
  }



  function closeWizard() {
    setWizardOpen(false)
    setEditing(null)
  }

  async function handleWizardSubmit(patch: AiChannelCreatePatch | AiChannelUpdatePatch) {
    setSubmitting(true)
    try {
      if (editing) {
        const result = await updateChannel(editing.id, patch as AiChannelUpdatePatch)
        if (result.channel.config.manually_stopped || result.restart?.status === 'idle') {
          toast.success('配置已保存；识别保持停止')
        } else if (result.applied_via === 'restart') {
          toast.success(`已保存：通道因 ${result.restart?.reason ?? '结构参数变更'} 重启（${result.restart?.status === 'failed' ? '失败，请检查通道状态' : '成功'}）`)
        } else {
          toast.success('已保存并即时生效')
        }
      } else {
        await createChannel(patch as AiChannelCreatePatch)
        toast.success('AI 通道已创建')
      }
      closeWizard()
    } catch (e: any) {
      toast.error(e?.message || '保存失败')
      throw e // 让向导内部也能展示错误（弱映射到当前步骤）
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirmDelete() {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteChannel(deleting.id)
      toast.success(`通道「${deleting.name}」及其识别历史已删除`)
      setDeleting(null)
    } catch (e: any) {
      toast.error(e?.message || '删除失败')
      void fetchChannels()
    } finally {
      setDeleteBusy(false)
    }
  }

  // 每个 AI 通道匹配到的源通道名
  // SRS 通道加载中时不计算，避免闪"未配置源"的误报
  const sourceChannelMap = useMemo(() => {
    if (srsLoading) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const ai of channels) {
      const matched = srsChannels.find((ch) => isAiChannelOf(ai, ch))
      if (matched) map.set(ai.id, matched.name)
    }
    return map
  }, [channels, srsChannels, srsLoading])

  // 收集源通道名列表（用于下拉筛选）
  const sourceChannelNames = useMemo(() => {
    const names = new Set<string>()
    for (const ai of channels) {
      const name = sourceChannelMap.get(ai.id)
      if (name) names.add(name)
    }
    return Array.from(names).sort()
  }, [channels, sourceChannelMap])

  // 收集模型列表（用于下拉筛选）：值是实际模型名，显示任务名（界面不暴露模型/框架名）
  const modelCategories = useMemo(() => {
    const cats = new Map<string, string>()
    for (const ai of channels) {
      cats.set(ai.config.model.name, getAiModelDisplayName(ai.config.model))
    }
    return Array.from(cats, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  }, [channels])

  // 状态筛选的文案映射
  const STATUS_OPTIONS = [
    { value: 'all', label: '全部' },
    { value: 'running', label: '运行中' },
    { value: 'idle', label: '已停止' },
    { value: 'waiting-source', label: '等待源视频' },
    { value: 'starting', label: '启动中' },
    { value: 'reconnecting', label: '重连中' },
    { value: 'error', label: '异常' },
    { value: 'no_source', label: '未配置源' },
  ]

  // 过滤后的通道列表
  const filteredChannels = useMemo(() => {
    return channels.filter((ch) => {
      // 状态筛选
      if (statusFilter === 'no_source') {
        if (sourceChannelMap.has(ch.id)) return false
      } else if (statusFilter !== 'all') {
        if (aiPresentationState(ch, availability(ch)) !== statusFilter) return false
      }

      // 模型筛选
      if (modelFilter !== 'all') {
        if (ch.config.model.name !== modelFilter) return false
      }

      // 源通道筛选
      if (sourceFilter !== 'all') {
        if (sourceChannelMap.get(ch.id) !== sourceFilter) return false
      }

      return true
    })
  }, [channels, statusFilter, modelFilter, sourceFilter, sourceChannelMap, sourceSnapshot, serviceUnreachable])

  // 请求发起时记下这次是给哪个通道查的；响应回来时比对是否还是"当前
  // 正在等的那一次"，不一致就丢弃——防止快速切换查看目标（A 还没返回就
  // 点开 B）时，A 的迟到响应盖掉 B 已经打开的弹窗内容。
  const viewResultRequestIdRef = useRef(0)

  async function handleViewResult(ch: AiChannel) {
    const requestId = ++viewResultRequestIdRef.current
    setViewingResult(ch)
    setResultLoading(true)
    setResultData(null)
    try {
      const { result } = await aiChannelService.latestResult(ch.id)
      if (viewResultRequestIdRef.current !== requestId) return
      setResultData(result)
    } catch {
      if (viewResultRequestIdRef.current !== requestId) return
      setResultData(null)
    } finally {
      if (viewResultRequestIdRef.current === requestId) setResultLoading(false)
    }
  }

  return (
    <section aria-labelledby="ai-channels-title" className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 id="ai-channels-title" className="text-lg font-semibold text-ink">AI 通道</h2>
          <p className="mt-0.5 text-sm text-ink-subtle">
            共 {channels.length} 个通道，{channels.filter((c) => c.state === 'running').length} 个运行中
          </p>
        </div>
        <button
          type="button"
          disabled={serviceUnreachable}
          onClick={() => { setEditing(null); setWizardOpen(true) }}
          className="flex items-center gap-1.5 rounded-base bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-card transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="btn-new-ai-channel"
        >
          <Plus size={16} aria-hidden /> 新建 AI 通道
        </button>
      </div>

      {serviceUnreachable && (
        <div className="mt-4 flex items-center justify-between rounded-base border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700">
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} aria-hidden /> AI 服务不可达，以下为上次数据（只读）
          </span>
          <Link to="/config-center?category=ai-service" className="font-medium underline">去配置中心</Link>
        </div>
      )}

      <div className="mt-4">
        {loading && channels.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle">加载中…</p>
        ) : channels.length === 0 ? (
          <EmptyState
            icon={ScanFace}
            title="还没有 AI 通道"
            description={
              serviceUnreachable
                ? 'AI 服务不可达，请先到配置中心配置 AI 服务连接'
                : '先去接入管理添加视频源，再创建第一个 AI 通道开始检测'
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {!serviceUnreachable && (
                  <Link to="/channels" className="rounded-base border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-page">
                    <Video size={14} className="mr-1 inline" aria-hidden />去接入管理
                  </Link>
                )}
                {!serviceUnreachable && (
                  <button type="button" onClick={() => setWizardOpen(true)} className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-600">
                    创建第一个 AI 通道
                  </button>
                )}
                {serviceUnreachable && (
                  <Link to="/config-center?category=ai-service" className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-600">
                    去配置中心配置
                  </Link>
                )}
              </div>
            }
          />
        ) : (
          <>
            {/* 筛选器行 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-base border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-primary"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                className="rounded-base border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="all">全部模型</option>
                {modelCategories.map((cat) => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </select>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded-base border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="all">全部源通道</option>
                {sourceChannelNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <span className="ml-auto text-xs text-ink-faint">
                显示 {filteredChannels.length} / {channels.length} 个
              </span>
            </div>
            {filteredChannels.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-subtle">没有匹配的通道</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {filteredChannels.map((ch) => (
                  <AiChannelCard
                    key={ch.id}
                    channel={ch}
                    disabled={serviceUnreachable}
                    sourceChannelName={sourceChannelMap.get(ch.id)}
                    sourceAvailability={availability(ch)}
                    onStart={() => startChannel(ch.id).catch((e) => toast.error(e?.message || '启动失败'))}
                    onStop={() => stopChannel(ch.id).catch((e) => toast.error(e?.message || '停止失败'))}
                    onEdit={() => { setEditing(ch); setWizardOpen(true) }}
                    onDelete={() => setDeleting(ch)}
                    onViewResult={() => handleViewResult(ch)}
                    onPreview={() => setPreviewing(ch)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <AiChannelWizard
        open={wizardOpen}
        mode={editing ? 'edit' : 'create'}
        initial={editing}
        submitting={submitting}
        streams={streams}
        streamsLoading={streamsLoading}
        streamsReady={streamsReady}
        streamsError={streamsError}
        srsChannels={srsChannels}
        aiChannels={channels}
        onRefreshStreams={refreshStreams}
                onClose={closeWizard}
        onSubmit={handleWizardSubmit}
        aiCapabilities={aiCapabilities}
      />

      <ConfirmDialog
        open={deleting != null}
        title="删除 AI 通道"
        content="将停止该通道的识别及衍生推流，并永久删除该通道的全部识别历史和截图。原始接入通道及录像不会删除。需要保留历史，请取消并停止通道。删除未完成时会保留通道入口供重试。"
        confirmText={deleteBusy ? '正在停止识别并清理历史…' : '删除通道及识别历史'}
        busy={deleteBusy}
        autoClose={false}
        danger
        requireText={deleting?.name}
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleting(null)}
      />

      {viewingResult && (
        <AiResultModal
          channelName={viewingResult.name}
          loading={resultLoading}
          result={resultData}
          onClose={() => setViewingResult(null)}
        />
      )}

      {previewing && (
        <AiPreviewModal
          channelId={previewing.id}
          channelName={previewing.name}
          effectiveTargetUrl={previewing.config.publish.effective_target_url}
          videoCodec={previewing.stats.publish?.codec ?? previewing.stats.video_codec}
          onClose={() => setPreviewing(null)}
        />
      )}

      <Toaster />
    </section>
  )
}
