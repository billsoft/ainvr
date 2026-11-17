/**
 * 录像通道选择对话框（2026-09-18）
 *
 * 需求：历史录像树下原「录像设置（配置中心）」入口改为「录像通道选择」，
 * 点击后在本对话框：
 * - 列出全部已登记通道（SRS 直播间 + 在线状态），勾选 = 该通道录像；
 * - 每个已启用通道配 24 小时 × 24 格的整点时间表，默认全选，可单选/多选/拖动
 *   连续选择 —— 决定一天里什么时候录像、什么时候不录；未启用的通道只占一行；
 * - 保存通过统一配置应用流程，只发布录像服务并等待应用回执。
 *
 * 版式与其他弹窗（新建通道向导）一致：固定头部、可滚动的内容区、固定底部操作栏，
 * 内容再多也只在中间滚动，头尾始终可见。
 *
 * 数据契约：RecorderChannel.scheduleEnabled/scheduleHours（recorder 微服务
 * /v1/recorder/channels 下发）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarClock, Check, Loader2, Video, X,
} from 'lucide-react'
import { useConfigApply } from '@/hooks/useConfigApply'
import { ConfigApplyOverlay } from '@/components/common/ConfigApplyOverlay'
import { configService } from '@/api/configService'
import { toast } from '@/store/toast'
import type { RecorderChannel } from '@/types/recording'
import { ALL_DAY_HOURS } from '@/types/recording'

interface Props {
  open: boolean
  channels: RecorderChannel[]
  onClose: () => void
  /** 保存（含发布）成功后回调：父组件刷新通道列表 */
  onSaved: () => void
}

interface Draft {
  enabled: boolean
  hours: number[]
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => i)

