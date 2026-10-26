import {triggerDefinitionInput} from '@/features/triggerDefaults'
import {TriggerActionMenu,TriggerArchiveDialog} from './TriggerLifecycleControls'
import {getAiModelDisplayNameByName} from '@/types/aiChannel'
import {Plus} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {Link} from 'react-router-dom'
import {aiChannelService} from '@/api/aiChannelService'
import {alarmTriggerService,type AlarmSource,type TriggerApplication} from '@/api/alarmTriggerService'
import {alarmDefinitionService,createDefinitionSaveSession} from '@/api/alarmDefinitionService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {behaviorStatisticsService} from '@/api/behaviorStatisticsService'
import {behaviorNames,triggerBehaviors,labelName,levelLook,type TriggerLabel,type TriggerBehavior} from '@/features/alarmTriggers'
import {scheduleSummary} from '@/features/alarmSchedule'
import {labelDisplay} from '@/features/labelNames'
import type {TriggerDefinition,TriggerDefinitionInput} from '@/features/alarmDefinitions'
import {TriggerDefinitionWizard} from './TriggerDefinitionWizard'
const states={enabled:'已启用',paused:'已暂停',draft:'草稿 · 未启用',archived:'已归档'}
const stateLook={enabled:'bg-green-50 text-green-700',paused:'bg-surface-page text-ink-subtle',draft:'bg-amber-50 text-amber-800',archived:'bg-surface-page text-ink-subtle'}
type Operation={input:TriggerDefinitionInput;save:ReturnType<typeof createDefinitionSaveSession>;busy:boolean;error:string;uncertain:boolean}
const button='btn-secondary'
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const saveDefinition:typeof alarmDefinitionService.save=(...args)=>alarmDefinitionService.save(...args)
function condition(t:TriggerDefinition){
 if(t.behavior==='region_approach'&&!Number.isFinite(t.approach_width_percent))return '接近范围待重新确认'
 return t.behavior==='appearance'?`连续出现 ${t.duration_ms/1000} 秒`:t.behavior==='region_approach'?`外侧距离 ≤ 画面宽度的 ${t.approach_width_percent}%`:
 t.behavior==='region_enter'?'从区域外进入区域内':'从不同边进入、离开'
}
export default function TriggerDefinitionsPage(){
 const [rows,setRows]=useState<TriggerDefinition[]>([]),[labels,setLabels]=useState<TriggerLabel[]>([])
 const [sources,setSources]=useState<AlarmSource[]>([])
 const [usageNames,setUsageNames]=useState<Record<string,string>>({})
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[catalogWarning,setCatalogWarning]=useState('')
 const [revision,setRevision]=useState(0),[filter,setFilter]=useState<TriggerBehavior|''>(''),[archived,setArchived]=useState(false)
 const [today,setToday]=useState<Record<string,number>|null>(null),[application,setApplication]=useState<TriggerApplication|null>(null)
 const [coverageComplete,setCoverageComplete]=useState(false)
 const [editor,setEditor]=useState<{id:string;initial?:TriggerDefinition;step?:number;save:ReturnType<typeof createDefinitionSaveSession>}|null>(null)
 const [operation,setOperation]=useState<Operation|null>(null),[archive,setArchive]=useState<TriggerDefinition|null>(null)
 const mutationBusy=useRef(false)
 const applyResult=(result:Awaited<ReturnType<typeof alarmDefinitionService.save>>)=>{
  setApplication(result.application);setRows(list=>[result.trigger,...list.filter(t=>t.trigger_id!==result.trigger.trigger_id)]);setRevision(n=>n+1)
 }
 const perform=async(op:Operation)=>{
  if(mutationBusy.current)return
  mutationBusy.current=true;setOperation({...op,busy:true,error:''})
  try{const result=await op.save.save(op.input);applyResult(result);setOperation(null);setArchive(null)}
  catch(e){
   const status=(e as {status?:number}).status,definitive=[400,409,422].includes(status??0)
   setOperation({...op,busy:false,uncertain:!definitive,error:status===409?'配置已变化，请关闭提示并重新读取后再操作。':definitive?`${e instanceof Error?e.message:'条件未满足'}；操作未生效。`:'操作结果尚未确认。请重试确认同一次操作，期间暂停其他修改。'})
  }finally{mutationBusy.current=false}
 }
 const beginState=(t:TriggerDefinition,state:TriggerDefinitionInput['state'])=>{
  if(operation||mutationBusy.current)return
  void perform({input:{...triggerDefinitionInput(t),state},save:createDefinitionSaveSession(t.version,saveDefinition),busy:false,error:'',uncertain:false})
 }
 useEffect(()=>{
  let alive=true;setLoading(true);setError('')
  void alarmDefinitionService.list().then(r=>{if(alive)setRows(r.items)}).catch(()=>{if(alive)setError('触发器读取失败，请重新读取。')}).finally(()=>{if(alive)setLoading(false)})
  void (async()=>{
   try{
    const channels=await aiChannelService.list()
    const results=await Promise.allSettled(channels.map(c=>alarmTriggerService.source(c.id)))
    if(!alive)return
    const names:Record<string,string>={}
    for(const result of results)if(result.status==='fulfilled'){names[result.value.channel_id]=result.value.channel_name;names[result.value.input_stream_id]=result.value.input_name}
    setUsageNames(names)
    setSources(results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]))
    const available=results.flatMap(r=>r.status==='fulfilled'?r.value.labels.map(l=>({label_id:l.label_id,name:labelName(l)})):[])
    setLabels([...new Map(available.map(l=>[JSON.stringify(l),l])).values()])
    setCatalogWarning(results.some(r=>r.status==='rejected')?'部分运行通道暂不可用；仍可按模型创建触发器，关联时会核对实际标签。':'')
   }catch{if(alive)setCatalogWarning('运行通道暂不可用；仍可选择模型和手动配置开放词汇标签。')}
  })()
  const start=new Date();start.setHours(0,0,0,0);setToday(null);setCoverageComplete(false)
  void behaviorStatisticsService.query({from:start.toISOString(),to:new Date(Date.now()+1000).toISOString(),bucket:'day',
   group_by:'trigger',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})
   .then(r=>{if(alive){const counts:Record<string,number>={};for(const item of r.items)counts[String(item.group)]=(counts[String(item.group)]??0)+item.occurrences;setToday(counts);setCoverageComplete(r.coverage.state==='complete')}})
   .catch(()=>undefined)
  return()=>{alive=false}
 },[revision])
 const shown=rows.filter(t=>(archived?t.state==='archived':t.state!=='archived')&&(!filter||t.behavior===filter))
 return <main className="alarm-workspace space-y-4 p-4 md:p-6">
  <header className="flex flex-wrap items-center gap-3">
   <div className="min-w-0 flex-1"><h1 className="page-title">告警触发</h1>
    <p className="mt-1 text-sm text-ink-subtle">定义告警条件，再到实时监看布防；进出流量由计数器统计。</p></div>
   <button type="button" className="btn-primary" disabled={loading||!!error||!!operation||!!archive}
    onClick={()=>setEditor({id:`trigger-${newAlarmOperationId()}`,save:createDefinitionSaveSession(0,saveDefinition)})}><Plus size={16} aria-hidden="true"/>新建触发器</button>
  </header>
  <div className="flex flex-wrap items-center gap-2" role="group" aria-label="筛选触发器">
   {[{id:'' as const,name:'全部'},...triggerBehaviors].map(b=><button type="button" key={b.id} aria-pressed={filter===b.id}
    onClick={()=>setFilter(b.id)} className={choice}>{b.name}</button>)}
   <label className="ml-auto flex items-center gap-2 px-2 text-sm text-ink-subtle"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>查看已归档</label>
  </div>
  {error&&<p role="alert">{error} <button className={button} onClick={()=>setRevision(n=>n+1)}>重新读取</button></p>}
  {catalogWarning&&<p role="status" className="text-sm text-ink-subtle">{catalogWarning}</p>}
  {operation&&!archive&&<section role={operation.error?'alert':'status'} className="flex flex-wrap items-center gap-2 rounded-base border border-line bg-surface p-3 text-sm">
   <span className="min-w-0 flex-1">{operation.busy?`正在${operation.input.state==='enabled'?'启用':'暂停'}“${operation.input.name}”的全部选用…`:operation.error}</span>
   {operation.error&&<><button className={button} onClick={()=>void perform(operation)}>{operation.uncertain?'重试确认操作':'重试'}</button>{!operation.uncertain&&<button className={button} onClick={()=>{setOperation(null);setRevision(n=>n+1)}}>关闭提示并重新读取</button>}</>}
  </section>}
  {application&&<p role="status" className="rounded-base border border-line bg-surface p-3 text-sm">{application.state==='applied'?'已保存并应用':'已保存，等待应用确认'}{application.reason?`：${application.reason}`:''}</p>}
  {loading?<p role="status">正在读取触发器…</p>:!shown.length?<div className="rounded-panel border border-dashed border-line p-8 text-center">
   <p>{archived?'没有已归档的触发器。':'还没有符合筛选的触发器。可先创建，再选用，无需提前绘制热区。'}</p><Link to="/monitor" className="mt-3 inline-flex items-center text-sm text-primary hover:underline">前往实时监看布防</Link>
  </div>:<div className="grid gap-4 lg:grid-cols-2">{shown.map(t=><article key={t.trigger_id} aria-label={t.name} className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4">
   <header className="flex flex-wrap items-center gap-2"><span className="rounded-full px-3 py-1 text-sm font-semibold" style={{background:levelLook[t.behavior]?.soft,color:levelLook[t.behavior]?.ink}}>{behaviorNames[t.behavior]}</span>
    <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-ink">{t.name}</h2><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateLook[t.state]}`}>{states[t.state]}</span>
    {t.state!=='archived'&&<TriggerActionMenu trigger={t} disabled={loading||!!operation||!!archive||!!editor} onEdit={()=>setEditor({id:t.trigger_id,initial:t,save:createDefinitionSaveSession(t.version,saveDefinition)})} onState={state=>beginState(t,state)} onArchive={()=>setArchive(t)}/>}</header>
   <p className="text-sm text-ink">{t.target_model?`${getAiModelDisplayNameByName(t.target_model.name)} · `:''}{t.labels.map(l=>labelDisplay(l.name)).join('、')} · {condition(t)}</p>
   <p className="text-sm text-ink-subtle">{t.alarm_enabled?'触发后生成告警':'旧版行为记录 · 不产生告警'} · {scheduleSummary(t.schedule)}</p>
   {t.review?.enabled&&<p className="text-xs text-primary">AI 审核 · 按系统审核服务配置执行</p>}
   {t.migration_review?.required&&<p role="status" className="rounded-base border border-warning bg-amber-50 p-3 text-sm">待重新确认：{t.migration_review.reason} 原配置与历史已保留，{t.state==='archived'?'请新建触发器并在实时监看重新选用。':'请编辑条件并在实时监看重新选用。'}</p>}
   <section aria-label="选用位置" className="rounded-base bg-surface-page p-3 text-sm">
    {t.usages?.length?<ul>{t.usages.map(u=><li key={u.assignment_id}>{usageNames[u.source_id]??'来源暂不可用'} · {u.zone_name??'整个画面'} · {usageNames[u.processor_id]??'处理器暂不可用'}</li>)}</ul>:t.usages?<p>尚未选用 · 到实时监看中布防</p>:<p>选用位置待确认</p>}
   </section>
   <footer className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3"><span className="text-sm">{today===null?'今日触发 —（记录未确认）':!coverageComplete&&!today[t.trigger_id]?'今日暂无触发记录（覆盖未确认）':`今日触发 ${today[t.trigger_id]??0} 次${coverageComplete?'':'（覆盖未确认）'}`}</span>
   </footer>
  </article>)}</div>}
  {editor&&<TriggerDefinitionWizard key={editor.id} id={editor.id} initial={editor.initial} labels={labels} sources={sources} initialStep={editor.step} usageNames={usageNames}
   onCancel={()=>setEditor(null)} onSave={async input=>{
    const result=await editor.save.save(input)
    applyResult(result);setEditor(null)
   }}/>}
  {archive&&<TriggerArchiveDialog trigger={archive} busy={operation?.busy??false} uncertain={operation?.uncertain??false} error={operation?.error??''} onCancel={()=>{if(!operation?.busy&&!operation?.uncertain){setArchive(null);setOperation(null)}}} onConfirm={()=>operation?void perform(operation):beginState(archive,'archived')}/>}
 </main>
}
