import { useEffect, useState } from 'react'
import { ingestService } from '@/api/ingestService'
import { CopyButton } from '@/components/common/CopyButton'

export function PublishCredential({ id }: { id: string }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setToken(''); setError('') }, [id])
  async function apply(revoke: boolean) {
    setBusy(true); setError('')
    try {
      if (revoke) { await ingestService.revoke(id); setToken('') }
      else setToken((await ingestService.credential(id)).authorization)
    } catch { setError('凭据操作失败，请稍后重试') }
    finally { setBusy(false) }
  }
  return <div className="mt-3 text-sm">
    <p className="text-xs text-ink-subtle">发送端使用 WHIP 发布地址，并在请求头中携带下方凭据。凭据只显示一次，请妥善保存。轮换或撤销会终止当前发布；失败时请先检查输入状态。</p>
    <div className="mt-2 flex gap-3"><button type="button" disabled={busy} onClick={() => void apply(false)}>生成 / 轮换发布凭据</button>
      <button type="button" disabled={busy} onClick={() => void apply(true)}>撤销发布凭据</button></div>
    {token && <div className="mt-2 flex gap-2"><code className="break-all text-xs">{token}</code><CopyButton value={token} /></div>}
    {error && <p className="text-danger">{error}</p>}
  </div>
}
