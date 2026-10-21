import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { useBranding } from '@/store/branding'
import { request } from '@/api/httpClient'

/**
 * 局域网口令门禁：包在整个 App 外层。
 * - required === null：还没查到状态，显示加载态（避免闪一下登录框又消失）
 * - required && !token：显示登录表单
 * - 其余情况：直接放行渲染子树
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { required, token, checkStatus } = useAuthStore()

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  if (required === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-page text-sm text-ink-faint">
        加载中…
      </div>
    )
  }

  if (required && !token) {
    return <LoginForm />
  }

  return <>{children}</>
}

function LoginForm() {
  const { login, setupRequired } = useAuthStore()
  const branding = useBranding()
  const [password, setPassword] = useState('')
  const [confirmation,setConfirmation]=useState('')
  // Default on: the console is used from a fixed iPad/PC; opt out on shared devices.
  const [remember,setRemember]=useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError('')
    if (!password) {
      setError(setupRequired ? '请输入至少 8 个字符的管理密码' : '请输入访问密码')
      return
    }
    setSubmitting(true)
    try {
      if(setupRequired) {
        if(password.length<8) {
          setError('管理密码至少需要 8 个字符')
          return
        }
        if(password!==confirmation) {
          setError('两次输入的密码不一致，请重新确认')
          return
        }
        await request('/settings/password',{method:'PUT',body:JSON.stringify({password})})
        await useAuthStore.getState().checkStatus()
      }
      const ok = await login(password, remember)
      if (!ok) setError('登录失败，请核对密码；频繁尝试后请稍候再试')
    } catch(error) {
      setError(error instanceof Error?error.message:'设置密码失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface-page px-4">
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-full max-w-sm rounded-panel border border-line bg-surface p-6 shadow-modal"
      >
        {branding?.productName && (
          <p className="mb-3 text-sm font-semibold text-ink-subtle">{branding.productName}</p>
        )}
        <div className="flex items-center gap-2 text-ink">
          <Lock size={18} aria-hidden />
          <h1 className="text-base font-semibold">{setupRequired?'设置管理密码':'需要密码才能访问'}</h1>
        </div>
        <p className="mt-1.5 text-xs text-ink-subtle">
          {setupRequired?'首次使用请设置至少 8 个字符的管理密码，保护设备配置和录像。':'该控制台已启用访问密码，请输入密码继续'}
        </p>
        <label htmlFor="console-password" className="mt-4 block text-sm font-medium text-ink">
          {setupRequired ? '管理密码' : '访问密码'}
        </label>
        <input
          id="console-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError('') }}
          placeholder={setupRequired ? '设置至少 8 个字符的密码' : '请输入访问密码'}
          autoComplete={setupRequired?'new-password':'current-password'}
          aria-describedby={error ? 'auth-error' : undefined}
          aria-invalid={!!error}
          className="mt-1.5 w-full rounded-base border border-ink-faint bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none"
        />
        {setupRequired && <>
          <label htmlFor="console-password-confirmation" className="mt-3 block text-sm font-medium text-ink">确认管理密码</label>
          <input id="console-password-confirmation" type="password" value={confirmation}
            onChange={e=>{ setConfirmation(e.target.value); setError('') }} placeholder="再次输入同一个密码" autoComplete="new-password"
            aria-describedby={error ? 'auth-error' : undefined} aria-invalid={!!error}
            className="mt-1.5 w-full rounded-base border border-ink-faint bg-surface px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none" />
        </>}
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} className="h-5 w-5" />
          记住此设备（30 天内免登录）
        </label>
        <p className="text-xs text-ink-subtle">公用或他人的电脑请不要勾选。修改密码会让所有记住的设备重新登录。</p>
        {error && <p id="auth-error" role="alert" className="mt-3 rounded-base border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="mt-3 w-full rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50"
        >
          {submitting ? (setupRequired ? '正在设置…' : '验证中…') : (setupRequired ? '设置并进入' : '进入')}
        </button>
      </form>
    </div>
  )
}
