import { useState } from 'react'
import { FacePlaceholder, FacePreviewModal } from './FacePreviewShared'

export type FacePreviewFilter = 'all' | 'qualified' | 'unmatched' | 'unavailable'
interface CaptureExample {
  id: string; time: string; channel: string; quality: string
  status: 'candidate' | 'unmatched' | 'unavailable'; reason: string; feature: string
}
const examples: CaptureExample[] = [
  { id: 'demo-capture-01', time: '09:41:20', channel: '示例通道 A · 大门', quality: '合格', status: 'candidate', reason: '完成匹配，返回身份候选；仍需授权人员确认。', feature: 'MBF v1 · 示例库 v3' },
  { id: 'demo-capture-02', time: '09:42:08', channel: '示例通道 A · 大门', quality: '合格', status: 'unmatched', reason: '完成匹配但没有达到示例阈值，不等于陌生人或风险人员。', feature: 'MBF v1 · 示例库 v3' },
  { id: 'demo-capture-03', time: '09:43:11', channel: '示例通道 B · 走廊', quality: '不合格：模糊', status: 'unavailable', reason: '质量不足，未提取可用特征，未执行匹配。', feature: '特征不可用' },
  { id: 'demo-capture-04', time: '09:44:35', channel: '示例通道 B · 走廊', quality: '合格', status: 'unavailable', reason: '模型空间已变更，旧特征未迁移，不能跨模型比较。', feature: 'MBF v1 → R50 v1 · 待迁移' },
  { id: 'demo-capture-05', time: '09:45:03', channel: '示例通道 B · 走廊', quality: '未评估', status: 'unavailable', reason: '范围未覆盖，无法判断是否存在匹配；不是零命中。', feature: '索引覆盖未知' },
]
const statusText = { candidate: '身份候选', unmatched: '未匹配', unavailable: '不可用' }

/** Only synthetic records: never accepts a production response or a user's photo. */
export function FaceCaptureResults({ filter = 'all', identityVisible = false }: { filter?: FacePreviewFilter; identityVisible?: boolean }) {
  const [selected, setSelected] = useState<CaptureExample | null>(null)
  const rows = examples.filter(row => filter === 'all' || (filter === 'qualified' ? row.quality === '合格' : row.status === filter))
  return <section aria-label="示例人脸结果" className="space-y-3">
    <p className="text-xs text-ink-subtle">以下为固定示例，不来自摄像头、上传照片或真实查询。共 {rows.length} 条示例抓拍记录，不是唯一人数；同一人可多次抓拍，不据此推断身份数量。</p>
    <div className="grid gap-3 xl:grid-cols-2">{rows.map(row => <article key={row.id} aria-label={row.id} className="rounded-base border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3"><FacePlaceholder /><div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-surface-page px-2 py-1">示例 · {row.quality}</span><span className={`rounded-full px-2 py-1 ${row.status === 'unavailable' ? 'bg-amber-50 text-amber-900' : 'bg-primary-50 text-primary-700'}`}>{statusText[row.status]}</span></div>
        <p className="text-sm font-medium">{row.channel}</p><p className="text-xs text-ink-subtle">示例时间 {row.time} · {row.id}</p>
        {row.status === 'candidate' && <p className="text-sm">{identityVisible ? '示例候选 01（非真实身份）' : '身份受限 · 需授权查看候选'}</p>}
      </div></div>
      <p className="mt-3 text-sm leading-6">{row.reason}</p><p className="mt-2 text-xs text-ink-subtle">{row.feature}</p>
      <button type="button" className="btn-secondary min-h-11 mt-3" onClick={() => setSelected(row)}>查看示例详情</button>
    </article>)}</div>
    {selected && <FacePreviewModal title="抓拍详情 · 固定示例" onClose={() => setSelected(null)} footer={<button className="btn-secondary min-h-11" onClick={() => setSelected(null)}>关闭详情</button>}>
      <div className="flex flex-wrap gap-4"><FacePlaceholder /><div className="space-y-2 text-sm"><p className="font-semibold">{selected.channel} · {selected.time}（示例）</p><p>质量：{selected.quality} · 匹配：{statusText[selected.status]}</p><p>{selected.reason}</p></div></div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-ink-subtle">记录与证据引用</dt><dd className="mt-1 break-all">{selected.id} / demo-evidence-{selected.id.slice(-2)}</dd></div><div><dt className="text-ink-subtle">模型与名单版本</dt><dd className="mt-1">{selected.feature}</dd></div><div><dt className="text-ink-subtle">身份权限</dt><dd className="mt-1">{identityVisible && selected.status === 'candidate' ? '示例候选 01（非真实身份）' : '不展示身份信息'}</dd></div><div><dt className="text-ink-subtle">保留策略</dt><dd className="mt-1">示例 30 天；证据到期只保留允许的引用，过期图片显示不可用。</dd></div></dl>
      <p className="rounded-base bg-amber-50 p-3 text-sm text-amber-900">示例引用不可用于正式查证。后台未接入，不提供真实照片、向量、名单或录像；没有创建告警事实。</p>
      <div className="flex flex-wrap gap-2"><button className="btn-secondary min-h-11" disabled>关联告警（未接入）</button><button className="btn-secondary min-h-11" disabled>查看录像（未接入）</button></div>
    </FacePreviewModal>}
  </section>
}
