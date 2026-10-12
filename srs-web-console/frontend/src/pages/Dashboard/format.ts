export const names:Record<string,string>={host:'设备主机',frontend:'Web 前端',backend:'控制台后端',srs:'流媒体服务',postgres:'参数库',mongodb:'AI识别历史库','ai-service':'AI 识别',recorder:'录像服务',helper:'采集助手'}
export const bytes=(v:number|null|undefined)=>v==null?'不可用':v>=1024**3?`${(v/1024**3).toFixed(2)} GB`:`${(v/1024**2).toFixed(0)} MB`
export const percent=(v:number|null|undefined,digits=1)=>v==null?'—':`${v.toFixed(digits)}%`
// Service samples use 100% per core; host samples already use whole-machine capacity.
export const wholeHostCpu=(v:number|null|undefined,cores:number|null|undefined)=>
  v==null||!Number.isFinite(v)||cores==null||!Number.isFinite(cores)||cores<=0
    ?null:Math.min(100,Math.max(0,v/cores))
export const time=(v:number)=>new Date(v).toLocaleString('zh-CN',{hour12:false})
export const input='rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-blue-200'
export const button='rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50'
