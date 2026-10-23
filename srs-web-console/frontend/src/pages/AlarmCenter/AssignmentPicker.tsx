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
 const [activeId,setActiveId]=useState('')
 const [ids,setIds]=useState<string[]>([]),[error,setError]=useState('')
 const [handles,setHandles]=useState<Record<string,{current:WorkspaceDraft|null}>>({})
 const values=useRef(new Map<string,{assignment:DraftAssignment;labelVersion:string}>())
 const available=props.definitions.filter(d=>d.state!=='archived'&&!d.migration_review?.required&&(props.zone||d.behavior==='appearance'))
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
  <p className="text-ink-subtle">勾选需要的触发器，在下方设置；统一保存布防后生效。</p>
  <div className="space-y-2">{available.map(t=><label key={t.trigger_id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-base border border-line bg-surface px-3 py-2">
   <input type="checkbox" checked={ids.includes(t.trigger_id)} onChange={e=>{setActiveId(e.target.checked?t.trigger_id:ids.find(id=>id!==t.trigger_id)??'');if(e.target.checked)setHandles(h=>({...h,[t.trigger_id]:{current:null}}));setIds(e.target.checked?[...ids,t.trigger_id]:ids.filter(id=>id!==t.trigger_id));setError('')}}/>
   <span>{t.name}{t.state!=='enabled'?'（未启用）':''}</span>
  </label>)}</div>
  {!available.length&&<p role="status">没有适合此范围的触发器。请先在告警触发页创建，再返回关联。</p>}
  <a href="/alarm-analysis" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-primary underline">在新页面管理触发器，返回后点刷新库</a>
  {ids.map(id=>{const t=available.find(t=>t.trigger_id===id);if(!t)return <p key={id} role="alert">已选触发器不可用，请取消勾选或撤销本处修改。</p>;return <div key={id} onFocusCapture={()=>setActiveId(id)} onPointerDownCapture={()=>setActiveId(id)} className="border-t border-line pt-3">
   <AssignmentEditor sourceId={props.sourceId} geometryRevision={props.geometryRevision} zone={props.zone} definitions={[t]} sources={props.sources} defaultTriggerId={id}
    previewActive={activeId===id} workspace={handles[id]!} approachEdit={props.approachEdit} onApproachChange={props.onApproachChange} onDirectionChange={props.onDirectionChange}
    onApply={(assignment,labelVersion)=>values.current.set(id,{assignment,labelVersion})}/>
  </div>})}
  {error&&<p role="alert" className="text-danger">{error}</p>}

 </section>
}
