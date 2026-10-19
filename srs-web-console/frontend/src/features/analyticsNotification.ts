import type { AiAnalyticsConfig } from '@/types/aiChannel'
export function notificationError(config:AiAnalyticsConfig):string|null {
 const n=config.notification
 if(!config.enabled||!n?.enabled)return null
 if(config.save_events===false)return '报警通知需要保存区域事件'
 if(n.require_review&&!config.review?.enabled)return '请先开启目标复核，或明确选择直接通知'
 if(!n.endpoint||n.endpoint.length>2048||/[\r\n]/.test(n.endpoint))return '请填写有效的报警接收地址'
 try {
  const url=new URL(n.endpoint)
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.hash)
   return '接收地址仅支持 HTTP(S)，不能包含登录凭据或片段标记'
 }catch{return '请填写有效的报警接收地址'}
 return null
}
