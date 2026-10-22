import type {AlarmEvent} from '@/api/alarmEventService'
export function reviewLabel(alarm:AlarmEvent){
 return alarm.handling.state==='acknowledged'?(alarm.handling.reviewed_by_kind==='ai'?'已 AI 审核':'已人工审核'):'未审核'
}
export function reviewReason(reason?:string){return ({ambiguous_result:'证据无法支持明确结论，仍为未审核',missing_context:'关键帧缺失或已过保留期，交由人工审核',incomplete_trajectory:'轨迹不完整，交由人工审核',missing_trajectory:'缺少轨迹证据',missing_entry:'缺少进入过程证据',missing_exit:'缺少离开过程证据',geometry_unconfirmed:'几何条件未能复核',panorama_review_unavailable:'全景空间审核暂未验证，交由人工审核',missing_label:'缺少当时的标签映射',model_changed:'审核期间模型版本变化',missing_evidence:'缺少原帧证据截图，请检查截图归档',review_context_too_large:'审核上下文超过模型容量，交由人工审核',unsupported_image:'截图规格暂不支持，保持待人工处理',review_unavailable:'模型或调用连接暂不可用',invalid_model_result:'模型返回结果无效',retry_exhausted:'重试次数已用尽',human_handled:'人工已处理，AI 已跳过'} as Record<string,string>)[reason??'']??''}
