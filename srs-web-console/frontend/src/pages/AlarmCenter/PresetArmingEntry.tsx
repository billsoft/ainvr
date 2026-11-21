import {useEffect,useRef,useState} from 'react'
import {X,MapPin,Square} from 'lucide-react'
import {ptzService,ptzError,type PtzInfo,type PtzPreset} from '@/api/ptzService'
import type {ArmingScenes,PresetArmingSelection} from '@/api/armingSceneService'
import {usePtzControl} from '@/components/player/usePtzControl'

/** Choosing a preset moves the camera explicitly. Cancel never saves arming. */
export function PresetArmingEntry({sourceId,status,onSelect,onClose}:{sourceId:string;status:ArmingScenes;onSelect:(choice:PresetArmingSelection|null)=>void;onClose:()=>void}){
 const [info,setInfo]=useState<PtzInfo>(),[presets,setPresets]=useState<PtzPreset[]>([])
 const dialog=useRef<HTMLDivElement>(null),alive=useRef(true)
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0)
 const bound=status.items.filter(s=>s.binding_mode==='preset')
 const homes=[...new Set(bound.map(s=>s.preset_id).filter(Boolean))]
 const [selected,setSelected]=useState(homes.length===1?homes[0]!:'')
 const control=usePtzControl(sourceId,info?.identity,()=>{})
 const busy=control.state!=='idle'
 useEffect(()=>{alive.current=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>{alive.current=false;previous?.focus()}},[])
 useEffect(()=>{
  let alive=true;setLoading(true);setError('')
  void Promise.all([ptzService.inspect(sourceId),ptzService.presets(sourceId)]).then(([i,p])=>{
   if(!alive)return
   setInfo(i);setPresets(p.items)
   if(!p.supported||p.reason)throw Error(p.reason||'ptz_preset_query_unavailable')
  }).catch(e=>{if(alive)setError(ptzError(e))}).finally(()=>{if(alive)setLoading(false)})
  return()=>{alive=false}
 },[sourceId,retry])
 const usable=presets.filter(p=>p.available!==false&&p.deviceState!=='unconfirmed'&&p.fingerprint)
 const chosen=usable.find(p=>p.id===selected)
 const available=chosen&&chosen.available!==false&&chosen.deviceState!=='unconfirmed'&&chosen.fingerprint
 const close=()=>{void control.stopConfirmed().then(ok=>{if(ok&&alive.current)onClose()})}
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)})
 return <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="选择布防视角" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onKeyDown={e=>{
  if(e.key!=='Tab')return
  const nodes=[...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)')??[]]
  const first=nodes[0],last=nodes.at(-1)
  if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus()}
  else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first?.focus()}
 }}>
  <div className="relative w-full max-w-lg rounded-panel bg-surface p-5 text-ink shadow-modal">
   <button type="button" aria-label="关闭" title="取消并关闭" onClick={close} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-muted"><X size={20}/></button>
   <h2 className="flex items-center gap-2 pr-10 text-lg font-semibold"><MapPin size={20}/>选择布防视角</h2>
   <p className="mt-3 text-sm text-ink-subtle">在保存的预置位画区域。离开后暂停相关告警和计数，回到原视角并核验后恢复。</p>
   <label className="mt-4 block text-sm">布防预置位<select aria-label="布防预置位" className="form-input mt-2 w-full min-h-11" value={selected} disabled={busy||loading} onChange={e=>setSelected(e.target.value)}>
    <option value="">{loading?'正在读取…':'请选择预置位'}</option>
    {usable.map(p=><option key={p.id} value={p.id} disabled={p.available===false||p.deviceState==='unconfirmed'||!p.fingerprint}>{p.name||`预置位 ${p.id}`}</option>)}
   </select></label>
   {!loading&&!usable.length&&!error&&<p className="mt-2 text-sm text-ink-subtle">没有可用于布防的预置位。请先在云台侧栏保存当前位置，再刷新预置位。</p>}
   {(error||control.error)&&<p role="alert" className="mt-3 text-sm text-red-700">{error||control.error}</p>}
   {control.notice&&<p role="status" className="mt-3 text-sm text-ink-subtle">{control.notice}</p>}
   <div className="mt-4 flex flex-wrap gap-2">
    <button type="button" className="btn-primary min-h-11" disabled={busy||loading||!available||!!error||info?.enabled===false} onClick={()=>{
     if(!chosen?.fingerprint)return
     setError('');const choice:PresetArmingSelection={binding_mode:'preset',preset_id:chosen.id,preset_fingerprint:chosen.fingerprint}
     control.begin({pan:0,tilt:0,zoom:0},chosen.id,arrived=>{if(arrived&&alive.current)onSelect(choice)})
    }}>{busy?'正在转到布防视角…':'转到预置位并编辑'}</button>
    {busy?<button type="button" className="btn-secondary min-h-11" onClick={()=>control.stop()}><Square size={16}/>停止</button>:<button type="button" className="btn-secondary min-h-11" onClick={()=>setRetry(n=>n+1)}>刷新预置位</button>}
   </div>
   <div className="mt-5 border-t border-line pt-3">
    {!bound.length&&<button type="button" disabled={busy} className="btn-secondary min-h-11" onClick={()=>onSelect(null)}>仅编辑当前画面</button>}
    {!bound.length&&<p className="mt-2 text-xs text-ink-subtle">当前画面布防在转动后需要人工核对，不自动回位或恢复。</p>}
    <button type="button" className="mt-3 min-h-11 px-3 text-sm text-ink-subtle" onClick={close}>取消</button>
   </div>
  </div>
 </div>
}
