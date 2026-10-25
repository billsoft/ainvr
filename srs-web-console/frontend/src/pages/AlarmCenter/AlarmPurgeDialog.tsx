import {useRef,useState} from 'react'
import {AlarmConfirmation} from './AlarmConfirmation'
import {alarmEventService} from '@/api/alarmEventService'
import {newAlarmOperationId} from '@/api/alarmZoneService'

export function AlarmPurgeDialog({close,cleared}:{close:()=>void;cleared:(count:number)=>void}){
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const key=useRef(newAlarmOperationId())
 const submit=async()=>{
  if(busy||!password)return
  setBusy(true);setError('')
  try{const result=await alarmEventService.purge(password,key.current)
   if(!result.cleared)throw Error('清理结果未确认，请重试同一次操作')
   cleared(result.deleted_count)
  }catch(e){setError(e instanceof Error?e.message:'清理结果未确认，请重试同一次操作')}
  finally{setBusy(false);setPassword('')}
 }
 return <AlarmConfirmation title="清空所有告警" busy={busy} close={close}>
  <form className="space-y-4" onSubmit={e=>{e.preventDefault();void submit()}}>
   <p className="text-sm leading-relaxed">将删除所有通道在本次操作前生成的告警及其审核记录，不受当前筛选影响。此操作不可撤销。</p>
   <p className="text-sm text-ink-subtle">录像、流量统计、触发器和布防配置保留。历史截图按原保留策略清理。操作期间产生的新告警继续保留。</p>
   <label className="block text-sm">系统密码<input type="password" autoComplete="current-password" maxLength={100} required disabled={busy} value={password} onChange={e=>setPassword(e.target.value)} className="form-input mt-2 min-h-11 w-full"/></label>
   {error&&<p role="alert" className="text-sm text-danger-700">{error}</p>}
   <div className="flex justify-end gap-3"><button type="button" className="btn-secondary !min-h-11" disabled={busy} onClick={close}>取消</button><button type="submit" disabled={busy||!password} className="btn-secondary !min-h-11 text-danger-700">{busy?'正在清空…':'验证密码并清空所有告警'}</button></div>
  </form>
 </AlarmConfirmation>
}
