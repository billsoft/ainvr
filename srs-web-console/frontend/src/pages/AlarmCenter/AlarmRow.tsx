import {FaceAlarmPhoto,faceAlarmSummary} from '@/features/faces/FaceAlarmEvidence'
import {reviewerDisplay,reviewDiagnostic,reviewLabel,referenceLabel,recoveryLabel,preparationLabel} from '@/features/alarmReview'
import {AlertTriangle,Check,ChevronRight,Flag,ImageOff} from 'lucide-react'
import type {AlarmEvent,AckDisposition} from '@/api/alarmEventService'
import {behaviorNames,levelLook} from '@/features/alarmTriggers'
import {alarmBusinessTitle,alarmBusinessKindOf} from '@/features/alarmBusinessKind'
import {describeAlarm,type AlarmContext} from '@/features/alarmSentences'
import {EvidenceThumb,reviewThumbnail} from './EvidenceThumb'

interface Props {
 alarm:AlarmEvent;trigger:AlarmContext|undefined;channelName:string
 onHandle:(disposition:AckDisposition)=>void
 onOpen:(stageId?:string)=>void
}
/** One activity per horizontal row. All stage evidence stays in one detail view. */
export function AlarmRow({alarm,trigger,channelName,onHandle,onOpen}:Props){
 const kind=alarmBusinessKindOf(alarm),spatial=kind==='spatial',watchlist=kind==='face_watchlist'||kind==='vehicle_watchlist'
 const face=alarm.event_kind==='face_watchlist'?alarm.analysis_evidence?.face:undefined
 const faceSummary=kind==='face_watchlist'?alarm.face_summary:undefined
 const faceRecordId=kind==='face_watchlist'?(faceSummary?.record_id??face?.record_id??alarm.evidence?.refs?.find(ref=>ref.kind==='face_record'&&ref.record_id)?.record_id):undefined
 const faceText=face?faceAlarmSummary(face):kind==='face_watchlist'?[
  faceSummary?.member_name?`疑似「${faceSummary.member_name}」`:'人脸名单候选',
  faceSummary?.library_name&&`人脸库「${faceSummary.library_name}」`,
  typeof faceSummary?.similarity==='number'&&Number.isFinite(faceSummary.similarity)?`候选相似度 ${faceSummary.similarity.toFixed(2)}（不是身份概率）`:null,
  '需人工复核',
 ].filter(Boolean).join(' · '):null
 const described=describeAlarm(alarm,trigger),look=levelLook[alarm.behavior]??levelLook.appearance!
 const done=alarm.handling.state==='acknowledged'&&alarm.handling.reviewed_by_kind!=='ai',live=alarm.lifecycle.state==='active'
 const stages=alarm.stages??[],latest=[...stages].reverse()
 const shot=latest.find(s=>s.behavior===alarm.behavior&&s.behavior_event_ids?.[0])??latest.find(s=>s.behavior_event_ids?.[0])
 const reviewFrame=shot?reviewThumbnail(alarm,shot.at):undefined
 const diagnostic=reviewDiagnostic(alarm.review)
 const time=new Date(alarm.occurred_at)
 // Later occurrences of the same rule are folded into one alarm until it is handled.
 const folded=(alarm.fold_count??0)>0&&alarm.last_occurred_at?new Date(alarm.last_occurred_at):null
 const title=alarmBusinessTitle(alarm,behaviorNames[alarm.behavior]??alarm.behavior)
 const pendingReview=alarm.handling.state!=='acknowledged'
 // One alert colour only: red means "needs a person". Everything else is greyscale or the brand blue.
 const statusTone=pendingReview?'bg-danger-50 text-danger-700':alarm.handling.reviewed_by_kind==='ai'?'bg-primary-50 text-primary-700':'bg-surface-page text-ink-subtle'
 const statusText=`${!spatial&&pendingReview?(watchlist?'名单候选 · 待人工复核':'业务候选 · 待人工审核'):reviewLabel(alarm)}${alarm.handling.state==='acknowledged'?` · ${alarm.handling.disposition==='false_positive'?'误报':'确认'}`:''}`
 const where=`${channelName}${!watchlist&&described.zone?` · ${described.zone}`:''}`
 return <article aria-label={`${channelName} · ${alarmBusinessTitle(alarm,behaviorNames[alarm.behavior]??'告警')}`} className={`alarm-list-row grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-3 border-b border-line px-4 py-4 last:border-b-0 [@container(min-width:48rem)]:grid-cols-[112px_minmax(0,1fr)_auto] [@container(min-width:48rem)]:items-center [@container(min-width:48rem)]:px-5 ${done?'bg-surface-page/40':'bg-surface'}`}>
  <div className="relative w-[88px] shrink-0 self-start overflow-hidden rounded-base [@container(min-width:48rem)]:w-28 [@container(min-width:48rem)]:self-center">
   {faceRecordId?<FaceAlarmPhoto compact recordId={faceRecordId} onOpen={()=>onOpen()}/>:kind!=='face_watchlist'&&shot?<EvidenceThumb compact eventId={shot.behavior_event_ids![0]!} reviewFrame={reviewFrame} label={alarmBusinessTitle(alarm,behaviorNames[shot.behavior]??'告警')} onOpen={()=>onOpen(shot.event_id)}/>:
    <button type="button" aria-label="查看告警详情（暂无截图）" onClick={()=>onOpen()} className="flex aspect-[4/3] !min-h-11 w-full flex-col items-center justify-center gap-1 rounded-base bg-surface-page text-ink-faint"><ImageOff size={20} aria-hidden="true"/><span className="text-xs">无截图</span></button>}
   {stages.length>1&&<span title="在详情中查看全部记录" className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-900/75 px-1.5 py-0.5 text-[10px] text-white">{stages.length} {spatial?'阶段':'记录'}</span>}
  </div>
  <div className="min-w-0 space-y-1.5">
   <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{background:look.color}}/>
    <h2 className="break-words text-[15px] font-semibold leading-6 text-ink">{title}</h2>
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone}`}>{statusText}</span>
    {live&&<span className="shrink-0 text-xs text-success-700">进行中</span>}
   </header>
   <p className="break-words text-sm leading-6 text-ink-subtle" title={faceText??described.sentence}>{faceText??described.sentence}</p>
   {alarm.handling.state==='unacknowledged'&&preparationLabel(alarm.review)&&<p role="status" className="flex items-start gap-1.5 text-xs leading-5 text-amber-700"><AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0"/>{preparationLabel(alarm.review)}</p>}
   {recoveryLabel(alarm.review)&&<p className="text-xs leading-5 text-ink-faint">{recoveryLabel(alarm.review)}</p>}
   {diagnostic?<p className="text-xs leading-5 text-ink-faint">{diagnostic.summary}</p>:alarm.review?.reference&&<p className="text-xs leading-5 text-ink-faint">{referenceLabel(alarm.review.reference)}</p>}
   <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5 text-ink-faint">
    <span className="break-words text-ink-subtle" title={where}>{where}</span>
    <span aria-hidden="true">·</span>
    <time dateTime={alarm.occurred_at} title={time.toLocaleString('zh-CN')} className="shrink-0 tabular-nums">{time.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>
    {folded&&<><span aria-hidden="true">·</span><span aria-label="发生次数" title={`确认前同一规则又发生的记录已合并到这条告警，最近一次 ${folded.toLocaleString('zh-CN')}`} className="shrink-0 font-medium text-ink-subtle tabular-nums">共 {1+(alarm.fold_count??0)} 次 · 最近 {folded.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</span></>}
    <span aria-hidden="true">·</span>
    <span className="break-words" title={`${watchlist?'名单':'告警规则'}「${alarm.rule.name}」`}>{watchlist?'名单':'告警规则'}「{alarm.rule.name}」</span>
   </div>
   {spatial&&stages.length>1&&<p aria-label="阶段" className="break-words text-xs text-ink-faint">经过：{stages.map(s=>behaviorNames[s.behavior]??s.behavior).join(' → ')}</p>}
  </div>
  <footer className="col-span-2 flex flex-wrap items-center justify-end gap-1.5 [@container(min-width:48rem)]:col-span-1">
   {done?<span role="status" className="px-2 text-xs text-ink-subtle">{alarm.handling.disposition==='false_positive'?'已标记误报':'已确认'}{alarm.handling.acknowledged_by?` · ${reviewerDisplay(alarm.handling.acknowledged_by)}`:''}</span>:<>
    <button type="button" aria-label="标记误报" title="标记误报" onClick={()=>onHandle('false_positive')} className="inline-flex !min-h-11 items-center gap-1.5 rounded-base px-3 text-sm text-ink-subtle hover:bg-surface-hover hover:text-ink"><Flag size={16} aria-hidden="true"/>误报</button>
    <button type="button" aria-label="确认" title="确认" onClick={()=>onHandle('handled')} className="inline-flex !min-h-11 items-center gap-1.5 rounded-base bg-primary-50 px-4 text-sm font-medium text-primary-700 hover:bg-primary-100"><Check size={16} aria-hidden="true"/>确认</button>
   </>}
   <button type="button" aria-label="详情与录像" title="查看详情、阶段截图与录像" onClick={()=>onOpen()} className="inline-flex !min-h-11 min-w-11 items-center justify-center rounded-base text-ink-faint hover:bg-surface-hover hover:text-ink"><ChevronRight size={20} aria-hidden="true"/></button>
  </footer>
 </article>
}
