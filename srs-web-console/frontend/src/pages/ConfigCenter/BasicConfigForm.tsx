import { Section, Field, inputCls } from './fields'
/**
 * 系统配置 · 基础配置（2026-09-18，5分类改版）
 *
 * 只管两块跟"这是个什么系统"相关、不属于任何具体微服务的设置：
 * 监看与轮询（backend/system/settings 的顶层字段）+ 访问密码（即时动作，
 * 不进草稿）。SRS/AI 服务的连接地址已经搬到「流媒体配置」「AI微服务
 * 配置」两个专页——同一份 backend/system/settings 文档被三个分类页
 * 分别编辑，保存时必须"整份读出→只覆盖自己负责的顶层字段→整份写回"，
 * 这份读改写的安全性由父组件 ConfigCenterPage 的 savePartial() 保证
 * （PG 的 config 列是整列替换，不是字段级 merge），本组件的 onSave 只
 * 传自己关心的两个字段，不用操心其它分类页管的字段会不会被带丢。
 */
import { useEffect, useState } from 'react'
import { systemService } from '@/api/systemService'
import { useAuthStore } from '@/store/auth'
import { toast } from '@/store/toast'
import type { ConfigDocument } from '@/api/configService'

interface Props {
  onBusyChange?: (busy: boolean) => void
  backendDoc: ConfigDocument | undefined
  onSavePartial: (
    service: string, group: string, name: string,
    overrides: Record<string, unknown>, description?: string,
  ) => Promise<void>
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function parseOr(v: string, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}



export function BasicConfigForm({ backendDoc, onSavePartial, onBusyChange }: Props) {
  const config = backendDoc?.config ?? {}
  const [softLimit, setSoftLimit] = useState(String(num(config.monitorSoftLimit, 6)))
  const [hardLimit, setHardLimit] = useState(String(num(config.monitorHardLimit, 9)))
  const [pollMs, setPollMs] = useState(String(num(config.pollIntervalMs, 5000)))
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [passwordSet, setPasswordSet] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)

  useEffect(() => {
    systemService.getSettings().then((d) => setPasswordSet(d.adminPasswordSet)).catch(() => undefined)
  }, [])

  async function handleSave() {
    if (![softLimit, hardLimit].every(v => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 16)) {
      toast.error('监看上限须为 1–16 路'); return
    }
    const softWarnLocal = parseOr(softLimit, 0) >= parseOr(hardLimit, 0)
    if (softWarnLocal) {
      toast.error('软上限应小于硬上限，请调整后再保存')
      return
    }
    setSaving(true)
    try {
      await onSavePartial('backend', 'system', 'settings', {
        monitorSoftLimit: parseOr(softLimit, num(config.monitorSoftLimit, 6)),
        monitorHardLimit: parseOr(hardLimit, num(config.monitorHardLimit, 9)),
        pollIntervalMs: parseOr(pollMs, 5000),
      })
      setDirty(false)
      toast.success('已保存并应用')
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    if (passwordSet && !oldPassword) { toast.error('请输入当前密码'); return }
    if (!newPassword) {
      toast.error('请输入新密码')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的密码不一致')
      return
    }
    if (newPassword.length < 8) {
      toast.error('密码至少 8 位')
      return
    }
    setPasswordSaving(true)
    onBusyChange?.(true)
    try {
      const res = await systemService.changePassword(newPassword, oldPassword || undefined)
      const loggedIn = await useAuthStore.getState().login(newPassword)
      if (!loggedIn) throw new Error('密码已修改，但重新登录失败，请使用新密码重新登录')
      setPasswordSet(res.adminPasswordSet)
      setNewPassword('')
      setOldPassword('')
      setConfirmPassword('')
      toast.success('密码已修改')
    } catch (e: any) {
      toast.error(e.message || '修改失败')
    } finally {
      setPasswordSaving(false)
      onBusyChange?.(false)
    }
  }

  const softWarn = parseOr(softLimit, 0) >= parseOr(hardLimit, 0)

  return (
    <div className="space-y-5" data-unsaved={dirty || !!oldPassword || !!newPassword || !!confirmPassword}>
      <Section title="监看与轮询" hint="软上限达到时提醒；硬上限为允许同时打开的最大画面数">
        <div className="grid grid-cols-2 gap-4">
          <Field label="软上限（路）">
            <input type="number" min={1} max={16} value={softLimit}
              onChange={(e) => { setSoftLimit(e.target.value); setDirty(true) }} className={inputCls} />
          </Field>
          <Field label="硬上限（路）">
            <input type="number" min={1} max={16} value={hardLimit}
              onChange={(e) => { setHardLimit(e.target.value); setDirty(true) }} className={inputCls} />
          </Field>
        </div>
        {softWarn && <p className="text-xs text-danger-600">软上限应小于硬上限，请调整后再保存</p>}
        <Field label="状态刷新间隔（毫秒）" hint="仪表盘概览和关于页的刷新间隔；历史曲线、日志与通道列表按各自周期刷新">
          <input type="number" min={1000} max={60000} step={1000} value={pollMs}
            onChange={(e) => { setPollMs(e.target.value); setDirty(true) }} className={inputCls} />
        </Field>
        <button type="button" onClick={handleSave} disabled={saving || !dirty}
          className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
          {saving ? '保存并应用中…' : '保存并应用'}
        </button>
      </Section>

      <Section title="访问密码" hint="安全凭据独立即时更新，不进入服务配置版本；修改后当前会话会自动使用新密码重新登录，其它已登录的浏览器和正在进行的回放需要重新登录">
        <div className="flex items-center gap-2 text-xs">
          当前状态：
          <span className={`rounded-full px-2 py-0.5 font-medium ${passwordSet ? 'bg-success-100 text-success-700' : 'bg-ink-100 text-ink-500'}`}>
            {passwordSet ? '已启用' : '未启用'}
          </span>
          {passwordSet && (
            <button type="button" onClick={() => useAuthStore.getState().logout()}
              className="ml-2 rounded-base border border-line px-2.5 py-1 hover:bg-surface-page">
              退出登录
            </button>
          )}
        </div>
        {/* eslint-disable-next-line @typescript-eslint/no-misused-promises */}
        <form onSubmit={handleChangePassword} className="grid grid-cols-2 gap-4">
          {passwordSet && <Field label="当前密码">
            <input type="password" value={oldPassword} autoComplete="current-password" maxLength={100}
              onChange={(e) => setOldPassword(e.target.value)} className={inputCls} placeholder="请输入当前密码" />
          </Field>}
          <Field label="新密码">
            <input type="password" value={newPassword} autoComplete="new-password"
              onChange={(e) => setNewPassword(e.target.value)} className={inputCls} placeholder="请输入新密码" />
          </Field>
          <Field label="确认新密码">
            <input type="password" value={confirmPassword} autoComplete="new-password"
              onChange={(e) => setConfirmPassword(e.target.value)} className={inputCls} placeholder="请再次输入新密码" />
          </Field>
          <div className="col-span-2">
            <button type="submit" disabled={passwordSaving}
              className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
              {passwordSaving ? '修改中…' : '修改密码（立即生效）'}
            </button>
          </div>
        </form>
      </Section>
    </div>
  )
}
