import {associationChoiceClass,AssociationChoiceAction} from './AssociationChoice'
import {ExternalLink} from 'lucide-react'
import {behaviorNames} from '@/features/alarmTriggers'
import {useRef,useState} from 'react'
import type {AlarmSource} from '@/api/alarmTriggerService'
import type {DraftZone,DraftAssignment} from '@/features/armingDraft'
import type {TriggerDefinition} from '@/features/alarmDefinitions'
import {AssignmentEditor} from './AssignmentEditor'
import {useWorkspaceDraft,type WorkspaceDraft,type WorkspaceDraftRef} from './workspaceDraft'
interface Props {
 sourceId:string;geometryRevision:string;zone:DraftZone|null;definitions:TriggerDefinition[];sources:AlarmSource[]
 approachEdit?:{id:string;value:number;revision:number}
 onApproachChange?:(value:{id:string;value:number}|null)=>void
 workspace:WorkspaceDraftRef
 onDirectionChange:(edges:{entry:string[];exit:string[]})=>void
 onApply:(items:{assignment:DraftAssignment;labelVersion:string}[])=>void
}
/** Select and configure in one panel. The arming save validates the entire batch. */
export function AssignmentPicker(props:Props){
 const [query,setQuery]=useState(''),[behavior,setBehavior]=useState('')
 const [activeId,setActiveId]=useState('')
 const [ids,setIds]=useState<string[]>([]),[error,setError]=useState('')
 const [handles,setHandles]=useState<Record<string,{current:WorkspaceDraft|null}>>({})
 const values=useRef(new Map<string,{assignment:DraftAssignment;labelVersion:string}>())
 const available=props.definitions.filter(d=>d.state!=='archived'&&!d.migration_review?.required&&(props.zone||d.behavior==='appearance'))
 const visible=available.filter(t=>ids.includes(t.trigger_id)||((!behavior||t.behavior===behavior)&&t.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
 const flush=()=>{
  if(!ids.length)return true
  let valid=true
  for(const id of ids)if(!available.some(t=>t.trigger_id===id)||!handles[id]?.current?.flush())valid=false
  if(!valid){setError('请补齐已选触发器的设置。');return false}
  try{props.onApply(ids.map(id=>values.current.get(id)!));return true}catch(e){setError(e instanceof Error?e.message:'不能加入草稿');return false}
 }
 useWorkspaceDraft(props.workspace,{flush,dirty:()=>ids.length>0})
 return <section aria-label="选择多个触发器" className="space-y-4 text-sm">
  <h3 className="font-semibold">{props.zone?.name??'整个画面'} · 添加触发器</h3>
  <p className="text-ink-subtle">选择触发器（可多选），再设置方向或接近范围。</p>
  <div className="space-y-2">
   <input type="search" aria-label="搜索触发器" placeholder="搜索触发器名称" className="form-input !min-h-11 w-full" value={query} onChange={e=>setQuery(e.target.value)}/>
   <select aria-label="触发行为筛选" className="form-input !min-h-11 w-full" value={behavior} onChange={e=>setBehavior(e.target.value)}><option value="">全部行为</option>{[...new Set(available.map(t=>t.behavior))].map(b=><option key={b} value={b}>{behaviorNames[b]??b}</option>)}</select>
   <p className="text-xs text-ink-subtle">可选 {available.length} 个 · 已选择 {ids.length} 个，筛选不会移除已选项。</p>
  </div>
  {!visible.length&&available.length>0&&<p role="status" className="text-ink-subtle">没有匹配的触发器，请调整搜索条件。</p>}
  <div className="space-y-2">{visible.map(t=><label key={t.trigger_id} className={associationChoiceClass(ids.includes(t.trigger_id))}>
   <input aria-label={t.name} className="h-5 w-5 shrink-0 accent-primary" type="checkbox" checked={ids.includes(t.trigger_id)} onChange={e=>{setActiveId(e.target.checked?t.trigger_id:ids.find(id=>id!==t.trigger_id)??'');if(e.target.checked)setHandles(h=>({...h,[t.trigger_id]:{current:null}}));setIds(e.target.checked?[...ids,t.trigger_id]:ids.filter(id=>id!==t.trigger_id));setError('')}}/>
   <span className="min-w-0 flex-1"><strong className="block text-sm font-semibold">{t.name}{t.state!=='enabled'?'（未启用）':''}</strong><span className="mt-0.5 block text-xs text-ink-subtle">{behaviorNames[t.behavior]??t.behavior}</span></span><AssociationChoiceAction selected={ids.includes(t.trigger_id)}/>
  </label>)}</div>
  {!available.length&&<p role="status">没有适合此范围的触发器。请先在告警触发页创建，再返回关联。</p>}
  <a href="/alarm-analysis" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-ink-subtle hover:text-primary"><ExternalLink size={14} aria-hidden="true"/>管理触发器</a>
  {ids.map(id=>{const t=available.find(t=>t.trigger_id===id);if(!t)return <p key={id} role="alert">已选触发器不可用，请取消勾选或撤销本处修改。</p>;return <div key={id} onFocusCapture={()=>setActiveId(id)} onPointerDownCapture={()=>setActiveId(id)} className="border-t border-line pt-3">
   <AssignmentEditor sourceId={props.sourceId} geometryRevision={props.geometryRevision} zone={props.zone} definitions={[t]} sources={props.sources} defaultTriggerId={id}
    previewActive={activeId===id} workspace={handles[id]!} approachEdit={props.approachEdit} onApproachChange={props.onApproachChange} onDirectionChange={props.onDirectionChange}
    onApply={(assignment,labelVersion)=>values.current.set(id,{assignment,labelVersion})}/>
  </div>})}
  {error&&<p role="alert" className="text-danger">{error}</p>}

 </section>
}
