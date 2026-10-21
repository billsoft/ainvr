import {useState} from 'react'
import type {ConfigDocument,ConfigChange} from '@/api/configService'
export function AlarmServiceConfigForm({document,onSaveBatch}:{document?:ConfigDocument;onSaveBatch:(changes:ConfigChange[])=>Promise<unknown>}){
  const config=document?.config??{}
  const [port,setPort]=useState(String(config.port??8200))
  const [database,setDatabase]=useState(String(config.database??'ainvr_alarm'))
  const [mongo,setMongo]=useState(''),[api,setApi]=useState(''),[producer,setProducer]=useState('')
  const evidence=config.evidence as {enabled?:boolean;retention_days?:number;max_bytes?:number}|undefined
  const [retain,setRetain]=useState(evidence?.enabled??false),[days,setDays]=useState(String(evidence?.retention_days??30)),[capacity,setCapacity]=useState(String((evidence?.max_bytes??2*1024**3)/1024**3))
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
  async function save(){
    setError('');setSaved(false)
    const n=Number(port)
    if(!Number.isInteger(n)||n<1024||n>65535||!/^[a-zA-Z0-9_-]{1,63}$/.test(database)||['admin','config','local'].includes(database)){setError('请检查端口和独立数据库名称');return}
    if((!mongo&&!config.mongo_uri)||(!api&&!config.api_token)||(!producer&&!config.producer_token)){setError('首次配置需要数据库连接和两种独立密钥');return}
    if((api&&api.length<32)||(producer&&producer.length<32)||(api&&api===producer)){setError('密钥至少 32 个字符，管理接口和数据输入不能相同');return}
    const retention=Number(days),bytes=Number(capacity)*1024**3
    if(!Number.isInteger(retention)||retention<1||retention>3650||!Number.isSafeInteger(bytes)||bytes<128*1024**2||bytes>1024**4){setError('请检查截图保留天数和容量（至少 0.125 GiB）');return}
    setBusy(true)
    try{await onSaveBatch([{service:'alarm-service',group:'system',name:'settings',config:{host:'127.0.0.1',port:n,database,
      mongo_uri:mongo||config.mongo_uri,api_token:api||config.api_token,producer_token:producer||config.producer_token,evidence:{enabled:retain,retention_days:retention,max_bytes:bytes}}}]);
      setMongo('');setApi('');setProducer('');setSaved(true)
    }catch{setError('配置应用未完成，请查看配置应用状态；输入仍保留')}
    finally{setBusy(false)}
  }
  const field='form-input'
  return <section className="space-y-4" aria-label="告警微服务配置"><h2 className="text-base font-semibold text-ink">告警微服务配置</h2>
    <p>独立处理行为、告警和统计。VLM 复核与通知暂未启用。</p>
    <fieldset disabled={busy} className="space-y-3">
      <label className="block">监听端口<input className={field} type="number" min={1024} max={65535} value={port} onChange={e=>setPort(e.target.value)}/></label>
      <label className="block">告警数据库名称<input className={field} value={database} onChange={e=>setDatabase(e.target.value)}/></label>
      <label className="block">告警数据库连接<input className={field} type="password" autoComplete="new-password" placeholder={config.mongo_uri?'已设置，留空保留':'首次设置'} value={mongo} onChange={e=>setMongo(e.target.value)}/></label>
      <label className="block">管理接口密钥<input className={field} type="password" autoComplete="new-password" placeholder={config.api_token?'已设置，留空保留':'至少 32 个字符'} value={api} onChange={e=>setApi(e.target.value)}/></label>
      <label className="block">AI 数据输入密钥<input className={field} type="password" autoComplete="new-password" placeholder={config.producer_token?'已设置，留空保留':'与管理密钥不同'} value={producer} onChange={e=>setProducer(e.target.value)}/></label>
      <fieldset className="space-y-3 rounded border border-line p-3"><legend className="px-1">告警截图独立保存</legend>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={retain} onChange={e=>setRetain(e.target.checked)}/>独立保存新告警的原帧目标截图</label>
        <label className="block">截图保留天数<input className={field} type="number" min="1" max="3650" value={days} onChange={e=>setDays(e.target.value)}/></label>
        <label className="block">截图容量上限（GiB）<input className={field} type="number" min="0.125" max="1024" step="0.125" value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
        <p className="text-sm text-ink-subtle">保存后的图片独立于识别历史。到期或达到容量时优先清理最早事件的图片，保留告警与行为记录。关闭后停止保存新截图，已有截图仍按此策略清理。仅统计的规则不保存图片，旧记录不会自动补存。</p>
      </fieldset>
      <p className="text-sm text-ink-subtle">敏感参数加密保存，不回显。监听限本机；服务确认新版本后才算应用完成。</p>
      <button className="btn-primary" onClick={()=>void save()}>{busy?'正在应用…':'保存并应用'}</button>
    </fieldset>{error&&<p role="alert">{error}</p>}{saved&&<p role="status">本次配置操作已完成，请以页面上方服务状态为准。</p>}
  </section>
}
