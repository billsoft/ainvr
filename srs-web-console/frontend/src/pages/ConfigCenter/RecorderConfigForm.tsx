/**
 * 配置中心 · recorder/system/settings 专用表单（C7，2026-09-15）
 *
 * 替代通用 FormEditor 的裸 JSON：覆盖 recorder 配置的字段集
 * （storage/quota/files；原回放页设置弹窗已下线，统一由配置中心编辑），
 * 约束更严格（评审定稿）：
 * - 提交只生成白名单字段，且保留 config 顶层其他键（不丢 ${secret:...} 引用）
 * - storage.smb.password：值为 ${secret:...} 占位符时原样保留（引用不丢）；
 *   明文残留一律剔除，不允许经普通文档回写；SMB 密码的设置/清除走
 *   /api/v1/config/secrets 端点，本表单只读展示 passwordSet
 * - 深度校验由 recorder 服务拉取后自己做（pydantic），这里保证形状合法
 *
 * 2026-09-18（5分类改版）：从"父组件统一暂存+统一保存按钮"改成本组件
 * 自带保存按钮，直接调 onSavePartial——录像相关字段只有这一个页面在管，
 * 不存在跟别的分类页抢同一份文档的问题，整份覆盖安全。
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, ChevronRight } from 'lucide-react'
import { toast } from '@/store/toast'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { recorderSaveImpacts, type RecorderDraft } from '@/features/saveImpact'
import type { ConfigDocument } from '@/api/configService'
import type { RecorderConfig, SmbVersion } from '@/types/recording'

interface Props {
  recorderDoc: ConfigDocument | undefined
  onSavePartial: (
    service: string, group: string, name: string,
    overrides: Record<string, unknown>, description?: string,
  ) => Promise<void>
}

const SMB_VERSIONS = ['auto', '3.0', '2.1'] as const

function isSecretRef(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('${secret:')
}

/** 从任意 config 提取形状合法的 RecorderConfig（缺失字段给默认值） */
function extract(config: Record<string, unknown>): RecorderConfig {
  const storage = (config.storage ?? {}) as Partial<RecorderConfig['storage']>
  const quota = (config.quota ?? {}) as Partial<RecorderConfig['quota']>
  const files = (config.files ?? {}) as Partial<RecorderConfig['files']>
  const smb = (storage.smb ?? null) as RecorderConfig['storage']['smb']
  return {
    storage: {
      kind: storage.kind === 'smb' ? 'smb' : 'local',
      localPath: storage.localPath ?? '',
      smb: smb
        ? {
            host: smb.host ?? '',
            share: smb.share ?? '',
            path: smb.path ?? '',
            username: smb.username ?? '',
            passwordSet: !!smb.passwordSet,
            smbVersion: smb.smbVersion ?? 'auto',
          }
        : null,
    },
    quota: {
      mode: quota.mode === 'gb' ? 'gb' : 'percent',
      percent: typeof quota.percent === 'number' ? quota.percent : 90,
      gb: quota.gb != null ? quota.gb : null,
      onFull: quota.onFull === 'stop' ? 'stop' : 'overwrite',
      minRetentionDays: quota.minRetentionDays != null ? quota.minRetentionDays : null,
    },
    files: {
      segmentSeconds: typeof files.segmentSeconds === 'number' ? files.segmentSeconds : 60,
    },
  }
}