export function ChannelScheduleDialog({ open, channels, onClose, onSaved }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const applying = useConfigApply(open)
  const saving = applying.busy
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const expectedUpdatedAt = useRef<string | null>(null)
  const channelsRef = useRef(channels)
  channelsRef.current = channels
  /** 拖动连续选择：记录起点状态，划过即统一填涂/擦除 */
  const dragRef = useRef<{ channelId: string; fill: boolean } | null>(null)
  /** pointerdown 刚 toggle 的格（拦截随后 click 防二次翻转） */
  const lastPtrRef = useRef<{ channelId: string; hour: number } | null>(null)

  // 打开时从通道数据初始化草稿（新通道/缺计划默认全选；已有部分计划不覆盖）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const next: Record<string, Draft> = {}
    for (const c of channelsRef.current) {
      const enabled = c.scheduleEnabled ?? c.recording
      const hours = c.scheduleHours !== undefined
        ? c.scheduleHours
        : (enabled ? ALL_DAY_HOURS : [])
      next[c.id] = { enabled, hours: [...hours] }
    }
    setDrafts(next)
    setLoading(true)
    setLoadError('')
    void configService.listDocuments({ service: 'recorder', group: 'system' }).then((docs) => {
      if (cancelled) return
      const doc = docs.find((d) => d.name === 'settings')
      expectedUpdatedAt.current = doc?.updatedAt ?? null
      const config = doc?.config
      const saved = config?.channelSchedules as Record<string, Draft> | undefined
      if (saved) {
        for (const cid of Object.keys(next)) {
          const schedule = saved[cid]
          next[cid] = schedule
            ? { enabled: schedule.enabled ?? false, hours: [...(schedule.hours ?? ALL_DAY_HOURS)] }
            : { enabled: false, hours: [] }
        }
        setDrafts({ ...next })
      }
    }).catch(() => {
      if (!cancelled) setLoadError('无法读取已保存草稿，请关闭后重试，避免覆盖现有计划。')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    const stopDrag = () => { dragRef.current = null }
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    return () => {
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
    }
  }, [])

  const counts = useMemo(() => {
    let enabledCount = 0
    let onlineCount = 0
    for (const c of channels) {
      if (drafts[c.id]?.enabled) enabledCount += 1
      if (c.sourceOnline) onlineCount += 1
    }
    return { enabledCount, onlineCount }
  }, [channels, drafts])

  if (!open) return null

  const toggleHour = (cid: string, hour: number) => {
    setDrafts((prev) => {
      const cur = prev[cid] ?? { enabled: false, hours: [] }
      const has = cur.hours.includes(hour)
      return {
        ...prev,
        [cid]: { ...cur, hours: has ? cur.hours.filter((h) => h !== hour) : [...cur.hours, hour] },
      }
    })
  }

  const setHours = (cid: string, hours: number[]) => {
    setDrafts((prev) => ({
      ...prev,
      [cid]: { ...(prev[cid] ?? { enabled: false, hours: [] }), hours },
    }))
  }

  const toggleEnabled = (cid: string) => {
    setDrafts((prev) => {
      const cur = prev[cid] ?? { enabled: false, hours: [] }
      const enabled = !cur.enabled
      // 勾选启用时默认 24 小时全选（需求：默认全选）；取消勾选保留 hours 供重开
      const hours = enabled && cur.hours.length === 0 ? ALL_DAY_HOURS : cur.hours
      return { ...prev, [cid]: { enabled, hours } }
    })
  }

  async function doSave() {
    dragRef.current = null
    try {
      const schedules: Record<string, { enabled: boolean; hours: number[] }> = {}
      for (const [cid, d] of Object.entries(drafts)) {
        schedules[cid] = { enabled: d.enabled, hours: [...d.hours].sort((a, b) => a - b) }
      }
      await applying.apply([{ service: 'recorder', group: 'system', name: 'settings', expectedUpdatedAt: expectedUpdatedAt.current, config: { channelSchedules: schedules } }])
      toast.success('录像计划已保存并应用')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败，请重试')
    }
  }

  const locked = loading || !!loadError || saving

  return (
    <>
    <ConfigApplyOverlay busy={saving} stage={applying.stage} remaining={applying.remaining} />
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="录像通道选择"
    >
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[920px] flex-col overflow-hidden rounded-panel bg-surface shadow-modal sm:max-h-[calc(100dvh-3rem)]">
        {/* 头部：固定 */}
        <div className="shrink-0 border-b border-line px-4 pb-4 pt-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-ink">
              <CalendarClock size={18} className="shrink-0 text-primary" aria-hidden />
              录像通道选择
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-faint hover:bg-surface-page hover:text-ink disabled:opacity-50"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-subtle">
            勾选要录像的通道；每个通道可点选 24 个小时格（可拖动连续选择），
            决定一天里什么时候录像。默认 24 小时全选。共 {channels.length} 个通道
            （{counts.enabledCount} 个启用录像，{counts.onlineCount} 个在线）。
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-success/90" />录制时段</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-line/60" />不录</span>
            <span>按录像服务器本地时间执行</span>
          </p>
          {loading && <p className="mt-2 text-sm text-ink-subtle">正在读取已保存计划…</p>}
          {applying.outcome && <p role="status" className="mt-2 text-sm text-ink-subtle">{applying.outcome}</p>}
          {loadError && <p role="alert" className="mt-2 text-sm text-danger">{loadError}</p>}
        </div>

        {/* 内容：唯一滚动区。fieldset 放在滚动区里面，不能直接当 flex 子项（它不会按剩余高度收缩）。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6" data-testid="schedule-scroll">
          <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
          {channels.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-ink-faint">
              暂无通道（接入通道未登记，请先到「接入管理」添加）
            </div>
          ) : (
            <ul className="space-y-3">
              {channels.map((c) => {
                const d = drafts[c.id] ?? { enabled: false, hours: [] }
                const selectedCount = d.hours.length
                return (
                  <li
                    key={c.id}
                    data-testid={`schedule-row-${c.id}`}
                    className={`rounded-card border p-3 transition-colors ${
                      d.enabled
                        ? 'border-primary/40 bg-primary/[0.03]'
                        : 'border-line bg-surface-page/50'
                    }`}
                  >
                    {/* 一行搞定：勾选 + 名称 + 24 小时紧凑条 + 已选小时数 + 全选/清空。窄屏时紧凑条自动换到下一行。 */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={d.enabled}
                        data-testid={`schedule-toggle-${c.id}`}
                        onClick={() => toggleEnabled(c.id)}
                        className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center"
                        aria-label={`${c.name} 录像开关`}
                      >
                        <span
                          className={`flex h-6 w-6 items-center justify-center rounded border transition-colors ${
                            d.enabled
                              ? 'border-primary bg-primary text-white'
                              : 'border-line bg-surface text-transparent'
                          }`}
                        >
                          <Check size={14} strokeWidth={3} />
                        </span>
                      </button>
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          c.sourceOnline ? 'bg-success' : 'bg-ink-faint/50'
                        }`}
                        title={c.sourceOnline ? '在线' : '离线'}
                      />
                      <span className="flex w-40 shrink-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-sm font-medium text-ink" title={c.name}>{c.name}</span>
                        {c.codec === 'h265' && (
                          <span className="shrink-0 rounded bg-surface-page px-1.5 py-0.5 font-mono text-xs text-ink-subtle" data-testid={`schedule-codec-${c.id}`}>
                            H.265
                          </span>
                        )}
                        {c.kind === 'ai' && (
                          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                            AI
                          </span>
                        )}
                      </span>

                      {/* 24 小时紧凑条：只有启用录像的通道才显示 */}
                      {d.enabled ? (
                        <div className="min-w-[300px] flex-1">
                          <div className="flex gap-0.5">
                            {HOUR_LABELS.map((h) => {
                              const on = d.hours.includes(h)
                              return (
                                <button
                                  key={h}
                                  type="button"
                                  data-testid={`hour-${c.id}-${h}`}
                                  data-hour={h}
                                  data-on={on}
                                  onPointerDown={() => {
                                    if (locked) return
                                    // 拖动起点：记录要填充的状态并立即 toggle 起点格；
                                    // 随后 click 会被 lastPtrRef 拦截避免二次翻转
                                    dragRef.current = { channelId: c.id, fill: !on }
                                    lastPtrRef.current = { channelId: c.id, hour: h }
                                    toggleHour(c.id, h)
                                  }}
                                  onClick={() => {
                                    // jsdom fireEvent.click 不触发 pointerdown 的兜底；
                                    // 真实浏览器 pointerdown 已 toggle，这里必须跳过
                                    if (
                                      lastPtrRef.current?.channelId === c.id
                                      && lastPtrRef.current.hour === h
                                    ) {
                                      lastPtrRef.current = null
                                      return
                                    }
                                    toggleHour(c.id, h)
                                  }}
                                  onPointerEnter={() => {
                                    if (locked || !dragRef.current || dragRef.current.channelId !== c.id) return
                                    setDrafts((prev) => {
                                      const cur = prev[c.id] ?? { enabled: false, hours: [] }
                                      const nextHours = dragRef.current!.fill
                                        ? Array.from(new Set([...cur.hours, h]))
                                        : cur.hours.filter((x) => x !== h)
                                      return { ...prev, [c.id]: { ...cur, hours: nextHours } }
                                    })
                                  }}
                                  onPointerUp={() => { dragRef.current = null }}
                                  className={`h-7 min-w-0 flex-1 rounded-sm transition-colors ${
                                    on
                                      ? 'bg-success/90 hover:bg-success'
                                      : 'bg-line/60 hover:bg-line'
                                  }`}
                                  title={`${h}:00-${h}:59${on ? '（录制）' : ''}`}
                                  aria-label={`${c.name} ${h} 点${on ? '录制' : '不录'}`}
                                />
                              )
                            })}
                          </div>
                          {/* 刻度只标 0 / 6 / 12 / 18 点，不占一整行 */}
                          <div className="mt-0.5 flex gap-0.5" aria-hidden>
                            {HOUR_LABELS.map((h) => (
                              <div key={h} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-left text-xs leading-4 tabular-nums text-ink-subtle">
                                {h % 6 === 0 ? h : ''}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <span className="min-w-0 flex-1" />
                      )}

                      <span className="shrink-0 text-xs text-ink-subtle">
                        {d.enabled ? `已选 ${selectedCount}/24 小时` : '未启用录像'}
                      </span>
                      {d.enabled && (
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => setHours(c.id, ALL_DAY_HOURS)}
                            className="btn-secondary min-h-11 px-3 text-xs"
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            onClick={() => setHours(c.id, [])}
                            className="btn-secondary min-h-11 px-3 text-xs"
                          >
                            清空
                          </button>
                        </div>
                      )}
                    </div>

                    {(c.recordingState === 'codec_error' || c.codecWarning) && (
                      <p
                        className={`mt-1 text-xs ${c.recordingState === 'codec_error' ? 'text-danger' : 'text-warning-700'}`}
                        data-testid={`schedule-codec-warning-${c.id}`}
                      >
                        {c.recordingDetail}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          </fieldset>
        </div>

        {/* 底部操作：固定 */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-6">
          <p className="min-w-0 flex-1 text-xs leading-5 text-ink-subtle">
            保存后自动应用录像计划；通道离线或存储异常时不会录制，不影响其他服务配置。
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-secondary min-h-11"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void doSave()}
            disabled={locked}
            data-testid="schedule-save"
            className="btn-primary min-h-11"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Video size={16} />}
            保存并应用
          </button>
        </div>
      </div>
    </div>
    </>
  )
}
