import {useEffect,useRef,useState} from 'react'
import {searchModelMigrationService,type SearchMigrationContext,type SearchMigrationPlan} from '@/api/searchModelMigrationService'
import {newOperationId} from '@/utils/operationId'
import {ConfirmDialog} from '@/components/modals/ConfirmDialog'
import {Section,Field,inputCls} from './fields'
const hash=/^[a-f0-9]{64}$/
const phase:Record<SearchMigrationPlan['phase'],string>={preparing:'等待准备',encoding:'重建目标模型证据',awaiting_acceptance:'等待管理员验收报告',ready:'已验收，等待切换',quiescing:'等待封住并排空采集写入',catching_up:'追赶新增证据并验证索引',publishing:'正在核对最终覆盖',activated:'等待目标模型真实就绪',restoring:'正在恢复原模型配置',restore_failed:'原模型恢复尚未确认',restored:'已恢复原模型配置'}
const reasons:Record<string,string>={capacity_exceeded:'目标证据或索引分区容量不足，本次迁移未完成。原模型保留；请检查证据配额与分区容量后重新迁移。',
 migration_index_capacity:'目标索引分区超过容量限制，本次迁移未完成，原模型保留。',finalization_timeout:'本次切换超过时限，已撤销最终追赶；请确认原模型状态后重试。',
 target_activation_failed:'目标模型未能完成切换；原配置已恢复后，请重新创建迁移任务；已重建成果保留。',source_restore_failed:'原模型尚未确认恢复。请检查模型文件、服务与配置应用状态，不能视为恢复成功。',
 source_changed:'迁移期间配置、来源或存储已变化，请重新创建迁移。',model_unavailable:'所选模型尚未通过包级验证，或当前硬件接线不支持该包。',
 legacy_bootstrap_required:'历史写入尚未完成可信初始化，切换已中止；新增采集仍需处理初始化状态，不能视为已恢复。',
 source_writer_uncertain:'存在未确认的历史写入，无法取得可靠水位，切换已中止；采集恢复仍需确认。',
 source_writer_previous_unclean:'上一次写入进程尚未完成退出核对，切换已中止；请处理服务恢复状态，不能视为采集已恢复。',
 source_writer_topology_unverified:'历史库部署方式尚未验证，无法取得可靠水位，切换已中止；请检查服务状态。',
 source_drain_timeout:'未在期限内排空历史写入，切换已中止；实际采集是否恢复仍需确认。',
 source_admission_unavailable:'无法确认搜索采集已安全停止，因此未切换；采集恢复状态仍需确认。',
 migration_executor_pending:'当前服务尚未具备完整安全迁移能力，任务不会被标为已完成。'}
