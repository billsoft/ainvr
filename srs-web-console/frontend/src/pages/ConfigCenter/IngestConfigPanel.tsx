import { useEffect, useState } from 'react'
import { ingestService, type IngestCapabilities } from '@/api/ingestService'

export function IngestConfigPanel({ config, onSave }: {
  config: Record<string, unknown>
  onSave: (overrides: Record<string, unknown>) => Promise<void>
}) {
  const [caps, setCaps] = useState<IngestCapabilities | null>(null)
  const saved = config.ingest as { maxPullChannels?: number; connectTimeoutSec?: number; maxAudioTranscodes?: number } | undefined
  const [max, setMax] = useState(saved?.maxPullChannels ?? 4)
  const [timeout, setConnectTimeout] = useState(saved?.connectTimeoutSec ?? 10)
  const [audioMax,setAudioMax]=useState(saved?.maxAudioTranscodes??2)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [loadError, setLoadError] = useState(false)
  const dirty = max !== (saved?.maxPullChannels ?? 4) || timeout !== (saved?.connectTimeoutSec ?? 10) || audioMax!==(saved?.maxAudioTranscodes??2)
  useEffect(() => {
    const abort = new AbortController()
    ingestService.capabilities(abort.signal).then(setCaps).catch(() => { if (!abort.signal.aborted) setLoadError(true) })
    return () => abort.abort()
  }, [])
  useEffect(() => { setMax(saved?.maxPullChannels ?? 4); setConnectTimeout(saved?.connectTimeoutSec ?? 10);setAudioMax(saved?.maxAudioTranscodes??2) }, [saved?.maxPullChannels, saved?.connectTimeoutSec,saved?.maxAudioTranscodes])
  async function save() {
    if (!Number.isInteger(max) || max < 1 || max > 32 || !Number.isInteger(timeout) || timeout < 3 || timeout > 30 || !Number.isInteger(audioMax) || audioMax<0 || audioMax>8) {
      setMessage('请填写有效的并发数和超时'); return
    }
    setBusy(true)
    try { await onSave({ ingest: { maxPullChannels: max, connectTimeoutSec: timeout, maxAudioTranscodes:audioMax } }); setMessage('已保存，适用于后续连接；已运行通道不被中断') }
    catch { setMessage('保存失败，请重试') }
    finally { setBusy(false) }
  }
  return <section data-unsaved={dirty} className="rounded-panel border border-line bg-surface p-4">
    <h3 className="font-medium">摄像头接入能力</h3>
    {loadError ? <p role="alert" className="text-xs text-danger">接入服务状态暂时不可用，请检查服务连接后重新进入本页。</p> : !caps ? <p className="text-xs">正在查询接入服务…</p> : <ul className="my-3 text-sm">
      {(['rtmp','srt','webrtc','rtsp'] as const).map(p => <li key={p}>{p.toUpperCase()} · {caps[p].enabled ? '已启用，H.264 / H.265' : caps[p].reason || '尚未启用'}</li>)}
    </ul>}
    <p className="text-xs text-ink-faint">SRT 接入端口：10080 / UDP。WebRTC 输入使用 WHIP 和专用发布凭据。RTSP / ONVIF 视频保持原编码；AAC 直通，G.711／G.726 按配额转为 AAC。 32 是配置上限，实际承载能力取决于码率与设备资源；请从默认 4 路按实际负载验证后调整。</p>
    <div className="my-3 flex flex-wrap gap-4 text-sm">
      <label>最大同时拉流数（1–32） <input type="number" min="1" max="32" value={max} onChange={e => setMax(Number(e.target.value))} className="min-h-11 w-20 rounded border border-line px-2" /></label>
      <label>连接超时（3–30 秒） <input type="number" min="3" max="30" value={timeout} onChange={e => setConnectTimeout(Number(e.target.value))} className="w-16 border" /></label>
      <label>同时转换音频数（0–8） <input type="number" min="0" max="8" value={audioMax} onChange={e=>setAudioMax(Number(e.target.value))} className="min-h-11 w-20 rounded border border-line px-2" /></label>
    </div>
    <p className="text-xs">降低上限只限制新连接，当前连接保持运行。实际容量取决于码率、音频和其他负载；界面配置上限不代表已验证容量。音频转换名额不足时继续接入视频并显示原因。</p>
    <button type="button" className="mt-3 text-primary" disabled={busy} onClick={() => void save()}>保存拉流设置</button>
    {message && <p className="mt-2 text-xs">{message}</p>}
  </section>
}
