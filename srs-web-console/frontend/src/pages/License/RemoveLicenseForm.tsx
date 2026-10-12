import { useState } from 'react'
import { useLicenseStore } from '@/store/license'

const CONFIRMATION = '删除注册密钥'

export function RemoveLicenseForm() {
  const status = useLicenseStore((s) => s.status)
  const busy = useLicenseStore((s) => s.activating)
  const unreachable = useLicenseStore((s) => s.statusUnreachable)
  const remove = useLicenseStore((s) => s.remove)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const available = !unreachable && (status?.state === 'valid' || status?.state === 'expired')

  return (
    <section aria-labelledby="remove-license-title" className="rounded-panel border border-danger-200 bg-surface p-6">
      <h2 id="remove-license-title" className="text-base font-semibold text-ink">删除注册密钥</h2>
      <p className="mt-2 text-sm text-ink-subtle">删除后回到未注册状态，AI、录像和流媒体业务将停止。登录、配置及重新注册仍可使用。</p>
      <p className="mt-2 text-sm text-ink-subtle">剩余授权时间将作废，旧注册码不能再次激活，需要供应商签发新码。已有录像和业务配置不会删除。</p>
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
      {!open ? (
        <button type="button" disabled={busy || !available} className="mt-4 rounded-base border border-danger-200 px-4 py-2 text-danger-700 disabled:opacity-50"
          onClick={() => { setOpen(true); setConfirmation(''); setError(''); setMessage('') }}>删除注册密钥</button>
      ) : (
        <form className="mt-4 space-y-3" onSubmit={async (event) => {
          event.preventDefault()
          if (busy || !available || confirmation !== CONFIRMATION) return
          setError('')
          try {
            await remove(confirmation)
            setOpen(false); setConfirmation('')
            setMessage('注册密钥已删除，当前未注册。业务服务将在下一次授权检查时停止，最迟 30 秒。')
          } catch (e) { setError(e instanceof Error ? e.message : '删除失败，请刷新状态后重试') }
        }}>
          <label htmlFor="remove-license-confirmation" className="block text-sm font-medium">请输入“删除注册密钥”确认操作</label>
          <input id="remove-license-confirmation" value={confirmation} autoComplete="off" disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
            className="w-full rounded-base border border-danger-200 bg-surface px-3 py-2" />
          {error && <p role="alert" className="text-sm text-danger-700">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy || !available || confirmation !== CONFIRMATION}
              className="rounded-base bg-danger-700 px-4 py-2 text-white disabled:opacity-50">{busy ? '处理中…' : '确认删除'}</button>
            <button type="button" disabled={busy} className="rounded-base border px-4 py-2"
              onClick={() => { setOpen(false); setConfirmation(''); setError('') }}>取消</button>
          </div>
        </form>
      )}
    </section>
  )
}