export function SearchModelMigrationPanel({target,targetVersion,onRequired,onActive,onReload}:{target:string;targetVersion:string|null;onRequired:(value:boolean)=>void;onActive:(value:boolean)=>void;onReload?:()=>Promise<unknown>}){
 const [context,setContext]=useState<SearchMigrationContext|null>(null),[plans,setPlans]=useState<SearchMigrationPlan[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('')
 const [criteria,setCriteria]=useState(''),[reports,setReports]=useState<Record<string,string>>({}),[accepted,setAccepted]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[switchPlan,setSwitchPlan]=useState<SearchMigrationPlan|null>(null),[reloadConfirm,setReloadConfirm]=useState(false)
 const guarded=useRef(false),createKey=useRef<{signature:string;id:string}|null>(null),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{
  const stop=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
  const read=async()=>{
   try{const [state,list]=await Promise.all([searchModelMigrationService.context(stop.signal),searchModelMigrationService.list(stop.signal)])
    if(stop.signal.aborted)return;setContext(state);setPlans(list.items);setError('');setLoading(false)
    if(list.items.some(plan=>['pending','running'].includes(plan.state)))timer=setTimeout(()=>void read(),3000)
   }catch{if(!stop.signal.aborted){setError('暂时无法读取模型迁移状态；已保存任务保留，请恢复服务后重新检查。');setLoading(false)}}
  };void read();return()=>{stop.abort();if(timer)clearTimeout(timer)}
 },[refresh])
 const required=!!target&&!!context?.source&&(target!==context.source.package_id||!!targetVersion&&targetVersion!==context.source.model_version)
 const active=plans.some(plan=>['pending','running'].includes(plan.state))
 useEffect(()=>{onRequired(required)},[required,onRequired]);useEffect(()=>{onActive(active)},[active,onActive])
 const mutate=async(work:()=>Promise<unknown>,success:string)=>{
  if(guarded.current)return;guarded.current=true;setBusy(true);setMessage('')
  try{await work();if(alive.current){setMessage(success);setRefresh(value=>value+1)}}
  catch(e){if(alive.current)setMessage(e instanceof Error?e.message:'操作尚未确认，请重新检查状态后重试。')}
  finally{guarded.current=false;if(alive.current)setBusy(false)}
 }
 const create=()=>{
  if(!hash.test(criteria)){setMessage('请输入已冻结验收标准文件的 SHA-256（64 位小写十六进制）。');return}
  try{const signature=JSON.stringify([target,criteria]);if(createKey.current?.signature!==signature)createKey.current={signature,id:newOperationId('uuid')}}
  catch(e){setMessage(e instanceof Error?e.message:'无法生成安全操作编号，请使用支持安全随机数的浏览器。');return}
  void mutate(async()=>{await searchModelMigrationService.create({request_id:createKey.current!.id,target_package_id:target,acceptance_criteria_sha256:criteria});if(alive.current)setCriteria('')},'已创建迁移。原模型继续服务，目标证据重建完成后还需核对并接受验收报告。')
 }
 if(!loading&&!error&&!context?.source&&!plans.length)return null
 return <Section title="模型迁移" hint="已有搜索数据时，使用留存原始截图重建目标模型证据。旧模型继续服务；验收通过后才安排有时限的切换，不靠更改下拉框直接替换向量空间。">
  <div data-unsaved={!!criteria||Object.values(reports).some(Boolean)} className="space-y-3">
   <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 flex-1 break-words text-sm">{loading?'正在确认当前模型身份…':context?.source?`当前模型：${context.source.package_id}`:'当前模型身份尚未确认；请先检查服务与配置应用状态。'}</p><button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>重新检查迁移</button></div>
   {context?.source&&<p className="text-xs text-ink-subtle">当前空间版本：{context.source.model_version.slice(10,22)}。同名模型包更新权重或分词器后也需要迁移。</p>}
   {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
   {context&&!context.execution_available&&<p className="text-sm text-amber-800">当前服务尚未具备完整安全迁移能力。原模型与配置保留，请完成服务更新后重新检查。</p>}
   {required&&<div className="space-y-3 rounded-base border border-amber-200 bg-amber-50 p-3 text-sm">
    <p>所选模型与当前空间不同。请通过迁移切换；普通“保存并应用”不会跳过历史兼容检查。</p>
    <details><summary className="min-h-11 cursor-pointer break-words py-3 font-medium">准备迁移到 {target} · 管理员操作</summary>
     <div className="space-y-3 pt-2"><p className="text-xs text-ink-subtle">迁移使用当前已应用的来源和存储，不会替你保存本页其它修改。模型包本身仍须先通过质量与硬件验证。</p>
      <Field label="验收标准文件 SHA-256" hint="绑定本次迁移的质量标准与阈值，后续报告必须按同一标准验收。不是模型路径或密钥。"><input aria-label="迁移验收标准 SHA-256" maxLength={64} value={criteria} disabled={busy} onChange={event=>setCriteria(event.target.value.trim().toLowerCase())} className={`${inputCls} min-h-11 font-mono`} /></Field>
      <button type="button" className="btn-primary min-h-11" disabled={busy||loading||!!error||active||!context?.execution_available||!hash.test(criteria)} onClick={create}>从留存截图准备迁移</button>
     </div>
    </details>
   </div>}
   {plans.map(plan=><article key={plan.id} aria-label={`模型迁移 ${plan.target.package_id}`} className="space-y-3 rounded-base border border-line p-3 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 break-words font-medium">{plan.source.package_id} → {plan.target.package_id}</p><span className={`rounded-full px-2 py-1 text-xs ${plan.state==='failed'||plan.phase==='restore_failed'?'bg-danger-50 text-danger-700':plan.state==='succeeded'&&plan.phase==='activated'?'bg-success-50 text-success-700':'bg-amber-50 text-amber-800'}`}>{plan.state==='cancelled'?'已取消':plan.state==='failed'?'迁移未完成':plan.state==='succeeded'&&plan.phase==='activated'?'目标模型已确认就绪':phase[plan.phase]}</span></div>
    <p className="text-xs text-ink-subtle">{plan.source_count} 个来源 · {plan.extent.from_ms===null?'起始历史为空，切换时仍会检查新增证据':`${new Date(plan.extent.from_ms).toLocaleString()} — ${new Date(plan.extent.to_ms!).toLocaleString()}`} · 已安排 {plan.progress.next_partition}/{plan.progress.total_children} 个分区</p>
    <p className="text-xs text-ink-subtle">空间版本 {plan.source.model_version.slice(10,22)} → {plan.target.model_version.slice(10,22)}</p>
    {plan.reason&&<p role="status" className="text-xs text-amber-800">{reasons[plan.reason]??'本次迁移尚未完成，请检查服务日志与应用状态；不会将缺失证据算作迁移成功。'}</p>}
    {plan.phase==='awaiting_acceptance'&&plan.state==='succeeded'&&<div className="space-y-2">
      <p className="text-xs text-ink-subtle">准备已结束。请实际核对目标模型报告与冻结标准；接受报告不会立即暂停采集。</p>
      <Field label="验收报告 SHA-256"><input aria-label={`验收报告 SHA-256 ${plan.id}`} maxLength={64} value={reports[plan.id]??''} disabled={busy} onChange={event=>setReports(value=>({...value,[plan.id]:event.target.value.trim().toLowerCase()}))} className={`${inputCls} min-h-11 font-mono`} /></Field>
      <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={accepted[plan.id]===true} disabled={busy} onChange={event=>setAccepted(value=>({...value,[plan.id]:event.target.checked}))} />我已核对报告、模型与验收标准；这不是自动标定或质量通过的替代品。</label>
      <button type="button" className="btn-secondary min-h-11" disabled={busy||!!error||!accepted[plan.id]||!hash.test(reports[plan.id]??'')} onClick={()=>void mutate(async()=>{await searchModelMigrationService.accept(plan,reports[plan.id]!);setReports(value=>({...value,[plan.id]:''}))},'验收记录已保存。采集继续，需另行确认切换。')}>接受已核对的报告</button>
    </div>}
    <div className="flex flex-wrap gap-2">
     {plan.phase==='ready'&&plan.state==='succeeded'&&<button type="button" className="btn-primary min-h-11" disabled={busy||!!error||!context?.execution_available} onClick={()=>setSwitchPlan(plan)}>安排切换模型</button>}
     {['preparing','encoding','awaiting_acceptance','ready'].includes(plan.phase)&&!['cancelled','failed'].includes(plan.state)&&<button type="button" className="btn-secondary min-h-11" disabled={busy||!!error} onClick={()=>void mutate(async()=>{if(!(await searchModelMigrationService.cancel(plan.id)).cancelled)throw Error('任务已进入切换阶段，请重新检查状态。')},'任务已取消，原模型保留。')}>取消迁移</button>}
     {['activated','restored'].includes(plan.phase)&&plan.state==='succeeded'&&onReload&&<button type="button" className="btn-secondary min-h-11" onClick={()=>setReloadConfirm(true)}>重新读取已生效配置</button>}
    </div>
   </article>)}
   {!loading&&!error&&!plans.length&&<p className="text-xs text-ink-subtle">暂无模型迁移任务。</p>}
   {message&&<p role="status" className="rounded-base bg-surface-page p-3 text-sm">{message}</p>}
  </div>
  <ConfirmDialog open={switchPlan!==null} title="安排切换搜索模型" content="建立安全水位与最终切换时可能短暂停新增搜索采集，检测、录像和旧模型查询继续。服务会排空写入、追赶新增证据并核对覆盖；超时或证据不全会中止，已发布目标但未就绪时会尝试恢复原配置，恢复结果须由服务确认。" confirmText="确认安排切换" busy={busy} onClose={()=>setSwitchPlan(null)} onConfirm={()=>{const plan=switchPlan;if(plan)void mutate(async()=>{if(!(await searchModelMigrationService.activate(plan)).scheduled)throw Error('切换尚未确认，请重新检查。')},'已安排切换，以上方任务的真实状态为准。')}} />
  <ConfirmDialog open={reloadConfirm} title="重新读取已生效配置" content="本页尚未保存的参数和报告输入将被放弃。已保存的迁移任务与验收记录会保留。" confirmText="放弃本页输入并读取" busy={busy} onClose={()=>setReloadConfirm(false)} onConfirm={()=>{if(onReload)void mutate(onReload,'配置已重新读取。')}} />
 </Section>
}
