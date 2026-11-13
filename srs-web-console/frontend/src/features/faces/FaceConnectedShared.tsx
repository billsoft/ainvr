import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { evidencePlaybackHref } from '@/features/playbackNavigation'
import { faceError, faceService, type FaceRecord, type FaceStatus } from '@/api/faceService'
import { FacePlaceholder, FacePreviewModal } from './FacePreviewShared'

export function FaceMode({ previewOnly = false, preview, children }: { previewOnly?: boolean; preview: ReactNode; children: ReactNode }) {
  const [showPreview, setShowPreview] = useState(import.meta.env.DEV && previewOnly)
  return <div className="min-h-0 space-y-3 overflow-y-auto">{import.meta.env.DEV && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-subtle"><span>{showPreview ? '设计示例 · 与设备配置隔离' : '设备人脸数据'}</span><button className="btn-secondary min-h-11" onClick={() => setShowPreview(value => !value)}>{showPreview ? '返回设备人脸数据' : '查看设计预览'}</button></div>}{showPreview ? preview : children}</div>
}
const idleReasons = ['not_configured', 'lazy_not_loaded']
const reasonText: Record<string, string> = {
  not_configured: '新建人脸库并选择通道后自动启用。',
  lazy_not_loaded: '首次抓拍或上传照片时自动加载。',
  faces_model_conflict: '同时生效的人脸库须使用同一种比对精度，请统一后保存。',
  budget_unavailable: '模型内存不足，请检查运行中心的内存占用，或停用不需要的模型后重试。',
  hardware_backoff: '设备正在恢复，稍后会自动重试。',
}
/** Plain-language state; internal reason codes never reach the page. */
export function faceRuntimeText(status: FaceStatus | null) {
  if (status?.ready) return { title: '人脸比对可用', detail: '按需加载，处理速度取决于设备当前负载。', calm: true }
  const reason = status?.reason ?? ''
  if (reason === 'faces_model_conflict') return { title: '人脸库设置不一致', detail: reasonText[reason]!, calm: false }
  if (idleReasons.includes(reason)) return { title: reason === 'not_configured' ? '人脸比对尚未启用' : '人脸比对待命中', detail: reasonText[reason]!, calm: true }
  return { title: '人脸比对暂不可用', detail: reasonText[reason] ?? '识别服务未就绪，请稍后刷新；持续出现时请检查识别服务是否运行。', calm: false }
}
export function FaceRuntimeState({ revision = 0, onStatus }: { revision?: number; onStatus?: (status: FaceStatus | null) => void }) {
  const [status, setStatus] = useState<FaceStatus | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const until = Date.now() + 30000, follow = revision > 0 || reload > 0
    async function refresh() {
      try { const value = await faceService.status(); if (live) { setStatus(value); setError(''); onStatus?.(value) } }
      catch (reason) { if (live) { setStatus(null); setError(faceError(reason)); onStatus?.(null) } }
      if (live && follow && Date.now() < until) timer = setTimeout(() => void refresh(), 5000)
    }
    void refresh()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [reload, revision, onStatus])
  const text = faceRuntimeText(status)
  return <div className={`rounded-base border p-3 text-sm ${text.calm ? 'border-line bg-surface-page text-ink' : 'border-amber-200 bg-amber-50 text-amber-900'}`}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{text.title}</strong><button className="btn-secondary min-h-11" onClick={() => setReload(value => value + 1)}>刷新状态</button></div><p className="mt-1 text-xs leading-5">{text.detail} 比对结果只是候选，需人工确认；未匹配不代表是陌生人。</p>{error && <p role="status" className="mt-1 text-xs">{error}</p>}<details className="mt-2 text-xs"><summary className="flex min-h-11 cursor-pointer items-center">容量与运行状态</summary><p className="mt-1 text-xs">最多保存 4096 张、共 512 MB 照片；到期自动清理，存满后暂停新增，不会删除仍有效的照片。</p><p className="mt-2">照片检查只看人脸大小和角度，不判断模糊、遮挡或是否真人。</p>{status?.diagnostics?.map(item => <p key={item.task}>{item.task === 'producer' ? '自动抓拍' : item.task === 'maintenance' ? '到期清理' : '模型准备'}：{item.state === 'ok' ? '运行正常' : '需要检查'}</p>)}</details></div>
}
function RecordPhoto({ record }: { record: FaceRecord }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = '', live = true
    setUrl(''); setError('')
    void faceService.recordPhoto(record.id, controller.signal).then(blob => { if (!live) return; if (!blob) { setError('照片已过期、不可用或无权访问'); return }; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }).catch(reason => { if (live) setError(faceError(reason)) })
    return () => { live = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [record.id])
  return url ? <img src={url} alt="受保护的人脸抓拍照片" className="max-h-80 w-full rounded-base object-contain" /> : <div className="space-y-2"><FacePlaceholder /><p className="text-sm text-ink-subtle">{error || '正在读取受保护照片…'}</p></div>
}
function RecordThumb({ record }: { record: FaceRecord }) {
  const ref = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false)
  const [url, setUrl] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '100px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setUrl(''); setError('')
    if (!visible || !record.photo_ref) return
    const controller = new AbortController(); let objectUrl = '', live = true
    void faceService.recordPhoto(record.id, controller.signal).then(blob => {
      if (!live) return
      if (!blob) { setError('照片不可用'); return }
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (live) setError('读取失败，点详情重试') })
    return () => { live = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [record.id, record.photo_ref, visible])
  return <span ref={ref} className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-base bg-surface-page p-1 text-center text-xs text-ink-faint">{url ? <img src={url} alt="人脸抓拍缩略图" className="h-full w-full object-cover" /> : !record.photo_ref ? '照片已清理' : error || (visible ? '读取中…' : '人脸抓拍')}</span>
}
export function FaceLiveResults({ records, coverage, channelNames = {} }: { records: FaceRecord[]; coverage: string; channelNames?: Record<string, string> }) {
  const [selected, setSelected] = useState<FaceRecord | null>(null)
  const playback = selected ? evidencePlaybackHref(selected.recording_channel_id, selected.captured_at, selected.captured_at) : null
  return <section aria-label="设备人脸结果" className="space-y-3"><p className="text-xs text-ink-subtle">{records.length} 条抓拍记录，不是唯一人数。覆盖：{coverage === 'sampled' ? '已有覆盖记录' : coverage === 'partial' ? '部分' : '未知'}；相似度用于候选排序，不是身份概率。</p>
    {!records.length && <p className="ui-panel p-6 text-sm text-ink-subtle">此查询范围没有返回可用记录；覆盖未知时不能据此认定无人或零匹配。</p>}
    <div className="grid gap-3 xl:grid-cols-2">{records.map(record => <article key={record.id} aria-label={channelNames[record.channel_id] || '人脸抓拍'} className="ui-panel flex gap-3 p-3"><button type="button" aria-label={`放大抓拍 ${channelNames[record.channel_id] || ''} ${new Date(record.captured_at).toLocaleString()}`} className="shrink-0 rounded-base" onClick={() => setSelected(record)}><RecordThumb record={record} /></button><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap justify-between gap-2"><strong className="text-sm">{channelNames[record.channel_id] || '通道名称暂不可用'}</strong><span className="text-xs">{new Date(record.captured_at).toLocaleString()}</span></div><p className="text-sm">{record.quality.state === 'qualified' ? '几何检查通过' : record.quality.state === 'rejected' ? '质量未通过' : '质量未评估'} · {record.match.state === 'candidate' ? '名单候选，待复核' : record.match.state === 'unmatched' ? '未匹配' : '匹配不可用'}</p>{record.similarity !== undefined && <p className="text-sm">相似度分数 {record.similarity.toFixed(4)} <span className="text-xs text-ink-subtle">非身份概率</span></p>}<button className="btn-secondary min-h-11" onClick={() => setSelected(record)}>查看抓拍详情</button></div></article>)}</div>
    {selected && <FacePreviewModal title="人脸抓拍详情" onClose={() => setSelected(null)} footer={<button className="btn-secondary min-h-11" onClick={() => setSelected(null)}>关闭详情</button>}><RecordPhoto record={selected} /><p className="text-sm">{channelNames[selected.channel_id] || '通道名称暂不可用'} · {new Date(selected.captured_at).toLocaleString()}</p>{playback ? <div><Link className="btn-secondary min-h-11" to={playback} target="_blank" rel="noopener noreferrer">查看前后录像</Link><p className="mt-1 text-xs text-ink-subtle">将在录像页核对该时段是否有可播放片段。</p></div> : <p className="text-sm text-ink-subtle">暂无关联录像通道。</p>}<p className="text-xs text-ink-subtle">未匹配不等于陌生人；名单候选需要人工复核。</p><details className="text-xs"><summary className="flex min-h-11 cursor-pointer items-center">保留期限与记录编号</summary><dl className="mt-3 grid gap-3 sm:grid-cols-2"><div><dt>记录编号</dt><dd className="break-all">{selected.id}</dd></div><div><dt>保留至</dt><dd>{new Date(selected.expires_at).toLocaleString()}</dd></div><div><dt>比对所用名单版本</dt><dd className="break-all">{selected.match.library_id ? `第 ${selected.match.library_version} 版` : '未比对名单'}</dd></div></dl><p className="mt-2">{selected.quality.reason}</p></details></FacePreviewModal>}
  </section>
}