export function RecorderConfigForm({ recorderDoc, onSavePartial }: Props) {
  const config = recorderDoc?.config ?? {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => extract(config), [recorderDoc?.id, recorderDoc?.updatedAt])
  const [kind, setKind] = useState(initial.storage.kind)
  const [localPath, setLocalPath] = useState(initial.storage.localPath)
  const [smbHost, setSmbHost] = useState(initial.storage.smb?.host ?? '')
  const [smbShare, setSmbShare] = useState(initial.storage.smb?.share ?? '')
  const [smbPath, setSmbPath] = useState(initial.storage.smb?.path ?? '')
  const [smbUser, setSmbUser] = useState(initial.storage.smb?.username ?? '')
  const [smbVersion, setSmbVersion] = useState(initial.storage.smb?.smbVersion ?? 'auto')
  const [passwordSet] = useState(initial.storage.smb?.passwordSet ?? false)
  const [password, setPassword] = useState('')
  const [quotaMode, setQuotaMode] = useState(initial.quota.mode)
  const [percent, setPercent] = useState(String(initial.quota.percent))
  const [gb, setGb] = useState(initial.quota.gb != null ? String(initial.quota.gb) : '')
  const [onFull, setOnFull] = useState(initial.quota.onFull)
  const [minDays, setMinDays] = useState(
    initial.quota.minRetentionDays != null ? String(initial.quota.minRetentionDays) : '',
  )
  const [segmentSeconds, setSegmentSeconds] = useState(String(initial.files.segmentSeconds))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  /** 组装白名单字段 + 保留顶层其他键；smb.password 占位符保留、明文剔除 */
  function buildNext(): Record<string, unknown> {
    const next: Record<string, unknown> = {}
    const smbOriginal = (config.storage as RecorderConfig['storage'] | undefined)?.smb
    const passwordPreserved =
      smbOriginal && isSecretRef(smbOriginal.password) ? smbOriginal.password : undefined

    next.storage = {
      kind,
      localPath: localPath.trim(),
      smb:
        kind === 'smb'
          ? {
              host: smbHost.trim(),
              share: smbShare.trim(),
              path: smbPath.trim(),
              username: smbUser.trim(),
              passwordSet,
              smbVersion: smbVersion as (typeof SMB_VERSIONS)[number],
              // 密码本身永不进普通文档：占位符引用保留，明文一律不写
              ...(password ? { password } : passwordPreserved !== undefined ? { password: passwordPreserved } : {}),
            }
          : null,
    }
    const numOrNull = (v: string): number | null => {
      const t = v.trim()
      if (!t) return null
      const n = Number(t)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    next.quota = {
      mode: quotaMode,
      percent: Math.min(99, Math.max(50, Number(percent) || 90)),
      gb: quotaMode === 'gb' ? numOrNull(gb) : null,
      onFull,
      minRetentionDays: numOrNull(minDays),
    } as RecorderConfig['quota']
    const seg = Number(segmentSeconds)
    next.files = { segmentSeconds: Number.isFinite(seg) ? Math.min(3600, Math.max(10, seg)) : 60 }
    return next
  }

  const [impacts, setImpacts] = useState<string[] | null>(null)

  async function handleSave(confirmed = false) {
    const seg = Number(segmentSeconds)
    if (!Number.isInteger(seg) || seg < 10 || seg > 3600) { toast.error('分段时长应为 10–3600 秒整数'); return }
    if (quotaMode === 'gb' && (!Number.isInteger(Number(gb)) || Number(gb) <= 0)) { toast.error('GB 上限应为大于 0 的整数'); return }
    if (quotaMode === 'percent' && (!Number.isInteger(Number(percent)) || Number(percent) < 50 || Number(percent) > 99)) { toast.error('磁盘阈值应为 50–99% 的整数'); return }
    if (minDays.trim() && (!Number.isInteger(Number(minDays)) || Number(minDays) <= 0)) { toast.error('最少保留天数应为正整数，或留空'); return }
    if (kind === 'local' && !localPath.trim().startsWith('/')) { toast.error('请输入本机绝对目录'); return }
    if (kind === 'smb' && (!smbHost.trim() || !smbShare.trim())) { toast.error('请填写 NAS 主机和共享名'); return }
    if (!confirmed) {
      // 存储/分段/配额的修改会中断录像或删除旧录像：先说明影响再保存
      const pending = recorderSaveImpacts(initial, { ...(buildNext() as unknown as RecorderDraft), passwordChanged: !!password })
      if (pending.length) { setImpacts(pending); return }
    }
    setSaving(true)
    try {
      await onSavePartial('recorder', 'system', 'settings', buildNext())
      setDirty(false)
      setPassword('')
      toast.success('已保存并应用')
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const input = 'form-input'
  const label = 'mb-1.5 block text-xs font-medium text-ink'

  return (
    <div className="space-y-4" data-unsaved={dirty} onChange={() => setDirty(true)}>
      <section className="ui-panel flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-base bg-primary-50 text-primary-600">
          <CalendarClock size={20} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">通道与录像计划</h3>
          <p className="mt-1 text-xs leading-5 text-ink-subtle">选择需要录像的通道，并设置每天的录像时段。计划独立应用到录像服务。</p>
        </div>
        <Link to="/playback?schedule=1" className="inline-flex items-center gap-1 rounded-base border border-line px-3 py-2 text-sm font-medium text-primary-600 hover:bg-primary-50">
          管理录像计划<ChevronRight size={15} aria-hidden />
        </Link>
      </section>
      <section className="ui-panel p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">分段</h3>
        <div className="max-w-sm">
          <label htmlFor="segment-seconds" className={label}>分段时长（秒）</label>
          <input
            id="segment-seconds" type="number" min={10} max={3600} value={segmentSeconds}
            onChange={(e) => setSegmentSeconds(e.target.value)} className={input}
          />
          <span className="mt-1.5 block text-xs text-ink-subtle">实际切点对齐关键帧，允许小幅波动</span>
        </div>
      </section>

      <section className="ui-panel p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">存储位置</h3>
        <div className="mb-2 flex gap-2">
          {(['local', 'smb'] as const).map((k) => (
            <button key={k} type="button" onClick={() => { setKind(k); setDirty(true) }}
              aria-pressed={kind === k}
              className={`rounded-base border px-3 py-1.5 text-xs font-medium ${kind === k ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-ink-subtle hover:bg-surface-hover'}`}>
              {k === 'local' ? '本机磁盘' : 'SMB / NAS'}
            </button>
          ))}
        </div>
        {kind === 'local' ? (
          <div>
            <label className={label}>录像目录</label>
            <input value={localPath} onChange={(e) => setLocalPath(e.target.value)}
              placeholder="如 /home/sunrise/ainvr/data/recordings" className={`${input} flex-1`} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><label className={label}>主机</label>
              <input value={smbHost} onChange={(e) => setSmbHost(e.target.value)} placeholder="//192.168.x.x" className={input} /></div>
            <div><label className={label}>共享名</label>
              <input value={smbShare} onChange={(e) => setSmbShare(e.target.value)} className={input} /></div>
            <div><label className={label}>子目录</label>
              <input value={smbPath} onChange={(e) => setSmbPath(e.target.value)} className={input} /></div>
            <div><label className={label}>用户名</label>
              <input value={smbUser} onChange={(e) => setSmbUser(e.target.value)} className={input} /></div>
            <div><label className={label}>SMB 版本</label>
              <select value={smbVersion} onChange={(e) => setSmbVersion(e.target.value as SmbVersion)} className={input}>
                {SMB_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select></div>
            <div>
              <label className={label}>共享密码</label>
              <input type="password" autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)} className={input}
                placeholder="留空保留已有密码" />
            </div>
          </div>
        )}
      </section>

      <section className="ui-panel p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">容量与覆盖</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><label className={label}>配额模式</label>
            <select value={quotaMode} onChange={(e) => setQuotaMode(e.target.value as 'percent' | 'gb')} className={input}>
              <option value="percent">目录所在盘百分比</option>
              <option value="gb">固定 GB 上限</option>
            </select></div>
          {quotaMode === 'percent' ? (
            <div><label className={label}>触发百分比（50-99）</label>
              <input type="number" min={50} max={99} value={percent} onChange={(e) => setPercent(e.target.value)} className={input} /></div>
          ) : (
            <div><label className={label}>GB 上限</label>
              <input type="number" min={1} value={gb} onChange={(e) => setGb(e.target.value)} className={input} /></div>
          )}
          <div><label className={label}>配额触发后</label>
            <select value={onFull} onChange={(e) => setOnFull(e.target.value as 'overwrite' | 'stop')} className={input}>
              <option value="overwrite">循环覆盖：删最旧分段继续录</option>
              <option value="stop">停止录制</option>
            </select></div>
          <div><label className={label}>最少保留天数（空=不限）</label>
            <input type="number" min={1} value={minDays} onChange={(e) => setMinDays(e.target.value)} className={input} /></div>
        </div>
      </section>

      <p className="rounded-base bg-amber-50 px-3 py-2 text-xs text-amber-700">
        保存后自动下发并等待录像服务确认。切换 NAS 时可能需要较长时间，期间请勿操作。
        新密码会加密保存，留空保留原密码；配置文档只保留引用。
      </p>

      <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty}
        className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
        {saving ? '保存并应用中…' : '保存并应用'}
      </button>

      <ConfirmDialog
        open={impacts != null}
        title="保存将影响录像"
        content={impacts ? `本次保存会：${impacts.join('；')}。` : ''}
        confirmText="确认保存"
        danger
        onConfirm={() => { setImpacts(null); void handleSave(true) }}
        onClose={() => setImpacts(null)}
      />
    </div>
  )
}
