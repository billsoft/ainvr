import { AI_MODEL_PRESETS, type AiAnalyticsConfig } from '@/types/aiChannel'
type Props={value:AiAnalyticsConfig;supported:boolean;archiveEnabled:boolean;onChange:(value:AiAnalyticsConfig)=>void}
export function AnalyticsReviewSettings({value,supported,archiveEnabled,onChange}:Props) {
 const review=value.review??{enabled:false,model_path:AI_MODEL_PRESETS['locateanything-3b'].model.path,description:'',max_new_tokens:64,timeout_seconds:60}
 const canEnable=supported&&archiveEnabled&&(value.save_events??true)
 const update=(patch:Partial<typeof review>)=>onChange({...value,review:{...review,...patch}})
 return <section className="space-y-2 rounded border border-line p-3" aria-label="目标复核设置">
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={review.enabled}
    disabled={!review.enabled&&!canEnable} onChange={e=>update({enabled:e.target.checked})}/>异步复核目标</label>
  <p className="text-xs text-ink-faint">在归档截图中再次确认指定目标。仅确认目标是否存在，不确认越线方向或停留时长；不会阻塞实时检测。</p>
  {!supported&&<p role="status" className="text-xs">当前服务尚未声明支持目标复核，升级服务后可开启。</p>}
  {!archiveEnabled&&<p className="text-xs">请先在截图归档设置中开启归档，再开启目标复核。</p>}
  {value.save_events===false&&<p className="text-xs">目标复核需要开启“保存区域事件”。</p>}
  {review.enabled&&<>
   <p className="text-sm">复核模型：开放词汇目标复核（试用）</p>
   <label className="block text-sm">复核目标描述
    <textarea aria-label="复核目标描述" maxLength={4096} value={review.description}
      onChange={e=>update({description:e.target.value})} placeholder="例如：a person wearing a red jacket"
      className="mt-1 w-full rounded border border-line bg-surface p-2"/>
   </label>
   <label className="block text-sm">最长等待时间（秒）
    <input aria-label="复核最长等待时间" type="number" min={5} max={300} value={review.timeout_seconds??60}
      onChange={e=>update({timeout_seconds:Number(e.target.value)})} className="ml-2 w-20 rounded border border-line bg-surface p-1"/>
   </label>
   <p className="text-xs text-ink-faint">需已安装并验证复核模型。模型被其他通道占用、截图缺失或超时会明确记录，均不视为通过。当前不自动发送报警通知。保存后按通道配置变更流程生效。</p>
  </>}
 </section>
}
