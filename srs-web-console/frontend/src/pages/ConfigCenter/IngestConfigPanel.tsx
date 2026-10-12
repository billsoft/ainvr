import { useEffect, useState } from 'react'
import { ingestService, type IngestCapabilities } from '@/api/ingestService'

export function IngestConfigPanel({ config, onSave }: {
  config: Record<string, unknown>
  onSave: (overrides: Record<string, unknown>) => Promise<void>
}) {
  const [caps, setCaps] = useState<IngestCapabilities | null>(null)
  const saved = config.ingest as { maxPullChannels?: number; connectTimeoutSec?: number } | undefined
  const [max, setMax] = useState(saved?.maxPullChannels ?? 4)
  const [timeout, setConnectTimeout] = useState(saved?.connectTimeoutSec ?? 10)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    ingestService.capabilities(abort.signal).then(setCaps).catch(() => {})
    return () => abort.abort()
  }, [])
  useEffect(() => { setMax(saved?.maxPullChannels ?? 4); setConnectTimeout(saved?.connectTimeoutSec ?? 10) }, [saved?.maxPullChannels, saved?.connectTimeoutSec])
  async function save() {
    if (!Number.isInteger(max) || max < 1 || max > 8 || !Number.isInteger(timeout) || timeout < 3 || timeout > 30) {
      setMessage('请填写有效的并发数和超时'); return
    }
    setBusy(true)
    try { await onSave({ ingest: { maxPullChannels: max, connectTimeoutSec: timeout } }); setMessage('已保存，适用于后续连接；已运行通道不被中断') }
    catch { setMessage('保存失败，请重试') }
    finally { setBusy(false) }
  }
  return <section className="rounded-panel border border-line bg-surface p-4">
    <h3 className="font-medium">摄像头接入能力</h3>
    {!caps ? <p className="text-xs">正在查询接入服务…</p> : <ul className="my-3 text-sm">
      {(['rtmp','srt','webrtc','rtsp'] as const).map(p => <li key={p}>{p.toUpperCase()} · {caps[p].enabled ? '已启用，H.264 / H.265' : caps[p].reason || '尚未启用'}</li>)}
    </ul>}
    <p className="text-xs text-ink-faint">SRT 接入端口：10080 / UDP。监听端口、加密及防火墙由部署配置管理，变更需要维护窗口。WebRTC 输入使用 WHIP 和专用发布凭据；不拉取任意网页。拉流首期只接入视频。</p>
    <div className="my-3 flex flex-wrap gap-4 text-sm">
      <label>最大同时拉流数（1–8） <input type="number" min="1" max="8" value={max} onChange={e => setMax(Number(e.target.value))} className="w-16 border" /></label>
      <label>连接超时（3–30 秒） <input type="number" min="3" max="30" value={timeout} onChange={e => setConnectTimeout(Number(e.target.value))} className="w-16 border" /></label>
    </div>
    <p className="text-xs">降低上限只限制新连接，当前连接保持运行。源地址、凭据和 TCP/UDP 在对应通道编辑中设置。</p>
    <button type="button" className="mt-3 text-primary" disabled={busy} onClick={() => void save()}>保存拉流设置</button>
    {message && <p className="mt-2 text-xs">{message}</p>}
  </section>
}
