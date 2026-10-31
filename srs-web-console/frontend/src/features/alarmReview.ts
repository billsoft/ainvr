import type {AlarmEvent} from '@/api/alarmEventService'
export function reviewLabel(alarm:AlarmEvent){
 return alarm.handling.state==='acknowledged'?(alarm.handling.reviewed_by_kind==='ai'?'已 AI 审核':'已人工审核'):'未审核'
}
const preparationReasons:Record<string,string>={
 secondary_class_confirmed:'扩大范围复核支持目标类别，AI 确认告警',
 secondary_class_rejected:'扩大范围复核不支持目标类别，AI 判为误报',
 insufficient_class_evidence:'目标类别证据不足，保留人工审核',
 incomplete_frames:'审核关键帧不完整，保留人工审核',
 conflicting_or_weak_primary:'特写主审结果冲突或证据较弱，保留人工审核',
 insufficient_non_target_evidence:'无法清晰排除人员，保留人工审核',
 authorization_changed:'自动审核授权已变化，保留人工审核',
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

/** Diagnostics describe persisted evidence only; never authorize a decision. */
export function reviewDiagnostic(review:AlarmEvent['review']){
 if(!review)return null
 const gate=review.auto_confirmation
 const pending=review.reason==='manual_review_required'||review.reference?.reason==='manual_review_required'
 if(!gate&&!pending&&!review.secondary&&!review.decision_path)return null
 const frames=review.frames??[],scores=gate?.frame_scores??review.frame_scores??[]
 const roles:Record<string,string>={before:'进入前',after:'进入后',entry_before:'进入前',entry_after:'进入后',exit_before:'离开前',exit_after:'离开后',trigger:'触发时刻',start:'开始',first:'首次检出',entered:'进入后',exited:'离开后'}
 const number=(v:number|null|undefined)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(6).replace(/\.?0+$/,''):'未记录'
 const ruleThreshold=review.policy?.approve_above
 const validRuleThreshold=typeof ruleThreshold==='number'&&Number.isFinite(ruleThreshold)&&ruleThreshold>=0&&ruleThreshold<=1
 const visual=gate?.outcome==='frame_below_threshold'||gate?.outcome==='no_strong_frame'||(!gate&&pending&&validRuleThreshold&&scores.some(score=>Number.isFinite(score)&&score<ruleThreshold))
 const summary=gate?.outcome==='confirmed'?'自动确认条件已满足':gate?.outcome==='not_authorized'?'未获自动确认授权':!frames.length?'缺少可查看的关键帧':!scores.some(Number.isFinite)?'关键帧目标核对未记录模型分数':visual?'关键帧目标核对仍不确定':'未自动确认，待人工审核'
 const path=review.decision_path?({primary_confirmation:'特写主审确认',expanded_confirmation:'扩大范围复核确认',explicit_non_target:'明确非人员证据核验后判为误报'})[review.decision_path]:undefined
 const withPath=(text:string)=>path?`实际审核路径：${path} · ${text}`:text
 const details=[review.geometry_verified===true?'行为几何条件：已核验；图片用于核对目标类别。':review.geometry_verified===false?'行为几何条件：未核验通过。':'行为几何核验结果：未记录。']
 if(path)details.push(`实际审核路径：${path}。`)
 if(review.decision_basis){
  const basis=({validated_model:'已验证模型策略',operator_authorized_primary_review:'用户授权的特写主审策略',operator_authorized_dual_review:'用户授权的复核策略',operator_authorized_confirm_only:'用户授权的仅确认策略',reference_only:'仅参考分析，不自动处理'})[review.decision_basis]
  if(basis)details.push(`决策依据：${basis}（与实际审核路径分别记录）。`)
 }
 if(!frames.length)details.push('未留存可查看的关键帧；不据此推断行为几何证据缺失。')
 if(review.missing_frame_ids?.length)details.push(`记录缺失关键帧：${review.missing_frame_ids.length} 帧。`)
 const ids=review.reviewed_frame_ids
 const matched=new Set<number>()
 for(let i=0;i<scores.length;i++){
  const index=ids!==undefined?(ids[i]===undefined?-1:frames.findIndex(f=>f.frame_id===ids[i])):frames.length===scores.length?i:-1
  const frame=index>=0?frames[index]:undefined
  if(frame)matched.add(index)
  const label=frame?.roles?.map(r=>roles[r]??r).join(' / ')||(frame?`关键帧 ${index+1}`:ids?.[i]?`审核帧 ${ids[i]}`:`审核分数 ${i+1}（未记录关键帧对应关系）`)
  details.push(`${label}：模型分数 ${number(scores[i])}（不是概率）${gate?.failed_frame_indices.includes(i)?' · 低于记录的逐帧阈值':''}`)
 }
 frames.forEach((frame,i)=>{if(!matched.has(i))details.push(`${frame.roles?.map(r=>roles[r]??r).join(' / ')||`关键帧 ${i+1}`}：模型分数未记录或无法对应。`)})
 if(gate){
  details.push(`当次自动确认记录 v${gate.version}：${({confirmed:'条件满足',frame_below_threshold:'存在低于逐帧阈值的关键帧',no_strong_frame:'没有达到强帧阈值的关键帧',not_authorized:'未获授权'})[gate.outcome]}`)
  details.push(`当次记录的逐帧最低阈值：${number(gate.minimum_frame_score)}；强帧阈值：${number(gate.strong_frame_score)}。`)
 }else{
  if(validRuleThreshold)details.push(`规则阈值：${number(ruleThreshold)}（不代表当次自动确认授权）。`)
  details.push('历史记录未保存自动确认门槛与授权结果，无法还原具体未通过条件。')
 }
 const secondary=review.secondary
 if(secondary){
  details.unshift(`特写主审：${summary}。`)
  secondary.frames.forEach((f,i)=>{
   const index=frames.findIndex(frame=>frame.frame_id===f.frame_id)
   const label=(index>=0?frames[index]?.roles?.map(role=>roles[role]??role).join(' / '):undefined)||`关键帧 ${index>=0?index+1:i+1}`
   details.push(`扩大范围复核 · ${label}：模型分数 ${number(f.score)}（不是概率）`)
  })
  if(!secondary.frames.length)secondary.frame_scores.forEach((score,i)=>details.push(`扩大范围复核分数 ${i+1}（未记录关键帧对应关系）：模型分数 ${number(score)}（不是概率）`))
  const nonTarget=secondary.non_target_evidence
  if(nonTarget){
   nonTarget.frame_scores.forEach((score,i)=>{
    const id=nonTarget.frame_ids[i]
    const index=id===undefined?-1:frames.findIndex(frame=>frame.frame_id===id)
    const label=(index>=0?frames[index]?.roles?.map(role=>roles[role]??role).join(' / '):undefined)||`关键帧 ${index>=0?index+1:i+1}`
    details.push(`${label}：明确非人员证据分数 ${number(score)}（不是目标匹配分数，也不是概率）`)
   })
   details.push('明确非人员核验仅用于负向复核：必须清晰可辨且不是人员；昏暗或不清晰不能据此排除人员。')
   details.push(`当次明确非人员核验说明：${nonTarget.prompt}`)
  }
  const validThreshold=(v:number|undefined)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1
  const ruleReject=review.policy?.reject_below
  const authReject=review.authorization?.secondary?.reject_below
  const primaryCeiling=validThreshold(ruleReject)?number(Math.min(.05,ruleReject!)):'未记录（需 min(0.05, 当次规则误报阈值)）'
  const expandedCeiling=validThreshold(secondary.reject_below)?number(Math.min(.01,secondary.reject_below)):'未记录'
  const negativeFloor=validThreshold(authReject)?number(Math.max(.99,1-authReject!)):'未记录（至少 0.99；需当次授权误报阈值确定）'
  details.push(`自动误报须同时满足全部关键帧三道门槛：特写人员分数 ≤ ${primaryCeiling}；扩大范围人员分数 ≤ ${expandedCeiling}；明确非人员证据分数 ≥ ${negativeFloor}。缺帧、分数无效或无法清晰排除人员时保留人工审核。`)
  details.push(`扩大范围复核阈值：确认 ${number(secondary.confirm_above)}；误报 ${number(secondary.reject_below)}。`)
  if(secondary.reason)details.push(`扩大范围复核原因：${reviewReason(secondary.reason)||secondary.reason}`)
  return {summary:withPath(`特写 + 扩大范围复核 · ${secondary.state==='unavailable'?'扩大范围复核不可用，待人工审核':({confirmed:'AI复核结果：确认',false_positive:'AI复核结果：误报',uncertain:'结论不确定，待人工审核'})[secondary.outcome]}`),details}
 }
 return {summary:withPath(summary),details}
}

export function automaticReviewBanner(mode:'confirm_only'|'confirm_or_reject',labels?:readonly string[]){
 const scope=labels?.length?`授权类别：${labels.map(label=>label==='person'?'人员':label).join('、')}；`:'仅对当前已授权的目标类别生效；'
 return scope+(mode==='confirm_or_reject'?'AI 自动审核已启用 · 特写 + 扩大范围复核：自动确认或判为误报并移入“已 AI 审核”；结论不确定、证据不足或复核不可用时保留人工审核；模型准确率尚未全面验证，可人工改判。':'AI 自动审核已启用：优先处理最新告警，关键帧判断一致时自动确认并移入“已 AI 审核”。疑似误报、证据不足或判断冲突保留人工审核；模型准确率尚未全面验证，可人工改判。')
}
