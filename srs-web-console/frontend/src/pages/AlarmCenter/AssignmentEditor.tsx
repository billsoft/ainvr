import {useWorkspaceDraft,type WorkspaceDraftRef} from './workspaceDraft'
import {Unlink} from 'lucide-react'
import {unwrapErp} from '@/features/erpGeometry'
import {useEffect,useRef,useState} from 'react'
import type {AlarmSource} from '@/api/alarmTriggerService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import type {DraftZone,DraftAssignment} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {edgeNames,sameLabel,sourceSize} from '@/features/alarmTriggers'
interface Props {
 sourceId:string;geometryRevision:string;zone:DraftZone|null;
 workspace:WorkspaceDraftRef;
 defaultTriggerId?:string;
 previewActive?:boolean;
 definitions:TriggerDefinition[];sources:AlarmSource[];initial?:DraftAssignment;
 approachEdit?:{id:string;value:number;revision:number};
 onApproachChange?:(value:{id:string;value:number}|null)=>void;
 onDirectionChange?:(edges:{entry:string[];exit:string[]})=>void;
 onApply:(assignment:DraftAssignment,labelMapVersion:string)=>void
 /** Present when editing an existing selection: takes it out of the draft. */
 onRemove?:()=>void
}
/** Only updates the parent arming draft. No network mutation occurs here. */
export function AssignmentEditor({sourceId,geometryRevision,zone,definitions,sources,initial,onApply,onRemove,onDirectionChange,defaultTriggerId,workspace,approachEdit,onApproachChange,previewActive=true}:Props){
 const [triggerId,setTriggerId]=useState(initial?.triggerId??defaultTriggerId??'')
 const [processorId,setProcessorId]=useState(initial?.processorId??'')
 const [entry,setEntry]=useState(initial?.entryEdges??[]),[exit,setExit]=useState(initial?.exitEdges??[])
 useEffect(()=>{if(previewActive)onDirectionChange?.({entry,exit})},[entry,exit,onDirectionChange,previewActive])
 const [distance,setDistance]=useState(initial?.approachWidthPercent?.toString()??'')
 const [error,setError]=useState('')
 const [directionConfirmed,setDirectionConfirmed]=useState(!initial?.needsDirectionConfirmation)
 const available=definitions.filter(d=>d.state!=='archived'&&(!d.migration_review?.required||d.trigger_id===initial?.triggerId)&&(zone||d.behavior==='appearance'))
 const trigger=available.find(d=>d.trigger_id===triggerId)
 const compatible=sources.filter(s=>s.input_stream_id===sourceId&&s.geometry_revision===geometryRevision&&trigger&&(s.tracking_available||(s.detection_available&&trigger.alarm_enabled&&['appearance','region_approach'].includes(trigger.behavior)&&trigger.duration_ms===0&&!zone?.erpWrap))&&trigger.labels.every(l=>s.labels.some(v=>sameLabel(l,v))))
 const effective=compatible.find(s=>s.channel_id===processorId)??(!processorId&&compatible.length===1?compatible[0]:undefined)
 const size=sourceSize(geometryRevision),names=zone?edgeNames(zone.erpWrap?unwrapErp(zone.points):zone.points,size?.width,size?.height):[]
 const directional=trigger?.behavior==='region_enter'||trigger?.behavior==='region_traverse'
 const distanceValue=distance===''?undefined:Number(distance)
 useEffect(()=>{if(approachEdit?.id===triggerId)setDistance(String(approachEdit.value))},[approachEdit,triggerId])
 useEffect(()=>{if(!previewActive)return;if(trigger?.behavior==='region_approach')onApproachChange?.({id:triggerId,value:distanceValue??trigger.approach_width_percent??0});else onApproachChange?.(null)},[previewActive,triggerId,trigger?.behavior,trigger?.approach_width_percent,distanceValue,onApproachChange])
 const badDistance=trigger?.behavior==='region_approach'&&distanceValue!==undefined&&(!Number.isFinite(distanceValue)||distanceValue<=0||distanceValue>100)
 const invalidEdges=zone&&[...entry,...exit].some(e=>!zone.edgeIds.includes(e))
 const generatedId=useRef(newAlarmOperationId())
 const original=useRef(JSON.stringify({triggerId,processorId,entry,exit,distance}))
 const apply=()=>{
  if(!trigger||!effective||badDistance||invalidEdges||!directionConfirmed){setError('请先选择兼容的触发器、处理器并检查方向和距离。');return false}
  try{onApply({id:initial?.id??generatedId.current,triggerId:trigger.trigger_id,processorId:effective.channel_id,zoneId:zone?.id??null,
   entryEdges:directional?entry:[],exitEdges:trigger.behavior==='region_traverse'?exit:[],
   version:initial?.version??0,needsDirectionConfirmation:false,
   ...(trigger.behavior==='region_approach'&&distanceValue!==undefined?{approachWidthPercent:distanceValue}:{})},effective.label_map_version);return true}
  catch(e){setError(e instanceof Error?e.message:'不能加入草稿');return false}
 }
 useWorkspaceDraft(workspace,{flush:()=>!initial&&!triggerId?true:apply(),dirty:()=>JSON.stringify({triggerId,processorId,entry,exit,distance})!==original.current||!!defaultTriggerId})
 const button='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
 const field='form-input'
 return <section onFocusCapture={()=>{onApproachChange?.(trigger?.behavior==='region_approach'?{id:triggerId,value:distanceValue??trigger.approach_width_percent??0}:null)}} aria-label="选用触发器" className="space-y-3 rounded border border-line p-4">
  <h3 className="font-medium">选用范围：{zone?.name??'整个画面'}</h3>
  <label className="block">触发器<select className={field} value={triggerId} disabled={!!initial||!!defaultTriggerId} onChange={e=>{setTriggerId(e.target.value);setProcessorId('');setEntry([]);setExit([]);setDistance('');setError('')}}>
   <option value="">请选择触发器</option>{available.map(t=><option key={t.trigger_id} value={t.trigger_id}>{t.name}</option>)}
  </select></label>
  {!zone&&<p className="text-sm text-ink-subtle">整个画面可选用“出现”；其他行为请先选择热区。</p>}
  {trigger&&<><p className="text-sm">监控目标：{trigger.labels.map(l=>l.name).join('、')} · {trigger.alarm_enabled?'统计并告警':'仅统计'}{trigger.state!=='enabled'?' · 触发器未启用，保存选用后也不会执行':''}</p>
   <label className="block">AI 处理器<select className={field} value={effective?.channel_id??''} onChange={e=>setProcessorId(e.target.value)}>
    <option value="">请选择 AI 处理器</option>{compatible.map(s=><option key={s.channel_id} value={s.channel_id}>{s.channel_name}</option>)}
   </select></label>
   {processorId&&!effective&&<p role="alert">原选择的 AI 处理器暂不可用或不再兼容。请明确重新选择处理器，或取消以保留原选用。</p>}
   {!compatible.length&&<p role="status">没有兼容的 AI 处理器：需要当前来源、相同画面规格及目标标签。侵入、穿过、持续停留需要可靠跟踪；无跟踪可选持续时间为 0 的出现或接近。</p>}
   {effective&&!effective.tracking_available&&<p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">无跟踪：{trigger.behavior==='appearance'?(zone?'区内检出':'画面检出'):'接近带内检出'}，仅判断当前真实检测，不证明进入方向或同一目标停留。同类目标持续存在期间只报一次；连续检出空场达到重新布防时间后再报。不同目标不共享审核结论。</p>}
   {compatible.length>1&&<p className="text-sm text-ink-subtle">请选择负责此选用的处理器，避免多路重复分析。</p>}
   {trigger.behavior==='region_approach'&&<label className="block">接近范围（画面宽度 %）<input type="number" min="0" max="100" step="any" className={field} value={distance} placeholder={`沿用触发器：${trigger.approach_width_percent}%`} onChange={e=>setDistance(e.target.value)}/><span className="text-sm">{distance===''?'使用默认值':'本处自定义'} · 约 {Math.round((distanceValue??trigger.approach_width_percent??0)*(size?.width??0)/100)} 像素。留空恢复默认。</span></label>}
   {directional&&zone&&<fieldset className="space-y-2"><legend>进入方向（未选边表示不限）</legend><p className="text-sm">参考画面：绿色为进入边，橙色为离开边。</p><div className="flex flex-wrap gap-2">{zone.edgeIds.map((id,i)=><button type="button" className={`${button} ${entry.includes(id)?'border-green-600 bg-green-100 text-green-900':''}`} key={id} aria-pressed={entry.includes(id)} onClick={()=>{setEntry(entry.includes(id)?entry.filter(e=>e!==id):[...entry,id]);setExit(exit.filter(e=>e!==id))}}>进入边 {i+1} · {names[i]}</button>)}</div>
    {trigger.behavior==='region_traverse'&&<><p>离开方向（未选边表示不限；同边返回不算穿过）</p><div className="flex flex-wrap gap-2">{zone.edgeIds.map((id,i)=><button type="button" className={`${button} ${exit.includes(id)?'border-orange-600 bg-orange-100 text-orange-900':''}`} key={id} aria-pressed={exit.includes(id)} onClick={()=>{setExit(exit.includes(id)?exit.filter(e=>e!==id):[...exit,id]);setEntry(entry.filter(e=>e!==id))}}>离开边 {i+1} · {names[i]}</button>)}</div></>}
   </fieldset>}
  </>}
  {initial?.needsDirectionConfirmation&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={directionConfirmed} onChange={e=>setDirectionConfirmed(e.target.checked)}/>已核对当前热区的进入和离开方向</label>}
  {invalidEdges&&<p role="alert">区域的边已变化，请清除旧方向后重新选择。<button type="button" className={button} onClick={()=>{setEntry([]);setExit([])}}>清除旧方向</button></p>}
  {badDistance&&<p role="alert">接近范围必须大于 0 且不超过画面宽度的 100%。</p>}{error&&<p role="alert">{error}</p>}
  {onRemove&&<div className="flex justify-end"><button type="button" className="btn-secondary mr-auto text-danger" onClick={onRemove}><Unlink size={16} aria-hidden="true"/>移除选用</button></div>}
 </section>
}
