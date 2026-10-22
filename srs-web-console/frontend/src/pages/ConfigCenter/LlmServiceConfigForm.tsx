import {useRef,useState} from 'react'
import {Plus,Trash2,Play,Loader2} from 'lucide-react'
import {request} from '@/api/httpClient'
import type {ConfigDocument,ConfigChange} from '@/api/configService'
type Caller={name:string;key:string;reference:string}
export function LlmServiceConfigForm({document,onSaveBatch}:{document?:ConfigDocument;onSaveBatch:(changes:ConfigChange[])=>Promise<unknown>}){
  const config=document?.config??{}
  const schedule=config.scheduling as Record<string,number>|undefined
  const task=(config.tasks as Record<string,{calibration_temperature?:number}>|undefined)?.['alarm-review-zh-v1']
  const [enabled,setEnabled]=useState(config.enabled===true)
  const [temperature,setTemperature]=useState(String(task?.calibration_temperature??1))
  const [queue,setQueue]=useState(String(schedule?.queue_size??8)),[waiting,setWaiting]=useState(String(schedule?.queue_timeout_s??30))
  const [execution,setExecution]=useState(String(schedule?.exec_timeout_s??30)),[share,setShare]=useState(String(schedule?.submit_time_share_cap_percent??40))
  const [admin,setAdmin]=useState('')
  const [callers,setCallers]=useState<Caller[]>(()=>Array.isArray(config.api_keys)?config.api_keys.map(v=>({name:String(v.name),key:'',reference:String(v.key)})):[{name:'console-try',key:'',reference:''}])
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const [image,setImage]=useState(''),[kind,setKind]=useState('人员'),[description,setDescription]=useState('画面中出现人员')
  const [result,setResult]=useState<{real_score:number;timing_ms:{total:number};validated:boolean}|null>(null)
  const imageSelection=useRef(0)
  const initialCallers=Array.isArray(config.api_keys)?config.api_keys.map(v=>({name:String(v.name),key:'',reference:String(v.key)})):[{name:'console-try',key:'',reference:''}]
  const dirty=enabled!==(config.enabled===true)||admin!==''||temperature!==String(task?.calibration_temperature??1)||queue!==String(schedule?.queue_size??8)||waiting!==String(schedule?.queue_timeout_s??30)||execution!==String(schedule?.exec_timeout_s??30)||share!==String(schedule?.submit_time_share_cap_percent??40)||JSON.stringify(callers)!==JSON.stringify(initialCallers)
  function readImage(file?:File){
    const selection=++imageSelection.current
    setError('');setImage('');setResult(null)
    if(!file)return
    if(file.size>8*1024*1024){setError('图片不能超过 8 MB');return}
    const reader=new FileReader()
    reader.onload=()=>{if(selection===imageSelection.current)setImage(String(reader.result).split(',')[1]??'')}
    reader.onerror=()=>{if(selection===imageSelection.current)setError('图片读取失败，请重新选择')}
    reader.readAsDataURL(file)
  }
  async function save(){
    setError('');setMessage('')
    const t=Number(temperature),q=Number(queue),w=Number(waiting),e=Number(execution),s=Number(share)
    if(!Number.isFinite(t)||t<.05||t>10||!Number.isInteger(q)||q<1||q>32||!Number.isInteger(w)||w<1||w>300||!Number.isInteger(e)||e<1||e>120||!Number.isInteger(s)||s<5||s>90){setError('请检查温度、队列、超时与资源配额');return}
    const keys=callers.map(c=>({name:c.name,scope:'inference',key:c.key||c.reference}))
    if(!keys.length||keys.some(c=>!/^[a-zA-Z0-9_-]{1,48}$/.test(c.name)||c.key.length<32)||new Set(keys.map(c=>c.name)).size!==keys.length||(!admin&&!config.admin_key)||(admin&&admin.length<32)){setError('请为管理接口和每个调用方设置独立密钥，至少 32 个字符；调用方名称不能重复');return}
    setBusy(true)
    try{
      await onSaveBatch([{service:'llm-service',group:'system',name:'settings',config:{enabled,
        listen:{host:'127.0.0.1',port:8300},admin_key:admin||config.admin_key,api_keys:keys,
        model:{package_id:'qwen3vl-4b-review-v3',load_policy:'resident',ion_reserve_mb:512},
        tasks:{'alarm-review-zh-v1':{calibration_temperature:t,aspect_policy:'reject'}},
        scheduling:{queue_size:q,queue_timeout_s:w,exec_timeout_s:e,submit_time_share_cap_percent:s,prefill_profile:'s256'},
        logging:{record_requests:false}}}])
      setAdmin('');setCallers(previous=>previous.map(c=>({...c,key:''})))
      setMessage('配置已提交，请以上方服务应用状态为准。模型是否可用请查看仪表盘。')
    }catch{setError('配置尚未确认应用，输入已保留，请查看上方服务状态')}
    finally{setBusy(false)}
  }
  async function tryReview(){
    if(!image||!kind.trim()||!description.trim()){setError('请选择 JPEG 图片并填写告警类型和描述');return}
    setBusy(true);setError('');setResult(null)
    try{setResult(await request('/llm/try',{method:'POST',body:JSON.stringify({image:{jpeg_base64:image},alarm:{kind,description}}),signal:AbortSignal.timeout(445000)}))}
    catch{setError('复审未完成，请检查服务就绪状态、图片规格及调用方配置')}
    finally{setBusy(false)}
  }
  async function retryLoad(){
    setBusy(true);setError('');setMessage('')
    try{await request('/llm/admin/load',{method:'POST',body:'{}',signal:AbortSignal.timeout(15000)});setMessage('已请求加载，请在仪表盘查看模型状态。资源冲突时不会停止其他服务。')}
    catch{setError('未能开始加载，请先保存启用配置，并确认其他大模型已卸载。')}
    finally{setBusy(false)}
  }
  return <section aria-label="大模型微服务配置" className="space-y-5">
    <div><h2 className="text-base font-semibold text-ink">大模型微服务配置</h2><p className="mt-1 text-sm text-ink-subtle">为本机服务提供图片复审。触发器可选用异步 AI 审核；人工处理优先。本期不支持自由对话。</p></div>
    <fieldset disabled={busy} data-unsaved={dirty?'true':undefined} className="space-y-5">
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>启用并常驻加载模型</label>
      <dl className="grid gap-3 rounded-panel border border-line p-4 text-sm sm:grid-cols-2"><div><dt className="text-ink-subtle">本机调用地址</dt><dd>http://127.0.0.1:8300/v1</dd></div><div><dt className="text-ink-subtle">模型包</dt><dd>视觉语言模型 4B · 图片复审</dd></div></dl>
      <p className="text-sm text-ink-subtle">模型需要约 5.5 GB 专用内存，与开放词汇试用模型互斥加载。资源冲突时会拒绝加载，不会自动停止已有识别通道。首次加载需要等待，以仪表盘“模型就绪”为准。</p>
      <div><h3 className="mb-3 text-sm font-semibold">调用权限</h3>
        <label className="block text-sm">管理密钥<input className="form-input" type="password" autoComplete="new-password" value={admin} placeholder={config.admin_key?'已设置，留空保留':'至少 32 个字符'} onChange={e=>setAdmin(e.target.value)}/></label>
        <div className="mt-3 space-y-2">{callers.map((caller,index)=><div key={index} className="flex items-end gap-2"><label className="min-w-0 flex-1 text-sm">调用方<input className="form-input" value={caller.name} onChange={e=>setCallers(v=>v.map((c,i)=>i===index?{...c,name:e.target.value}:c))}/></label><label className="min-w-0 flex-[2] text-sm">推理密钥<input className="form-input" type="password" autoComplete="new-password" placeholder={caller.reference?'已设置，留空保留':'至少 32 个字符'} value={caller.key} onChange={e=>setCallers(v=>v.map((c,i)=>i===index?{...c,key:e.target.value}:c))}/></label><button type="button" className="btn-secondary min-h-11 min-w-11" aria-label={`移除调用方 ${caller.name}`} onClick={()=>setCallers(v=>v.filter((_,i)=>i!==index))}><Trash2 size={16}/></button></div>)}</div>
        <button type="button" className="btn-secondary mt-3 inline-flex items-center gap-2" disabled={callers.length>=16} onClick={()=>setCallers(v=>[...v,{name:'',key:'',reference:''}])}><Plus size={16}/>添加调用方</button>
        <p className="mt-2 text-sm text-ink-subtle">保存后移除的调用方失去访问权限；修改密钥即轮换。试一试使用 console-try 调用方，后台告警审核使用独立的 alarm-review 调用方。审核开关、说明和阈值在触发器中配置。密钥不回显、不下发给浏览器。</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[
        ['分数校准温度',temperature,setTemperature,.05,10,.05],['排队容量',queue,setQueue,1,32,1],
        ['排队超时（秒）',waiting,setWaiting,1,300,1],['执行超时（秒）',execution,setExecution,1,120,1],
        ['提交时间配额（%）',share,setShare,5,90,1],
      ].map(([label,value,set,min,max,step])=><label key={String(label)} className="text-sm">{String(label)}<input className="form-input" type="number" min={Number(min)} max={Number(max)} step={Number(step)} value={String(value)} onChange={e=>(set as (v:string)=>void)(e.target.value)}/></label>)}</div>
      <p className="text-sm text-ink-subtle">属实分数不是校准概率。改变温度后需重新评估阈值；提交时间配额不是整机利用率上限。执行超时包含配额等待，建议至少 30 秒；连续复审会影响同时运行的检测速度。</p>
      <div className="flex flex-wrap gap-3"><button type="button" className="btn-primary" onClick={()=>void save()}>{busy?'正在处理…':'保存并应用'}</button><button type="button" className="btn-secondary" disabled={!config.enabled} onClick={()=>void retryLoad()}>重试加载</button></div>
    </fieldset>
    <details className="rounded-panel border border-line p-4"><summary className="min-h-11 cursor-pointer text-sm font-semibold">试一试 · 不生成告警记录</summary><div className="mt-3 space-y-3">
      <label className="block text-sm">JPEG 图片（2:1）<input className="form-input" type="file" accept="image/jpeg" disabled={busy} onChange={e=>readImage(e.target.files?.[0])}/></label>
      <label className="block text-sm">告警类型<input className="form-input" value={kind} disabled={busy} onChange={e=>{setKind(e.target.value);setResult(null)}}/></label>
      <label className="block text-sm">告警描述<textarea className="form-input" value={description} disabled={busy} onChange={e=>{setDescription(e.target.value);setResult(null)}}/></label>
      <button className="btn-secondary inline-flex items-center gap-2" disabled={busy||!image} onClick={()=>void tryReview()}>{busy?<Loader2 size={16} className="animate-spin"/>:<Play size={16}/>}执行复审</button>
      {result&&<p role="status" className="text-sm">属实分数 {result.real_score.toPrecision(4)} · 用时 {(result.timing_ms.total/1000).toFixed(2)} 秒{!result.validated?' · 尚未启用自动告警复核，业务阈值需单独验证':''}</p>}
    </div></details>
    {error&&<p role="alert" className="text-sm text-danger-700">{error}</p>}{message&&<p role="status" className="text-sm">{message}</p>}
  </section>
}
