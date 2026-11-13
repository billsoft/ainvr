import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { faceService, faceError, type FaceRecord } from '@/api/faceService'
import { FaceMemberPhoto } from './FaceMemberPhoto'
import { evidencePlaybackHref } from '@/features/playbackNavigation'

export interface FaceAlarmFact {
  record_id: string; photo_ref?: string; processor_id?: string; channel_id: string
  library_id: string; library_version: number; library_name?: string; member_id: string; member_name?: string
  similarity: number; threshold: number; model: string; space_id: string; occurred_at: string; recording_channel_id: string | null
}
export function faceAlarmSummary(face: FaceAlarmFact) {
  return `疑似「${face.member_name || '名单成员'}」 · 人脸库「${face.library_name || '未命名'}」 · 候选相似度 ${Number.isFinite(face.similarity) ? face.similarity.toFixed(2) : '不可用'}（仅供参考，需人工确认）`
}
/** Protected photo endpoint, with viewport gating and no external image URL. */
export function FaceAlarmPhoto({ recordId, compact = false, onOpen }: { recordId: string; compact?: boolean; onOpen?: () => void }) {
  const ref = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(!compact), [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (!compact || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [compact])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(); let live = true, owned = ''
    setUrl(''); setError('')
    void faceService.recordPhoto(recordId, controller.signal).then(blob => {
      if (!live) return
      if (!blob) { setError('照片已过期或不可用'); return }
      owned = URL.createObjectURL(blob); setUrl(owned)
    }).catch(e => { if (live) setError(faceError(e)) })
    return () => { live = false; controller.abort(); if (owned) URL.revokeObjectURL(owned) }
  }, [recordId, visible])
  const content = url ? <img src={url} alt="原始人脸抓拍" className={compact ? 'aspect-[4/3] w-full rounded-base object-contain' : 'max-h-96 w-full rounded-base object-contain'} /> : <p className="rounded-base bg-surface-page p-2 text-xs text-ink-subtle">{error || '抓拍读取中…'}</p>
  return <div ref={ref}>{onOpen ? <button type="button" className="min-h-11 w-full" aria-label="查看人脸抓拍与告警详情" onClick={onOpen}>{content}</button> : content}</div>
}
export function FaceAlarmEvidence({ face }: { face: FaceAlarmFact }) {
  const [record, setRecord] = useState<FaceRecord | null>(null), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setRecord(null); setError('')
    void faceService.record(face.record_id, controller.signal).then(value => { if (live) setRecord(value) }).catch(e => { if (live) setError(faceError(e)) })
    return () => { live = false; controller.abort() }
  }, [face.record_id])
  // The authenticated record is authority for the link; expired evidence must
  // never silently substitute a different capture/member's current photograph.
  const href = record ? evidencePlaybackHref(record.recording_channel_id, record.captured_at, record.captured_at) : null
  return <section aria-label="人脸名单候选证据" className="space-y-3">
    <p className="text-xs text-ink-subtle">请对照现场抓拍与告警发生时的名单参考照；相似度只用于提示候选，身份由人工核验。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <figure className="space-y-2"><figcaption className="text-sm font-medium">现场抓拍</figcaption><FaceAlarmPhoto recordId={face.record_id} /></figure>
      <figure className="space-y-2"><figcaption className="text-sm font-medium">当时的名单参考照</figcaption><FaceMemberPhoto libraryId={face.library_id} version={face.library_version} memberId={face.member_id} recordId={face.record_id} /><p className="text-xs text-ink-subtle">第 {face.library_version} 版 · {face.member_name || '名单成员'}；不会替换为之后上传的照片。</p></figure>
    </div>
    {error && <p role="status" className="text-sm text-ink-subtle">{error}；告警事实与人工处理记录仍保留。</p>}
    {href && <div><Link className="btn-secondary !min-h-11" to={href} target="_blank" rel="noopener noreferrer">查看抓拍前后录像</Link><p className="mt-1 text-xs text-ink-subtle">将在录像页核对该时段是否有可播放片段。</p></div>}
    {record && !href && <p className="text-xs text-ink-subtle">此抓拍没有关联录像通道。</p>}
    <details className="text-xs"><summary className="flex min-h-11 cursor-pointer items-center">阈值与保留期限</summary><p>告警阈值 {face.threshold} · 比对时名单为第 {face.library_version} 版</p>{record && <p>抓拍保留至 {new Date(record.expires_at).toLocaleString()}</p>}</details>
  </section>
}
