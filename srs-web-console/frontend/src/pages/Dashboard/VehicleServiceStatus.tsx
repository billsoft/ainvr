import {useEffect,useState} from 'react'
import {vehicleService,type VehicleCapability} from '@/api/vehicleService'
export function VehicleServiceStatus(){
 const [data,setData]=useState<VehicleCapability|null>(null),[failed,setFailed]=useState(false)
 useEffect(()=>{let live=true,timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const value=await vehicleService.capability();if(live){setData(value);setFailed(false)}}catch{if(live)setFailed(true)}if(live)timer=setTimeout(tick,10000)};void tick();return()=>{live=false;clearTimeout(timer)}},[])
 const q=data?.queue
 return <details className="mt-2"><summary className="cursor-pointer">车牌处理 · {failed?'状态读取失败':!data?'读取中':q?`${q.pending} 条等待 · ${q.failed} 条失败`:'服务暂不可用'}</summary><div className="mt-1 space-y-1"><p>{data?.reason}</p>{q&&<><p>最老等待 {Math.ceil(q.oldest_wait_ms/1000)} 秒</p><p>最近单帧推理 {q.last_inference_ms??'—'} ms · 名单投递 {q.last_delivery_ms??'—'} ms</p>{q.last_failure&&<p>最近失败：{q.last_failure.phase==='delivery'?'名单投递':'识别'} · {q.last_failure.code} · {new Date(q.last_failure.at).toLocaleString()}</p>}<p>最近耗时不是容量或准确率认证。</p></>}</div></details>
}
