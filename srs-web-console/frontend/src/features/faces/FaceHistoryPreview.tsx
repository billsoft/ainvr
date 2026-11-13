import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FaceCaptureResults, type FacePreviewFilter } from './FaceCaptureResults'
import { FacePreviewNotice } from './FacePreviewShared'
import { FaceMode } from './FaceConnectedShared'
import { FaceQueryConnected } from './FaceQueryConnected'

export function FaceHistoryPreview({ channelId, previewOnly = false }: { channelId?: string; previewOnly?: boolean }) {
  return <FaceMode previewOnly={previewOnly} preview={<FaceHistoryDemo channelId={channelId} />}><FaceQueryConnected mode="history" channelId={channelId} /></FaceMode>
}
function FaceHistoryDemo({ channelId }: { channelId?: string }) {
  const [showExamples, setShowExamples] = useState(false)
  const [filter, setFilter] = useState<FacePreviewFilter>('all')
  const [identityVisible, setIdentityVisible] = useState(false)
  return <section className="min-h-0 space-y-4 overflow-y-auto p-1" aria-label="人脸抓拍设计预览">
    <div className="ui-panel space-y-4 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-base font-semibold">人脸抓拍</h1><p className="mt-1 text-xs text-ink-subtle">质量筛选、特征可用性与身份候选分开展示</p></div><Link className="btn-secondary min-h-11" to="/config-center?category=faces">人脸库设计预览</Link></div>
      <FacePreviewNotice />
      {channelId && <p className="text-xs text-ink-subtle">已保留原通道路由；示例不使用此通道的数据或筛选范围。</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-secondary min-h-11" aria-pressed={showExamples} onClick={() => setShowExamples(value => !value)}>{showExamples ? '隐藏示例抓拍' : '查看示例抓拍'}</button><button className="btn-secondary min-h-11" disabled>正式人脸查询（未接入）</button></div>
      {showExamples && <div className="flex flex-wrap items-end gap-4 border-t border-line pt-3"><label className="text-sm">示例状态筛选<select className="form-input min-h-11 mt-1" value={filter} onChange={event => setFilter(event.target.value as FacePreviewFilter)}><option value="all">全部示例</option><option value="qualified">质量合格</option><option value="unmatched">未匹配</option><option value="unavailable">不可用</option></select></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={identityVisible} onChange={event => setIdentityVisible(event.target.checked)} />模拟授权查看示例身份</label><p className="text-xs text-ink-subtle">仅切换虚构示例内容，不授予生产权限。</p></div>}
    </div>
    {showExamples ? <FaceCaptureResults filter={filter} identityVisible={identityVisible} /> : <div className="ui-panel p-8 text-center"><h2 className="text-sm font-medium">真实人脸抓拍查询尚未接入</h2><p className="mt-2 text-xs text-ink-subtle">不代表历史记录为零。已有检测截图和车辆通行仍可从上方页签查看。</p></div>}
  </section>
}
