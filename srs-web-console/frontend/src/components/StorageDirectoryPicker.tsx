import { useEffect, useRef, useState } from 'react'
import { storageService, storageBytes, type StorageVolume } from '@/api/storageService'

/** Inline browser: choosing only edits the enclosing configuration draft. */
export interface StorageSelection { volumeId: string; relativePath: string }
export function StorageDirectoryPicker({ value, currentSelection, onChange, onSelection, label = '选择录像磁盘', hint,
  defaultRelativePath = '' }: { value: string; onChange?: (path: string) => void;
    currentSelection?: StorageSelection; onSelection?: (selection: StorageSelection) => void; label?: string; hint?: string; defaultRelativePath?: string }) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([])
  const [volumeId, setVolumeId] = useState(''), [path, setPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([]), [truncated, setTruncated] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const selected = volumes.find(v => v.id === volumeId && v.selectable)
  async function refresh() {
    try { const data = await storageService.volumes(); setVolumes(data.volumes); setError('') }
    catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    const current = ++generation.current
    setDirectories([])
    if (!selected) { setBusy(false); return }
    setBusy(true); setError('')
    void storageService.directories(selected.id, path).then(data => {
      if (generation.current === current) { setDirectories(data.directories); setTruncated(data.truncated) }
    }).catch(e => { if (generation.current === current) setError((e as Error).message) })
      .finally(() => { if (generation.current === current) setBusy(false) })
    return () => { generation.current++ }
  }, [selected?.id, selected?.mountPath, path])
  const fullPath = selected ? `${selected.mountPath}${path ? `/${path}` : ''}` : ''
  const selectionPath = path || defaultRelativePath
  const savedVolume = currentSelection && volumes.find(volume => volume.id === currentSelection.volumeId)
  const description = currentSelection ? `${savedVolume?.label || '已保存的外挂磁盘（当前未确认）'} · /${currentSelection.relativePath}` : value || '未选择'
  return <div className="space-y-3" onChange={event => event.stopPropagation()}>
    <p className="break-all text-sm">当前目录：{description}</p>
    <div className="flex gap-2"><select aria-label={label} value={volumeId} onChange={e => { setVolumeId(e.target.value); setPath('') }} className="min-h-11 min-w-0 flex-1 rounded border border-line px-3 py-2">
      <option value="">选择已挂载的 SSD / USB 磁盘</option>
      {volumes.filter(v => !v.system).map(v => <option key={v.device} value={v.id} disabled={!v.selectable}>{v.label} · {v.transport.toUpperCase()} · 可用 {storageBytes(v.availableBytes)}{!v.selectable ? '（不可选）' : ''}</option>)}
    </select><button type="button" onClick={() => void refresh()} className="min-h-11 rounded border border-line px-3 py-2">刷新</button></div>
    {selected && <div className="rounded border border-line p-3">
      <p className="break-all text-xs text-ink-subtle">{fullPath}</p>
      {path && <button type="button" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))} className="my-2 min-h-11 text-primary-600">返回上级目录</button>}
      <div className="my-2 max-h-44 overflow-auto">{directories.map(name => <button key={name} type="button" onClick={() => setPath(path ? `${path}/${name}` : name)} className="block min-h-11 w-full rounded px-2 text-left hover:bg-slate-100">📁 {name}</button>)}</div>
      {busy ? <p className="text-sm">读取目录中…</p> : !directories.length && !error ? <p className="my-2 text-sm text-ink-subtle">没有子目录</p> : null}
      {truncated && <p className="text-xs text-amber-700">目录较多，仅展示前 200 项</p>}
      {defaultRelativePath && !path && <p className="mb-2 break-all text-xs text-ink-subtle">保存位置：{selected.mountPath}/{defaultRelativePath}（需要时自动创建）</p>}
      <button type="button" disabled={busy || !!error} onClick={() => {
        onChange?.(fullPath)
        onSelection?.({ volumeId: selected.id, relativePath: selectionPath })
      }} className="min-h-11 rounded bg-primary px-3 text-white disabled:opacity-50">使用此目录</button>
    </div>}
    {error && <p role="alert" className="text-sm text-amber-700">{error}</p>}
    <p className="text-xs text-ink-subtle">{hint ?? '选择后点击保存才生效。仅浏览已挂载磁盘，不会格式化或移动已有录像。系统盘不作为新录像位置。'}</p>
  </div>
}
