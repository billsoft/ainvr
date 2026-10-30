import { request } from './httpClient'
export interface ServiceMetric { id:string; state:string; healthy?:boolean; cpuPercent:number|null; memoryBytes:number|null; connections:number|null; restarts?:number; oomKilled?:boolean; detail?:string; logPolicy?:Record<string,string> }
export interface Snapshot { ts:number; sampleSeconds:number; host:{cpuPercent:number|null;memoryBytes:number;memoryTotalBytes:number;gpuPercent:number|null;bpuPercent?:number|null;bpuMemoryBytes?:number|null;ionMemoryBytes?:number|null;ionMemoryTotalBytes?:number|null;cores:number;swapBytes:number;diskUsedBytes?:number;diskTotalBytes?:number;temperatureC?:number|null;network?:{name:string;rxBytesPerSecond:number|null;txBytesPerSecond:number|null}[]};services:ServiceMetric[] }
export interface LogSettings {fileMiB:number;files:number;historyHours:number;level:string;repeatSeconds:number}
export interface LogEntry {ts:number;source:string;level:string;module:string;category:string;message:string;count:number}
export interface Summary {snapshot:Snapshot|null;settings:LogSettings;sources:string[];applyError:string|null}
export interface ShutdownStatus {state:'idle'|'running'|'failed'|'poweringOff';error:string;restored:string[];restoreFailed:string[]}
export interface LogResult {items:LogEntry[];truncated:boolean;nextCursor:string|null;cursorExpired?:boolean}
async function get<T>(path:string,init?:RequestInit):Promise<T> {
  const response=await request<{code:number;data:T}>(`/observability/${path}`,{signal:AbortSignal.timeout(15000),...init})
  return response.data
}
export const observabilityService={
  summary:()=>get<Summary>('summary'),
  history:(hours:number)=>get<{items:Snapshot[]}>(`history?hours=${hours}`),
  logs:(query:URLSearchParams)=>get<LogResult>(`logs?${query}`),
  settings:(data:LogSettings)=>get<{applied:boolean}>('settings',{method:'PUT',body:JSON.stringify(data)}),
  // 安全关机：按顺序停服务并断电。不可逆操作，前端必须二次确认。
  shutdown:()=>get<{stepsCompleted:number}>('shutdown',{method:'POST'}),
  // 关机进度：失败时已中止关机并恢复已停的服务
  shutdownStatus:()=>get<ShutdownStatus>('shutdown/status'),
}
