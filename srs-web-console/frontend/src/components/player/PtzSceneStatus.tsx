import {useEffect,useState} from 'react'
import {armingSceneService,sceneStateLabel,type ArmingScene} from '@/api/armingSceneService'

/** Compact read-only status. A failed poll never claims that protection cleared. */
export function PtzSceneStatus({sourceId,processorId,onReturn,disabled=false}:{sourceId:string;processorId:string;onReturn?:(preset:string)=>void;disabled?:boolean}) {
 const [value,setValue]=useState<{scope:string;items:ArmingScene[];stale:boolean}>()
 const scope=JSON.stringify([sourceId,processorId])
 useEffect(()=>{
  let alive=true;let timer:ReturnType<typeof setTimeout>
  const tick=async()=>{
   try{
    if(!document.hidden){
     const result=await armingSceneService.read(sourceId,processorId)
     if(!Array.isArray(result.items))throw Error('invalid scenes')
     if(alive)setValue({scope,items:result.items.filter(s=>s.processor_id===processorId),stale:false})
    }
   }catch{if(alive)setValue(old=>({scope,items:old?.scope===scope?old.items:[],stale:true}))}
   finally{if(alive)timer=setTimeout(tick,5000)}
  }
  void tick();return()=>{alive=false;clearTimeout(timer)}
 },[scope,sourceId,processorId])
 if(value?.scope!==scope||(!value.items.length&&!value.stale))return null
 const formal=value.items.filter(s=>s.binding_mode==='preset')
 const homes=[...new Set(formal.map(s=>s.preset_id).filter((id):id is string=>!!id))]
 const counts=(['matched','pending','unmatched'] as const).map(state=>({state,count:formal.filter(s=>s.state===state).length})).filter(v=>v.count)
 return <div role="status" aria-label="布防视角状态" className="ptz-section space-y-2 text-xs text-slate-300">
  {value.stale?<span className="text-amber-200">布防视角状态暂未更新，请核对连接。</span>:<>
   {counts.map(v=><span key={v.state} className={'mr-2 '+(v.state==='matched'?'text-slate-200':'text-amber-200')}>{sceneStateLabel(v.state,'preset')} {v.count}</span>)}
   {value.items.length>formal.length&&<span className="block text-amber-200">旧版自动附着已暂停，请重新配置布防预置位。</span>}
  </>}
  {formal.length>0&&<p>{value.stale||formal.some(s=>s.state!=='matched')?'视角未确认期间，相关告警与计数暂停。':'视角核验通过；告警是否生效以布防配置为准。'}</p>}
  {onReturn&&homes.length===1&&<button type="button" className="flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-600 px-2 text-sm hover:bg-slate-800 disabled:opacity-40" disabled={disabled||value.stale} onClick={()=>onReturn(homes[0]!)}>返回布防视角</button>}
 </div>
}
