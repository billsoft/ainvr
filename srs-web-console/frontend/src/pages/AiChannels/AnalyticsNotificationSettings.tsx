import type { AiAnalyticsConfig } from '@/types/aiChannel'
type Props={value:AiAnalyticsConfig;supported:boolean;onChange:(value:AiAnalyticsConfig)=>void}
export function AnalyticsNotificationSettings({value,supported,onChange}:Props) {
 const notification=value.notification??{enabled:false,require_review:true,endpoint:''}
 const canEnable=supported&&(value.save_events??true)
 const update=(patch:Partial<typeof notification>)=>onChange({...value,notification:{...notification,...patch}})
 return <section aria-label="报警通知设置" className="space-y-2 rounded border border-line p-3">
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notification.enabled}
   disabled={!notification.enabled&&!canEnable} onChange={e=>update({enabled:e.target.checked})}/>发送报警通知</label>
  {!supported&&<p role="status" className="text-xs">当前服务尚未声明支持报警通知，升级服务后可开启。</p>}
  {value.save_events===false&&<p className="text-xs">请先开启“保存区域事件”。</p>}
  {notification.enabled&&<>
   <label className="block text-sm">发送策略
    <select aria-label="通知发送策略" value={notification.require_review?'review':'direct'}
     onChange={e=>update({require_review:e.target.value==='review'})} className="ml-2 rounded border border-line bg-surface p-2">
     <option value="review">目标复核通过后通知</option><option value="direct">规则触发后直接通知</option>
    </select>
   </label>
   {notification.require_review&&!value.review?.enabled&&<p role="alert" className="text-xs text-danger">请先开启目标复核，或明确选择直接通知。</p>}
   <p className="text-xs text-ink-faint">{notification.require_review?'复核否决、失败、超时或不可用时不发送。目标复核仅确认截图中的目标，不确认轨迹规则本身。':'直接通知不经过大模型复核，可能包含误报。'}</p>
   <label className="block text-sm">报警接收地址（HTTP 回调）
    <input aria-label="报警接收地址" type="url" maxLength={2048} value={notification.endpoint}
     placeholder="https://your-server.example/events" autoComplete="off"
     onChange={e=>update({endpoint:e.target.value})} className="mt-1 w-full rounded border border-line bg-surface p-2"/>
   </label>
   <p className="text-xs text-ink-faint">保存并启动处理器后按此策略发送事件摘要，不发送截图。接收方需按事件编号去重。这里不会自动发送测试通知。</p>
   <p className="text-xs text-ink-faint">关闭会暂停发送；再次开启会恢复未完成任务。旧任务保留原接收地址和策略，修改只影响新事件。发送失败可在事件记录中查看。</p>
  </>}
 </section>
}
