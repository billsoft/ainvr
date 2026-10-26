import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type {GBBinding} from './gbTypes'
import {request} from '@/api/httpClient'
import { Plus, Search, Video } from 'lucide-react'
import { CopyButton } from '@/components/common/CopyButton'
import { EmptyState } from '@/components/common/EmptyState'
import { SkeletonRow } from '@/components/ui/Skeleton'
import { ChannelWizard } from './ChannelWizard'
import { ChannelTable, type ChannelPipelineStatus, type PipelineState } from './ChannelTable'
import { recordingBadge } from './recordingBadge'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { Toaster } from '@/components/ui/Toaster'
import { toast } from '@/store/toast'
import { useChannelsStore } from '@/store/channels'
import { useAiChannelsStore } from '@/store/aiChannels'
import { buildPushUrl } from '@/utils/format'
import type { ChannelCreateInput } from '@/api/channelService'
import type { ChannelWithStatus } from '@/types/channel'
import type { AiChannel } from '@/types/aiChannel'
import type { RecorderChannel } from '@/types/recording'
import { recordingService } from '@/api/recordingService'
import { parseStreamPath } from '@/utils/channelMatching'
import { channelAddressChangeNotice, channelDeleteNotice } from '@/features/saveImpact'

const PAGE_SIZE = 10
const clip = 'overflow-hidden text-ellipsis whitespace-nowrap'

function aiPipeline(jobs: AiChannel[], output: boolean): PipelineState {
  const detail = jobs.map(job => job.name).join('、')
  const to = '/ai-channels'
  if (!jobs.length) return { label: '未启用', tone: 'muted', to }
  if (jobs.some(job => job.state === 'error')) return { label: '识别错误', tone: 'danger', detail, to }
  if (jobs.some(job => job.state === 'running')) return { label: output ? '输出运行中' : '运行中', tone: 'success', detail, to }
  if (jobs.some(job => ['starting', 'stopping', 'reconnecting'].includes(job.state))) return { label: '状态切换中', tone: 'warning', detail, to }
  if (jobs.some(job => job.config.enabled)) return { label: '等待运行', tone: 'warning', detail, to }
  return { label: '已停用', tone: 'muted', detail, to }
}

