import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AlertTriangle, ShieldOff } from 'lucide-react'
import { useLicenseStore } from '@/store/license'
import { REASON_TEXT, STATE_TEXT } from '@/pages/License/licenseMessages'
import { isLicenseRecoveryRoute } from './licenseRecoveryRoutes'

/**
 * 授权门控遮罩：后端 LicenseGate 对业务 API 回 503 时，httpClient 上报
 * gateBlock，这里全屏阻断（只剩「授权管理」可去）。遮罩自己负责在展示期间
 * 继续轮询授权状态——状态恢复 valid 后 store 自动清除拦截。
 *
 * 授权、配置、诊断等恢复页面保持可用；后端仍独立执行登录鉴权。
 */
export function LicenseGateOverlay() {
  const location = useLocation()
  const linkRef = useRef<HTMLAnchorElement>(null)
  const block = useLicenseStore((s) => s.gateBlock)
  const refreshStatus = useLicenseStore((s) => s.refreshStatus)

  useEffect(() => {
    if (!block) return
    const t = setInterval(() => void refreshStatus(true), 5000)
    return () => clearInterval(t)
  }, [block, refreshStatus])

  useEffect(() => {
    if (!block || isLicenseRecoveryRoute(location.pathname)) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    linkRef.current?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { event.preventDefault(); linkRef.current?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [block, location.pathname])

  if (!block || isLicenseRecoveryRoute(location.pathname)) return null

  const unavailable = block.code === 'LICENSE_SERVICE_UNAVAILABLE'
  // 系统时间早于 2026 年（无时钟电池的设备断电后未对时）：不是授权问题，直接引导去校时
  const timeInvalid = !unavailable && block.reason === 'SYSTEM_TIME_INVALID'
  const reasonText = !timeInvalid && block.reason ? (REASON_TEXT[block.reason] ?? block.reason) : ''

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="license-block-title"
    >
      <div className="w-full max-w-md rounded-panel bg-surface p-6 shadow-xl">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-danger-50 p-2.5 text-danger-700">
            {unavailable ? <AlertTriangle size={22} aria-hidden /> : <ShieldOff size={22} aria-hidden />}
          </span>
          <h2 id="license-block-title" className="text-lg font-semibold text-ink">
            {unavailable ? '授权服务不可用' : timeInvalid ? '设备时间无效' : '系统未授权'}
          </h2>
        </div>

        <p className="mt-4 text-sm leading-6 text-ink-subtle">
          {unavailable
            ? '长时间收不到授权状态信号，系统已进入保护状态。请联系运维检查授权服务，恢复后将自动解除。'
            : timeInvalid
            ? '设备时间早于 2026 年（断电后时钟未校准），录像与 AI 已暂停。校准系统时间后自动恢复。'
            : `当前授权状态为「${block.state ? STATE_TEXT[block.state] : '未授权'}」，业务功能已暂停。请录入有效注册码后自动恢复。`}
        </p>
        {reasonText && <p className="mt-2 text-xs leading-5 text-ink-faint">原因：{reasonText}</p>}

        {(
          <Link
            ref={linkRef}
            to={timeInvalid ? '/config-center?category=time' : '/config-center?category=license'}
            className="mt-5 inline-flex w-full items-center justify-center rounded-base bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-600"
          >
            {timeInvalid ? '前往校准系统时间' : '前往授权管理与诊断'}
          </Link>
        )}
      </div>
    </div>
  )
}
