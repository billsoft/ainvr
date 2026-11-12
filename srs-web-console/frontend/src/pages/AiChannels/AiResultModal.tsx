import { useEffect, useState } from 'react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import type { AiDetection, AiFrameResult } from '@/types/aiChannel'
import { parseGroundingOverlay } from '@/components/player/groundingPoints'

interface Props {
  channelName: string
  loading: boolean
  result: AiFrameResult | null
  onClose: () => void
}

/** 两种模型共用同一个摘要函数入口——按 task_type 分支产出文案，不必为
 * 每个模型写单独组件（架构方案 §4.4）。 */
function summarize(taskType: string, detections: AiDetection[]): string {
  if (detections.length === 0) return '未检测到目标'
  if (taskType === 'face_detection' && detections.every(d=>!d.model_extra?.task_type||d.model_extra.task_type==='face_detection')) {
    const withKps = detections.filter((d) => d.landmarks && d.landmarks.length > 0).length
    return `检测到 ${detections.length} 张人脸（${withKps} 张含关键点）`
  }
  const counts = new Map<string, number>()
  for (const d of detections) counts.set(d.class_name, (counts.get(d.class_name) ?? 0) + 1)
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(', ')
}

export function AiResultModal({ channelName, loading, result, onClose }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  useEffect(()=>{const listener=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener)},[onClose])
  const grounding = parseGroundingOverlay(result?.model_extra)
  const pointSummary = grounding?.points.length
    ? `定位到 ${grounding.points.length} 个目标点${grounding.omitted ? `（另有 ${grounding.omitted} 个未展示）` : ''}`
    : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="查看结果">
      <div className="w-[560px] max-w-full max-h-[80vh] flex flex-col rounded-panel bg-surface p-6 shadow-modal">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{channelName} · 最新检测结果</h3>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-ink-subtle">加载中…</p>
          ) : !result ? (
            <p className="text-sm text-ink-subtle">该通道暂无检测结果（可能尚未启动或还没推理出第一帧）</p>
          ) : (
            <>
              <p className="rounded-base border border-line bg-surface-page px-3 py-2.5 text-sm font-medium text-ink">
                {pointSummary
                  ? `${result.detections.length ? `${summarize(result.task_type, result.detections)}；` : ''}${pointSummary}`
                  : summarize(result.task_type, result.detections)}
              </p>
              <p className="mt-2 text-xs text-ink-faint">
                帧 #{result.frame_index} · {result.frame_width}×{result.frame_height} · 总耗时 {result.timing_ms.total.toFixed(1)}ms
              </p>

              {result.detections.some(d=>d.model_extra?.attributes)&&<div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-ink-faint"><tr><th className="py-2">目标</th><th>识别内容</th><th>状态</th></tr></thead><tbody>{result.detections.filter(d=>d.model_extra?.attributes).slice(0,20).map((d,i)=><tr key={i} className="border-t border-line"><td className="py-2">{d.class_name==='license_plate'?'车牌':d.class_name}</td><td>{String(d.model_extra?.attributes?.plate_text?.value??'—')}</td><td>{d.model_extra?.attributes?.plate_text?.value?'候选读数':d.model_extra?.attributes?.plate_text?.status==='recognition_budget'?'本帧未读牌（配额）':d.model_extra?.attributes?.plate_text?.status==='low_detection_score'?'检测置信度不足以读牌':'未读出'}</td></tr>)}</tbody></table><p className="mt-2 text-xs text-ink-faint">当前帧的识别候选；通行记录另有多帧核验与人工校正。</p></div>}

              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="mt-3 flex min-h-11 items-center gap-1 text-xs text-primary hover:underline"
              >
                {showRaw ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                原始 JSON
              </button>
              {showRaw && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-base bg-surface-page p-3 text-[11px] leading-relaxed text-ink-subtle">
                  {JSON.stringify(result, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
