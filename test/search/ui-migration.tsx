/** Isolated browser acceptance: real migration panel, mock service only. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SearchModelMigrationPanel } from '@/pages/ConfigCenter/SearchModelMigrationPanel'
import { searchModelMigrationService, type SearchMigrationPlan } from '@/api/searchModelMigrationService'
import '@/styles/globals.css'
const h=(s:string)=>s.repeat(64)
const source={package_id:'SigLIP 旧空间',package_sha256:h('a'),model_version:`search-v1-${h('a')}`}
const target={package_id:'SigLIP2 Base 256 完整词表 INT8',package_sha256:h('b'),model_version:`search-v1-${h('b')}`}
const params=new URLSearchParams(location.search)
let scenario=params.get('scenario')??'empty',calls:string[]=[],items:SearchMigrationPlan[]=[]
const make=(phase:SearchMigrationPlan['phase']='awaiting_acceptance'):SearchMigrationPlan=>({id:'00000000-0000-4000-8000-000000000001',generation:2,purpose:'reencode_plan',state:'succeeded',phase,source,target,payload_fingerprint:h('c'),extent:{from_ms:null,to_ms:null,source_high_watermark:'0'},source_count:2,expires_at:new Date(Date.now()+86400000).toISOString(),acceptance_criteria_sha256:h('d'),progress:{next_partition:0,total_children:0,round:0,switch_deadline_ms:null},reason:null,accepted_report_sha256:phase==='ready'?h('e'):null})
function reset(next:string){scenario=next;calls=[];items=['awaiting_acceptance','ready','activated','restored','restore_failed'].includes(next)?[make(next as SearchMigrationPlan['phase'])]:[];if(next==='restore_failed')items[0]={...items[0]!,state:'failed',reason:'source_restore_failed'};if(next==='restored')items[0]={...items[0]!,reason:'target_activation_failed'}}
reset(scenario)
searchModelMigrationService.context=async()=>{if(scenario==='denied')throw Error('隔离测试：管理员权限不足');return {source,execution_available:scenario!=='pending',reason:scenario==='pending'?'migration_executor_pending':null}}
searchModelMigrationService.list=async()=>{if(scenario==='denied')throw Error('隔离测试：管理员权限不足');return {items:structuredClone(items)}}
searchModelMigrationService.create=async(input)=>{calls.push('create');items=[{...make(),acceptance_criteria_sha256:input.acceptance_criteria_sha256}];return structuredClone(items[0]!)}
searchModelMigrationService.accept=async(_,report)=>{calls.push('accept');items=[{...items[0]!,phase:'ready',accepted_report_sha256:report}];return structuredClone(items[0]!)}
searchModelMigrationService.activate=async()=>{calls.push('activate');items=[{...items[0]!,phase:'activated',state:'succeeded'}];return {scheduled:true}}
searchModelMigrationService.cancel=async()=>{calls.push('cancel');items=[{...items[0]!,state:'cancelled'}];return {cancelled:true}}
function Fixture(){const [revision,setRevision]=useState(0),[selected,setSelected]=useState(scenario),[width,setWidth]=useState(params.get('width')==='390px'?'390px':'100%'),[required,setRequired]=useState(false),[active,setActive]=useState(false),[reloads,setReloads]=useState(0),[tick,setTick]=useState(0)
return <><header className="flex flex-wrap gap-3 bg-amber-50 border-b p-3 text-sm"><strong>模型迁移隔离浏览器验收</strong><span>只使用示意数据，不调用生产API，不迁移任何模型。</span><label>验收宽度 <select className="min-h-11 border px-2" value={width} onChange={e=>setWidth(e.target.value)}><option value="100%">桌面</option><option value="390px">窄屏</option></select></label><label>模拟迁移 <select className="min-h-11 border px-2" value={selected} onChange={e=>{reset(e.target.value);setSelected(e.target.value);setRevision(x=>x+1)}}>{['empty','awaiting_acceptance','ready','activated','restored','restore_failed','pending','denied'].map(s=><option key={s}>{s}</option>)}</select></label></header><main className="p-4" style={{width,maxWidth:'100%',margin:'auto'}}><SearchModelMigrationPanel key={revision} target={target.package_id} targetVersion={target.model_version} onRequired={setRequired} onActive={setActive} onReload={async()=>{calls.push('reload');setReloads(x=>x+1);setRevision(x=>x+1)}}/><aside className="mt-4 break-words rounded border p-3 text-xs">隔离监视：需要迁移 {String(required)}；运行中 {String(active)}；重新读取 {reloads}。<button className="min-h-11 border px-2 ml-2" onClick={()=>setTick(x=>x+1)}>刷新观察</button><p>调用记录：{calls.join(', ')||'无'}</p></aside></main></>}
createRoot(document.getElementById('root')!).render(<Fixture/> )
