import {useEffect,useRef,useState} from 'react'
import type {AlarmSource} from '@/api/alarmTriggerService'
import type {DraftZone,DraftAssignment} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {AssignmentEditor} from './AssignmentEditor'
interface Props {
 sourceId:string;geometryRevision:string;zone:DraftZone|null;definitions:TriggerDefinition[];sources:AlarmSource[];
 onDirectionChange:(edges:{entry:string[];exit:string[]})=>void;
 onApply:(items:{assignment:DraftAssignment;labelVersion:string}[])=>void;onCancel:()=>void
}
/** Each selected trigger has its own processor and geometry settings. Commit the batch atomically. */
export function AssignmentPicker(props:Props){
 const panel=useRef<HTMLDivElement>(null)
 const [ids,setIds]=useState<string[]>([]),[index,setIndex]=useState<number|null>(null)
 const [items,setItems]=useState<{assignment:DraftAssignment;labelVersion:string}[]>([]),[error,setError]=useState('')
 useEffect(()=>{if(index!==null)panel.current?.focus()},[index])
 const available=props.definitions.filter(d=>d.state!=='archived'&&!d.migration_review?.required&&(props.zone||d.behavior==='appearance'))
 const button='btn-secondary'
 if(index!==null){
  const definition=available.find(t=>t.trigger_id===ids[index])
  if(!definition)return <p role="alert">触发器已不可用，请取消后重新选择。</p>
  return <div ref={panel} tabIndex={-1} role="group" aria-label="配置多项选用" className="space-y-3 outline-none"><p>配置选用 {index+1} / {ids.length} · {definition.name}</p>
   <AssignmentEditor key={definition.trigger_id} sourceId={props.sourceId} geometryRevision={props.geometryRevision} zone={props.zone}
    definitions={[definition]} sources={props.sources} defaultTriggerId={definition.trigger_id} applyLabel={index===ids.length-1?'全部加入布防草稿':'下一项选用'}
    onDirectionChange={props.onDirectionChange} onCancel={props.onCancel} onApply={(assignment,labelVersion)=>{
     const next=[...items,{assignment,labelVersion}]
     if(index===ids.length-1){try{props.onApply(next)}catch(e){setError(e instanceof Error?e.message:'不能加入草稿')}}
     else{setItems(next);setIndex(index+1);setError('')}
    }}/>{error&&<p role="alert">{error}</p>}</div>
 }
 return <section aria-label="选择多个触发器" className="space-y-3 rounded-panel border border-line p-4"><h3 className="font-semibold">{props.zone?.name??'整个画面'} · 选用触发器</h3><p>可勾选多个，下一步逐项确认处理器和条件。取消不会加入任何选用。</p>
  <div className="grid gap-2 sm:grid-cols-2">{available.map(t=><label key={t.trigger_id} className="flex items-center gap-3 rounded-base border border-line bg-surface px-3 py-2 text-sm"><input type="checkbox" checked={ids.includes(t.trigger_id)} onChange={e=>setIds(e.target.checked?[...ids,t.trigger_id]:ids.filter(id=>id!==t.trigger_id))}/><span>{t.name}{t.state!=='enabled'?'（未启用）':''}</span></label>)}</div>
  {!available.length&&<p role="status">没有适合此范围的触发器，请先到告警触发页创建。</p>}
  <div className="flex justify-end gap-2"><button type="button" className={button} onClick={props.onCancel}>取消选用修改</button><button type="button" className="btn-primary" disabled={!ids.length} onClick={()=>setIndex(0)}>配置已选 {ids.length} 项</button></div>
 </section>
}
