import {labelDisplay} from '@/features/labelNames'
import type {AlarmEvent} from '@/api/alarmEventService'
const states={pass:'已核对',conflict:'存在矛盾',unknown:'证据不足',not_applicable:'不适用'}
const colors={pass:'text-success-700',conflict:'text-danger-700',unknown:'text-warning-700',not_applicable:'text-ink-subtle'}
export function RuleEvidence({alarm}:{alarm:AlarmEvent}){
 const evidence=alarm.review_evidence
 if(!evidence)return <p className="text-xs text-ink-subtle">此记录尚未提供逐条件核对，请结合历史规则和录像审核。</p>
 const rule=evidence.rule
 const regionObservation=evidence.observations.some(o=>o.region_count!==undefined)
 return <section aria-label="规则与触发依据" className="overflow-hidden rounded-base border border-line">
  <div className="space-y-1 bg-surface-page px-3 py-3">
   <h3 className="text-sm font-semibold">规则与触发依据</h3>
   {rule&&<p className="text-sm">{rule.labels.map(x=>labelDisplay(x.name)).join(rule.label_mode==='all'?' 与 ':' 或 ')} · {rule.behavior_name} · {rule.region_required?'限定布防区域':'整个画面'}{rule.group?` · 至少${rule.group.minimum}个，${rule.behavior==='region_traverse'?`${rule.group.window_ms/1000}秒内完成穿过`:rule.group.window_ms?`同时满足（容许漏检${rule.group.window_ms/1000}秒）`:'同一帧同时满足'}`:''}</p>}
   <p className="text-xs text-ink-subtle">按告警发生时的规则核对；条件计算与 AI 类别识别分开列示。</p>
  </div>
  {evidence.blocking&&<p role="alert" className="border-t border-line bg-red-50 px-3 py-2 text-sm text-danger-700">证据存在冲突或格式问题，不能据此自动确认；请核对关键帧与录像。</p>}
  <details open={evidence.blocking} className="border-t border-line">
   <summary className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-xs"><span className="font-medium">逐条件核对</span><span className="text-success-700">{evidence.checks.filter(c=>c.status==='pass').length} 项已核对</span>{evidence.checks.some(c=>c.status==='unknown')&&<span className="text-warning-700">{evidence.checks.filter(c=>c.status==='unknown').length} 项证据不足</span>}<span className="ml-auto text-ink-subtle">展开依据</span></summary>
  <dl className="divide-y divide-line">
   {evidence.checks.map((c,i)=><div key={`${c.id}:${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2 text-xs">
    <dt className="font-medium">{c.title}</dt><dd className={colors[c.status]}>{states[c.status]}</dd>
    <dd className="col-span-2 mt-1 break-words text-ink-subtle">要求：{c.expected}<br/>实测／记录：{c.actual}</dd>
   </div>)}
  </dl>
  </details>
  <details className="border-t border-line px-3 text-xs">
   <summary className="min-h-11 cursor-pointer py-3">原始观测与口径（{evidence.observations.length}）</summary>
   <p className="mb-2 text-ink-subtle">{evidence.scope_note}</p>
   <div className="max-h-60 overflow-auto pb-3"><table className="w-full text-left"><thead><tr><th className="py-2">时刻／角色</th><th>{regionObservation?'区域观测数量':'区域关系'}</th><th>{regionObservation?'观测类型':'边界距离'}</th></tr></thead><tbody>{evidence.observations.map((o,i)=><tr key={`${o.frame_id}:${i}`} className="border-t border-line"><td className="py-2">{new Date(o.captured_at).toLocaleTimeString()}<span className="block text-ink-subtle">{o.roles.join(' / ')||'成员观测'}</span></td><td>{o.region_count!==undefined?`${o.region_count} 个`:o.inside===null?'不适用':o.inside?'区域内':'区域外'}</td><td>{o.region_count!==undefined?'有效区域采样':o.distance_px==null?'—':`${o.distance_px.toFixed(1)} px`}</td></tr>)}</tbody></table></div>
  </details>
 </section>
}
