import { useRef, useState, type FormEvent, type ChangeEvent } from 'react'
import { useLicenseStore } from '@/store/license'
import { licenseService, toLicenseApiError, type LicensePreview } from '@/api/licenseService'
import { MAX_LICENSE_FILE_BYTES, readLicenseText } from './licenseFiles'

export function ActivateForm() {
  const activate = useLicenseStore((s) => s.activate)
  const activating = useLicenseStore((s) => s.activating)
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<LicensePreview | null>(null)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const key = raw.replace(/\s+/g, '')

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // The same file can be selected again after an error.
    if (!file) return
    setImporting(true); setPreview(null); setMessage(''); setError('')
    try {
      if (file.size > MAX_LICENSE_FILE_BYTES) throw new Error('注册码文件过大，请选择供应商提供的文本文件')
      setRaw(readLicenseText(await file.text()))
      setMessage('注册码已导入，请核对时长后确认激活。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '文件读取失败')
    } finally { setImporting(false) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!key || checking || activating || importing) return
    setError(''); setMessage('')
    try {
      if (!preview) {
        setChecking(true)
        setPreview(await licenseService.preview(key))
      } else {
        const status = await activate(key)
        await useLicenseStore.getState().refreshMachineCode()
        setMessage(status.activation_result === 'already_active'
          ? '该注册码已经激活，剩余时长未重置。'
          : '授权已保存。业务服务将自动获取新授权并恢复，请查看业务状态。')
        setRaw(''); setPreview(null)
      }
    } catch (failure) { setError(toLicenseApiError(failure).message) }
    finally { setChecking(false) }
  }

  return (
    <section className="ui-panel p-5 sm:p-6" aria-labelledby="activate-title">
      <h2 id="activate-title" className="text-base font-semibold">录入注册码</h2>
      <p className="mt-2 text-sm text-ink-subtle">先核对授权时长，再确认激活。新授权从本次激活开始，替换当前剩余时长。</p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <input ref={fileInput} type="file" accept=".lic,.txt,.key,text/plain" className="hidden"
          aria-label="选择注册码文件" onChange={importFile} disabled={checking || activating || importing} />
        <button type="button" disabled={checking || activating || importing}
          onClick={() => fileInput.current?.click()}
          className="rounded-base border border-line px-3 py-2 text-sm disabled:opacity-50">
          {importing ? '正在读取…' : '导入注册码文件'}
        </button>
        <textarea aria-label="注册码" rows={4} spellCheck={false} autoComplete="off" maxLength={8192}
          disabled={checking || activating || importing}
          value={raw} onChange={(event) => { setRaw(event.target.value); setPreview(null); setError(''); setMessage('') }}
          placeholder="AINVR-LIC3-…"
          className="w-full rounded-panel border border-line bg-surface-page p-3 font-mono text-sm" />
        {preview && <div role="status" className="rounded-panel bg-primary-50 p-3 text-sm">
          {preview.operation === 'already_active'
            ? '此注册码已使用；再次提交仅查询结果，不会重置计时。'
            : <>新授权：{preview.duration_minutes} 分钟。确认后将替换当前剩余 {Math.ceil(preview.current_remaining_seconds / 60)} 分钟。</>}
        </div>}
        {error && <p role="alert" className="text-sm text-danger-700">{error}</p>}
        {message && <p role="status" className="text-sm text-success-700">{message}</p>}
        <button type="submit" disabled={!key || checking || activating || importing}
          className="rounded-base bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">
          {checking ? '核对中…' : activating ? '激活中…' : preview ? '确认激活授权' : '核对注册码'}
        </button>
        {preview && <button type="button" onClick={() => setPreview(null)} className="ml-3 text-sm">取消</button>}
      </form>
    </section>
  )
}
