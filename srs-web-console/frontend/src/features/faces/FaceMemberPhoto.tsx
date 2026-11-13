import { useEffect, useState } from 'react'
import { faceError, faceService } from '@/api/faceService'

/** History is selected by its immutable library version, never by today's member. */
type PhotoProps = { libraryId: string; memberId: string; revision?: number } & (
  { version: number; recordId: string } | { version?: undefined; recordId?: undefined }
)
export function FaceMemberPhoto({ libraryId, memberId, version, recordId, revision = 0 }: PhotoProps) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let live = true, owned = ''
    setUrl(''); setError('')
    const request = version === undefined
      ? faceService.memberPhoto(libraryId, memberId, controller.signal)
      : faceService.historicalMemberPhoto(libraryId, version, memberId, recordId!, controller.signal)
    void request.then(blob => {
      if (!live) return
      if (!blob) { setError('照片已过期或不可用，无法进行照片核对'); return }
      owned = URL.createObjectURL(blob); setUrl(owned)
    }).catch(reason => { if (live) setError(`照片暂不可用：${faceError(reason)}`) })
    return () => { live = false; controller.abort(); if (owned) URL.revokeObjectURL(owned) }
  }, [libraryId, memberId, version, recordId, revision, retry])
  return <div className="flex min-h-40 items-center justify-center rounded-base bg-surface-page p-3">
    {url ? <img src={url} alt={version === undefined ? '已保存的成员照片' : `告警发生时的名单参考照，第 ${version} 版`} className="max-h-64 w-full object-contain" />
      : <div className="space-y-2 text-center text-xs text-ink-subtle"><p>{error || '正在读取名单照片…'}</p>{error && <button type="button" className="btn-secondary min-h-11" onClick={() => setRetry(value => value + 1)}>重试读取照片</button>}</div>}
  </div>
}
