import type {AlarmEvent} from '@/api/alarmEventService'
export function reviewLabel(alarm:AlarmEvent){
 return alarm.handling.state==='acknowledged'?(alarm.handling.reviewed_by_kind==='ai'?'已 AI 审核':'已人工审核'):'未审核'
}
const preparationReasons:Record<string,string>={
 evidence_preparation_retry:'取证准备暂时失败，将自动重试',
 evidence_preparation_failed:'取证准备失败，已停止自动重试；请检查服务或人工审核',
 storage_busy:'证据存储暂时繁忙，将自动重试',
 storage_unavailable:'证据存储暂时不可用，等待恢复后重试',
 evidence_identity_mismatch:'原始证据身份不匹配，停止自动审核，请人工核对',
}
export function preparationLabel(review:AlarmEvent['review']){
 return review&&['queued','failed','uncertain'].includes(review.state??'')?preparationReasons[review.reason??'']??'':''
}
export function reviewReason(reason?:string){return preparationReasons[reason??'']??({evidence_integrity_mismatch:'原始证据完整性校验失败，停止自动审核，请检查存储',manual_review_required:'未达到自动确认条件，保留人工审核',evidence_pending:'等待告警原始截图保存，将自动重试',unvalidated_profile:'当前模型输入方式待验证，保持未审核',input_too_long:'审核文本超过模型容量，请缩短说明；交由人工审核',invalid_request:'审核请求不符合接口要求，交由人工审核',insufficient_target_pixels:'目标原始像素不足，交由人工审核',ambiguous_result:'证据无法支持明确结论，仍为未审核',missing_context:'关键帧缺失或已过保留期，交由人工审核',incomplete_trajectory:'轨迹不完整，交由人工审核',missing_trajectory:'缺少轨迹证据',missing_keyframe:'缺少完整的行为关键帧，交由人工审核',missing_entry:'缺少进入过程证据',missing_exit:'缺少离开过程证据',geometry_unconfirmed:'几何条件未能复核',panorama_review_unavailable:'全景空间审核暂未验证，交由人工审核',missing_label:'缺少当时的标签映射',model_changed:'审核期间模型版本变化',missing_evidence:'缺少原帧证据截图，请检查截图归档',review_context_too_large:'审核上下文超过模型容量，交由人工审核',unsupported_image:'截图规格暂不支持，保持待人工处理',review_unavailable:'模型或调用连接暂不可用',invalid_model_result:'模型返回结果无效',retry_exhausted:'重试次数已用尽',human_handled:'人工已处理，AI 已跳过'} as Record<string,string>)[reason??'']??''}

export function recoveryLabel(review:AlarmEvent['review']){
 const state=review?.recovery?.state;
 if(state==='running'||state==='queued')return '关键帧不足 · 正在从录像补充证据，补齐后自动重审';
 if(state==='unavailable')return '录像未能补齐准确关键帧 · 保留人工审核';
 if(state==='completed')return '已从录像补齐关键帧';
 return '';
}
export function referenceLabel(value:NonNullable<AlarmEvent['review']>['reference']){
 if(!value)return ''
 if(value.state==='completed'&&value.reason==='manual_review_required')return 'AI 分析完成 · 未达到自动确认条件，需人工审核'
 if(value.state==='completed'&&value.reason==='historical_behavior_evidence_incomplete')return 'AI 已核对目标类别 · 行为关键帧不完整，尚未审核'
 if(value.state==='completed')return `AI 参考分数 ${value.score?.toFixed(3)??'—'} · 待验证，不是概率`
 if(value.state==='running')return 'AI 正在分析参考截图，尚未审核'
 if(value.state==='queued')return 'AI 参考分析等待重试'
 return `AI 参考分析未完成：${reviewReason(value.reason)||'证据不足，需人工审核'}`
}

/** Colour indicates review source; the text separately identifies the verdict. */
export function reviewStatusClass(alarm:AlarmEvent){
 if(alarm.handling.state!=='acknowledged')return 'border-red-200 bg-red-50 text-red-700'
 return alarm.handling.reviewed_by_kind==='ai'
  ? 'border-amber-200 bg-amber-50 text-amber-700'
  : 'border-green-200 bg-green-50 text-green-700'
}