/** 通道列表页（首页，DEV_PLAN 用例 2） */
export default function ChannelsPage() {
  const navigate = useNavigate()
  const {
    channels,
    loading,
    error,
    search,
    setSearch,
    fetchChannels,
    createChannel,
    updateChannel,
    deleteChannel,
  } = useChannelsStore()

  const wizardOpener=useRef<HTMLElement|null>(null)
  const [editingGB,setEditingGB]=useState<GBBinding|undefined>()
  const [gbRefresh,setGbRefresh]=useState(0)
  const [gbBindings,setGbBindings]=useState<GBBinding[]>([])
  const [gbError,setGbError]=useState('')
  const refreshGB=useCallback(async()=>{try{const r=await request<{items:GBBinding[]}>('/gb28181/bindings');setGbBindings(r.items);setGbError('')}catch{setGbError('国标来源信息暂不可用，普通通道仍可编辑；国标通道请重试后编辑')}} ,[])
  useEffect(()=>{void refreshGB()},[refreshGB])
  useEffect(()=>{if(!gbRefresh)return;let runs=0;const timer=setInterval(()=>{void refreshGB();void fetchChannels();if(++runs>=10)clearInterval(timer)},2000);return()=>clearInterval(timer)},[gbRefresh,refreshGB,fetchChannels])
  const [page, setPage] = useState(1)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<ChannelWithStatus | null>(null)
  const [deleting, setDeleting] = useState<ChannelWithStatus | null>(null)
  // 修改应用名/流名需先确认影响（推流端与引用它的 AI 通道都不会自动跟随）
  const [pendingEdit, setPendingEdit] = useState<{ input: ChannelCreateInput; notice: string } | null>(null)
  const [created, setCreated] = useState<ChannelWithStatus | null>(null)
  const [recorderChannels, setRecorderChannels] = useState<RecorderChannel[]>([])
  const [recorderUnavailable, setRecorderUnavailable] = useState(false)
  const host = window.location.hostname

  const fetchAiChannels = useAiChannelsStore((s) => s.fetchChannels)
  const aiChannels = useAiChannelsStore((s) => s.channels)
  const aiUnavailable = useAiChannelsStore((s) => s.serviceUnreachable)

  useEffect(() => {
    void fetchChannels()
    void fetchAiChannels()
  }, [fetchChannels, fetchAiChannels, search])
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!document.hidden) {
        try { const list = await recordingService.listChannels(); if (!cancelled) { setRecorderChannels(list); setRecorderUnavailable(false) } }
        catch { if (!cancelled) setRecorderUnavailable(true) }
      }
      if (!cancelled) timer = setTimeout(poll, 10000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  const pipeline = useMemo<Record<string, ChannelPipelineStatus>>(() => Object.fromEntries(channels.map(channel => {
    const recorder = recorderChannels.find(item => item.id === channel.id || item.streamName === channel.upstream.stream)
    const recording = recordingBadge(recorder, recorderUnavailable)

    const sourceJobs = aiChannels.filter(job => {
      const source = parseStreamPath(job.config.stream.url)
      return source?.app === channel.upstream.app && source.stream === channel.upstream.stream
    })
    const outputJobs = aiChannels.filter(job => {
      const output = parseStreamPath(job.config.publish.effective_target_url)
      return output?.app === channel.upstream.app && output.stream === channel.upstream.stream
    })
    const jobs = sourceJobs.length ? sourceJobs : outputJobs
    const ai = aiUnavailable
      ? { label: '状态未知', tone: 'danger', detail: 'AI 服务不可达', to: '/dashboard?tab=logs&source=ai-service' } as PipelineState
      : aiPipeline(jobs, !sourceJobs.length && !!outputJobs.length)
    return [channel.id, { recording, ai }]
  })), [channels, recorderChannels, recorderUnavailable, aiChannels, aiUnavailable])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return channels
    return channels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q) ||
        c.upstream.stream.toLowerCase().includes(q),
    )
  }, [channels, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => {
    if (page > totalPages) setPage(1)
  }, [page, totalPages])

  const closeWizard = useCallback(() => {
    setWizardOpen(false)
    setEditing(null)
    requestAnimationFrame(()=>wizardOpener.current?.focus())
  }, [])

  function pushUrlOf(ch: ChannelWithStatus): string | null {
    if (ch.upstream.protocol === 'rtsp') return null
    // 优先用后端按当前系统设置（协议主机名覆盖）算好的地址；没有就退回本地计算
    return (
      ch.urls?.push?.[ch.upstream.protocol] ??
      buildPushUrl(ch.upstream.protocol, {
        host,
        app: ch.upstream.app,
        stream: ch.upstream.stream,
      })
    )
  }

  async function handleSubmit(input: ChannelCreateInput, addressConfirmed = false) {
    try {
      if (editing) {
        const notice = channelAddressChangeNotice(editing, input, aiChannels)
        if (notice && !addressConfirmed) {
          setPendingEdit({ input, notice })
          return
        }
        await updateChannel(editing.id, input)
        toast.success('通道已更新')
        if (notice) {
          // DEV_PLAN 用例4要求：地址变更后需要提醒用户同步修改推流端配置
          toast.info('注意：推流地址已变更，推流端需要重新配置')
        }
      } else {
        const ch = await createChannel(input)
        setCreated(ch)
        toast.success(`通道「${ch.name}」已创建`)
      }
      closeWizard()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  async function handleConfirmDelete() {
    if (!deleting) return
    try {
      await deleteChannel(deleting.id)
      toast.success(`通道「${deleting.name}」已删除`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <section aria-labelledby="channels-title" className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="channels-title" className="page-title">
            接入管理
          </h2>
          <p className="page-description">
            集中查看视频源、录像与 AI 识别状态；共 {channels.length} 个通道，
            {channels.filter((c) => c.status.online).length} 个在线
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            wizardOpener.current=document.activeElement as HTMLElement
            setEditingGB(undefined)
            setEditing(null)
            setWizardOpen(true)
          }}
          className="flex items-center gap-1.5 rounded-base bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-card transition-colors hover:bg-primary-600"
          data-testid="btn-new-channel"
        >
          <Plus size={16} aria-hidden /> 新建通道
        </button>
      </div>

      {gbError&&<p role="alert" className="mt-3 text-sm text-danger">{gbError}<button className="ml-2 text-primary" onClick={()=>void refreshGB()}>重试</button></p>}
      <div className="relative mt-4 max-w-md">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="搜索名称、备注或流名…"
          className="w-full rounded-base border border-line bg-surface py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
          data-testid="channel-search"
        />
      </div>

      {error && (
        <p className="mt-4 rounded-base border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-4">
        {loading && channels.length === 0 ? (
          <div className="rounded-panel border border-line bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-4 border-b border-line pb-2 text-xs font-medium text-ink-faint">
              <span className="flex-1">通道名称</span>
              <span className="w-20">流名</span>
              <span className="w-20">协议</span>
              <span className="w-20">状态</span>
              <span className="w-24 text-right">操作</span>
            </div>
            {[...Array(5)].map((_, i) => (
              <SkeletonRow key={i} cols={5} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          search.trim() ? (
            <EmptyState
              icon={Search}
              title="没有找到匹配的通道"
              description={`关键词「${search.trim()}」无结果`}
              action={
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface"
                >
                  清空搜索
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={Video}
              title="还没有通道"
              description="创建第一个通道，获取推流地址开始使用"
              action={
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
                >
                  创建第一个通道
                </button>
              }
            />
          )
        ) : (
          <>
            <ChannelTable
              rows={pageRows}
              gbInputIds={gbBindings.map(b=>b.input_id)}
              pipeline={pipeline}
              host={host}
              onPreview={(ch) => navigate(`/channels/${ch.id}`)}
              onCopyPush={(ch) => {
                const url = pushUrlOf(ch)
                if (!url) {
                  toast.info('RTSP 来源由系统自动拉流，无需推流地址')
                  return
                }
                const write = navigator.clipboard?.writeText(url)
                if (write) {
                  write.then(
                    () => toast.success('推流地址已复制'),
                    () => toast.error('复制失败，请手动复制'),
                  )
                } else {
                  toast.info(`推流地址：${url}`)
                }
              }}
              onEdit={async(ch) => {
                wizardOpener.current=document.activeElement as HTMLElement
                let binding=gbBindings.find(b=>b.input_id===ch.id)
                try{
                  const latest=await request<{items:GBBinding[]}>('/gb28181/bindings')
                  setGbBindings(latest.items);setGbError('');binding=latest.items.find(b=>b.input_id===ch.id)
                }catch{
                  if(binding){toast.error('国标配置暂不可用，请恢复后重试编辑');return}
                }
                setEditingGB(binding)
                setEditing(ch)
                setWizardOpen(true)
              }}
              onDelete={(ch) => setDeleting(ch)}
            />
            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-end gap-2 text-sm text-ink-subtle">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-base border border-line px-3 py-1.5 disabled:opacity-40"
                >
                  上一页
                </button>
                <span>
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-base border border-line px-3 py-1.5 disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <ChannelWizard
        open={wizardOpen}
        mode={editing ? 'edit' : 'create'}
        initial={editing}
        onOnvifSaved={()=>{closeWizard();void fetchChannels();toast.success('ONVIF 通道配置已保存，将持续接入所选音视频码流')}}
        gbBinding={editingGB}
        onGBSaved={()=>{closeWizard();setGbRefresh(n=>n+1);void refreshGB();void fetchChannels();toast.success('国标接入配置已保存，视频通道将在网关应用后自动更新')}}
        onClose={closeWizard}
        onSubmit={handleSubmit}
      />

      {/* 删除确认：输入通道名防误删（DEV_PLAN 用例 4） */}
      <ConfirmDialog
        open={deleting != null}
        title="删除通道"
        content={deleting ? channelDeleteNotice(deleting, aiChannels) : ''}
        confirmText="删除"
        danger
        requireText={deleting?.name}
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={pendingEdit != null}
        title="确认修改推流地址"
        content={pendingEdit?.notice ?? ''}
        confirmText="确认修改"
        danger
        onConfirm={() => { const p = pendingEdit; setPendingEdit(null); if (p) void handleSubmit(p.input, true) }}
        onClose={() => setPendingEdit(null)}
      />

      {/* 创建成功：立即给推流地址（DEV_PLAN 用例 1 第 ③ 步） */}
      {created && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-label="创建成功"
        >
          <div className="w-[480px] rounded-panel bg-surface p-6 shadow-modal">
            <h3 className="text-base font-semibold text-ink">通道「{created.name}」已创建</h3>
            <p className="mt-1 text-sm text-ink-subtle">复制推流地址配置到摄像头 / OBS：</p>
            <div className="mt-3 flex items-center gap-2 rounded-base bg-surface-page px-3 py-2.5">
              <code
                className={`min-w-0 flex-1 font-mono text-xs text-ink ${clip}`}
                data-testid="created-push-url"
              >
                {pushUrlOf(created) ?? '（RTSP 来源无需推流地址）'}
              </code>
              {pushUrlOf(created) && <CopyButton value={pushUrlOf(created)!} />}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreated(null)
                  navigate(`/channels/${created.id}`)
                }}
                className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
              >
                查看详情
              </button>
              <button
                type="button"
                onClick={() => setCreated(null)}
                className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
                data-testid="created-done"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster />
    </section>
  )
}
