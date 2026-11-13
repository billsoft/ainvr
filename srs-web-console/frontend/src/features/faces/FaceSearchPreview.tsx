import { useEffect, useRef, useState } from 'react'
import { FaceCaptureResults } from './FaceCaptureResults'
import { FacePreviewNotice } from './FacePreviewShared'
import { FaceMode } from './FaceConnectedShared'
import { FaceQueryConnected } from './FaceQueryConnected'

/** Embedded by Search/index.tsx; deliberately has no search/API dependency. */
export function FaceSearchPreview({ previewOnly = false }: { previewOnly?: boolean }) {
  return <FaceMode previewOnly={previewOnly} preview={<FaceSearchDemo />}><FaceQueryConnected mode="search" /></FaceMode>
}
function FaceSearchDemo() {
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [quality, setQuality] = useState('qualified')
  const [phase, setPhase] = useState<'idle' | 'pending' | 'results' | 'unavailable'>('idle')
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (phase !== 'pending') return
    const timer = window.setTimeout(() => setPhase(quality === 'qualified' ? 'results' : 'unavailable'), 400)
    return () => window.clearTimeout(timer)
  }, [phase, quality])
  const reset = () => { setFileName(''); setError(''); setPhase('idle'); if (fileInput.current) fileInput.current.value = '' }
  return <section aria-label="以脸查找设计预览" className="space-y-4">
    <div className="ui-panel space-y-4 p-4"><h2 className="text-base font-semibold">以脸查找 · 设计预览</h2><FacePreviewNotice />
      <label className="block space-y-2 text-sm"><span>选择本地照片（不上传）</span><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="block min-h-11 w-full rounded-base border border-line p-2" onChange={event => {
        setPhase('idle'); setError(''); setFileName('')
        const file = event.target.files?.[0]
        if (!file) return
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !/\.(jpe?g|png|webp)$/i.test(file.name)) { setError('请选择 JPEG、PNG 或 WebP 照片；当前文件格式不支持。'); return }
        if (!file.size || file.size > 10 * 1024 * 1024) { setError('请选择非空且不超过 10 MB 的照片。'); return }
        setFileName(file.name)
      }} /></label>
      <p className="text-xs leading-5 text-ink-subtle">仅本地检查文件声明的格式与大小，不读取、上传或持久化照片内容；这不等于人脸质量检测。真实单脸、清晰度、姿态及特征检测尚未接通。</p>
      {fileName && <p className="break-all text-sm">文件检查通过：{fileName} · 人脸质量尚未检测</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <label className="block text-sm">模拟人脸质量与索引状态<select className="form-input min-h-11 mt-1" value={quality} onChange={event => { setQuality(event.target.value); setPhase('idle') }}><option value="qualified">质量合格（模拟）</option><option value="blurred">图片模糊（模拟）</option><option value="no-face">没有单张可用人脸（模拟）</option><option value="uncovered">索引范围未覆盖（模拟）</option></select></label>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn-primary min-h-11" disabled={!fileName || phase === 'pending'} onClick={() => setPhase('pending')}>模拟搜索流程</button><button type="button" className="btn-secondary min-h-11" disabled={!fileName && !error} onClick={reset}>清除照片与结果</button>{phase === 'pending' && <button type="button" className="btn-secondary min-h-11" onClick={() => setPhase('idle')}>取消模拟搜索</button>}<button className="btn-secondary min-h-11" disabled>正式搜索（后台未接入）</button></div>
      <p role="status" className="text-sm text-ink-subtle">{phase === 'pending' ? '正在模拟搜索状态，未上传照片、未调用搜索服务…' : phase === 'results' ? '模拟流程结束：以下固定示例与所选照片无关，不是真实相似度或身份结果。' : phase === 'unavailable' ? (quality === 'uncovered' ? '模拟不可用：索引范围未覆盖，不代表零匹配。' : '模拟质量不合格：请更换照片，未执行匹配；不认定为陌生人。') : fileName ? '照片已选择，可模拟流程。正式索引、权限与质量检测接通前不可查询。' : '等待选择照片。正式索引、权限与质量检测接通前不可查询。'}</p>
    </div>
    {phase === 'results' && <FaceCaptureResults />}
  </section>
}
