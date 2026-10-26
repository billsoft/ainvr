import { useEffect, useState } from 'react'
import { storageService, storageBytes, type StorageVolume } from '@/api/storageService'

export function StorageVolumes() {
  const [volumes, setVolumes] = useState<StorageVolume[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) {
        try { const result = await storageService.volumes(); if (active) { setVolumes(result.volumes); setError('') } }
        catch { if (active) setError('存储信息暂不可用') }
      }
      if (active) timer = setTimeout(tick, 30000)
    }
    void tick(); return () => { active = false; clearTimeout(timer) }
  }, [])
  return <section className="rounded-xl border border-line bg-surface p-4">
    <h2 className="font-medium">存储设备</h2>
    {error && <p role="alert" className="mt-2 text-sm text-amber-700">{error}，以下数据可能已过期</p>}
    <div className="mt-3 grid gap-3 md:grid-cols-2">{volumes.map(v => <div key={v.device} className="rounded-lg border border-line p-3">
      <div className="flex justify-between gap-3 text-sm"><strong>{v.system ? '系统盘' : v.label}</strong><span>{v.system ? '本机运行' : `${v.transport.toUpperCase()} · ${v.filesystem}`}</span></div>
      <p className="mt-1 text-xs text-ink-subtle break-all">{v.mountPath || '尚未挂载'}{v.readOnly ? ' · 只读' : ''}</p>
      <p className="mt-2 text-sm">可用 {storageBytes(v.availableBytes)} / 共 {storageBytes(v.totalBytes)}</p>
      <div className="mt-2 h-1.5 rounded bg-slate-100"><div className={`h-full rounded ${v.availableBytes !== null && v.availableBytes / v.totalBytes < .1 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${v.availableBytes === null || !v.totalBytes ? 0 : Math.max(0, Math.min(100, 100 * (1 - v.availableBytes / v.totalBytes)))}%` }} /></div>
    </div>)}</div>
    {!volumes.length && !error && <p className="mt-2 text-sm text-ink-subtle">正在读取磁盘信息…</p>}
  </section>
}
