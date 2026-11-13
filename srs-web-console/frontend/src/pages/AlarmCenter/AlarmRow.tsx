import {FaceAlarmPhoto,faceAlarmSummary} from '@/features/faces/FaceAlarmEvidence'
import {reviewerDisplay,reviewDiagnostic,reviewLabel,referenceLabel,recoveryLabel,reviewStatusClass,preparationLabel} from '@/features/alarmReview'
import {Check,ChevronRight,Flag,ImageOff} from 'lucide-react'
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
 return <article aria-label={`${channelName} · ${alarmBusinessTitle(alarm,behaviorNames[alarm.behavior]??'告警')}`} className={`alarm-list-row grid grid-cols-[80px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-line px-3 py-3 last:border-b-0 [@container(min-width:56rem)]:grid-cols-[96px_minmax(0,1fr)_auto] ${done?'bg-surface-page/50':'bg-surface'}`}>
  <div className="relative w-20 shrink-0 [@container(min-width:56rem)]:w-24">
   {faceRecordId?<FaceAlarmPhoto compact recordId={faceRecordId} onOpen={()=>onOpen()}/>:kind!=='face_watchlist'&&shot?<EvidenceThumb compact eventId={shot.behavior_event_ids![0]!} reviewFrame={reviewFrame} label={alarmBusinessTitle(alarm,behaviorNames[shot.behavior]??'告警')} onOpen={()=>onOpen(shot.event_id)}/>:
    <button type="button" aria-label="查看告警详情（暂无截图）" onClick={()=>onOpen()} className="flex aspect-[4/3] !min-h-11 w-full flex-col items-center justify-center gap-1 rounded-base bg-surface-page text-ink-faint"><ImageOff size={20} aria-hidden="true"/><span className="text-xs">无截图</span></button>}
   {stages.length>1&&<span title="在详情中查看全部记录" className="pointer-events-none absolute bottom-1 right-1 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-white">{stages.length} {spatial?'阶段':'记录'}</span>}
  </div>
  <div className="min-w-0">
   <header className="flex min-w-0 flex-wrap items-center gap-2">
    <h2 className="w-full break-words text-sm font-semibold text-ink" title={`${channelName}${!watchlist&&described.zone?` · ${described.zone}`:''}`}>{channelName}{!watchlist&&described.zone&&<span className="font-normal text-ink-subtle"> · {described.zone}</span>}</h2>
    <span className="shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium" style={{background:look.soft,color:look.ink,borderColor:look.color}}>{alarmBusinessTitle(alarm,behaviorNames[alarm.behavior]??alarm.behavior)}</span>
    {live&&<span className="shrink-0 text-xs text-success-700">进行中</span>}
   </header>
   <p className={`mt-1 inline-flex rounded border px-2 py-0.5 text-xs font-medium ${reviewStatusClass(alarm)}`}>{!spatial&&alarm.handling.state!=='acknowledged'?(watchlist?'名单候选 · 待人工复核':'业务候选 · 待人工审核'):reviewLabel(alarm)}{alarm.handling.state==='acknowledged'?` · ${alarm.handling.disposition==='false_positive'?'误报':'确认'}`:''}</p>
   {alarm.handling.state==='unacknowledged'&&preparationLabel(alarm.review)&&<p role="status" className="mt-1 text-xs text-amber-700">{preparationLabel(alarm.review)}</p>}
   {recoveryLabel(alarm.review)&&<p className="mt-1 text-xs text-ink-subtle">{recoveryLabel(alarm.review)}</p>}
      {diagnostic?<p className="mt-1 text-xs text-ink-subtle">{diagnostic.summary}</p>:alarm.review?.reference&&<p className="mt-1 text-xs text-ink-subtle">{referenceLabel(alarm.review.reference)}</p>}
   <p className="mt-1 break-words text-sm text-ink" title={faceText??described.sentence}>{faceText??described.sentence}</p>
   <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-subtle">
    <time dateTime={alarm.occurred_at} title={time.toLocaleString('zh-CN')} className="shrink-0 tabular-nums">{time.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>
    <span className="break-words" title={`${watchlist?'名单':'触发器'}「${alarm.rule.name}」`}>{watchlist?'名单':'触发器'}「{alarm.rule.name}」</span>
   </div>
   {spatial&&stages.length>1&&<p aria-label="阶段" className="mt-1 break-words text-xs text-ink-faint">经过：{stages.map(s=>behaviorNames[s.behavior]??s.behavior).join(' → ')}</p>}
  </div>
  <footer className="col-span-2 flex flex-wrap items-center justify-end gap-2 [@container(min-width:56rem)]:col-span-1 [@container(min-width:56rem)]:max-w-[21rem]">
   {done?<span role="status" className="text-xs text-success-700">{alarm.handling.disposition==='false_positive'?'已标记误报':'已确认'}{alarm.handling.acknowledged_by?` · ${reviewerDisplay(alarm.handling.acknowledged_by)}`:''}</span>:<>
    <button type="button" aria-label="确认" title="确认" onClick={()=>onHandle('handled')} className="btn-secondary !min-h-11 text-primary-600"><Check size={16} aria-hidden="true"/>确认</button>
    <button type="button" aria-label="标记误报" title="标记误报" onClick={()=>onHandle('false_positive')} className="btn-secondary !min-h-11"><Flag size={16} aria-hidden="true"/>误报</button>
   </>}
   <button type="button" aria-label="详情与录像" title="查看详情、阶段截图与录像" onClick={()=>onOpen()} className="btn-secondary !min-h-11">详情<ChevronRight size={16} aria-hidden="true"/></button>
  </footer>
 </article>
}
