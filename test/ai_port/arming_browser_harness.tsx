// Test-only host: the production ArmingLauncher/Modal/ZoneEditor are imported unchanged.
import {useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ArmingLauncher} from '@/pages/AlarmCenter/ArmingLauncher'
import type {ChannelWithStatus} from '@/types/channel'
import '@/styles/globals.css'
const channel={id:'fixture-camera',name:'隔离验收画面',inputGeneration:'g',createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'} as ChannelWithStatus
const sourceChannels=await (await fetch('/api/channels')).json();
const sourceSize=sourceChannels.data.find((c:any)=>c.id==='fixture-camera')?.status;
if(!sourceSize?.videoWidth||!sourceSize?.videoHeight)throw Error('Fixture source dimensions unavailable');
function Harness(){
 const video=useRef<HTMLVideoElement>(null),host=useRef<HTMLDivElement>(null)
 const [open,setOpen]=useState(false),[ready,setReady]=useState(false),[message,setMessage]=useState('')
 useEffect(()=>{
  const canvas=document.createElement('canvas');canvas.width=sourceSize.videoWidth;canvas.height=sourceSize.videoHeight
  const ctx=canvas.getContext('2d')!;ctx.scale(canvas.width/1920,canvas.height/1080);let frame=0
  const paint=()=>{ctx.fillStyle='#24364b';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#637b8c';ctx.fillRect(650,0,620,1080);ctx.fillStyle='#bfdbfe';ctx.font='48px sans-serif';ctx.fillText('隔离测试画面 · 不连接现网',70,100);ctx.fillStyle='#fb923c';ctx.fillRect(850+(frame++%180),480,90,160)}
  paint();const timer=setInterval(paint,100);const stream=canvas.captureStream(10)
  video.current!.srcObject=stream
  void video.current!.play().then(()=>setReady(true))
  return()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop())}
 },[])
 return <main className="p-4"><h1>真实布防组件交互验收</h1><p>仅使用合成视频与隔离数据库，不代表硬件链路验收。</p>
  <div ref={host} className="bg-white"><video ref={video} autoPlay muted playsInline className="w-full" style={{maxHeight:'65vh'}}/>
   <div className="flex gap-3 p-3"><button className="min-h-11 border px-4" disabled={!ready} onClick={()=>setOpen(true)}>布防</button>
    <button className="min-h-11 border px-4" onClick={()=>void host.current!.requestFullscreen().catch(e=>setMessage(e.message))}>全屏</button></div>
   {open&&video.current&&<ArmingLauncher channel={channel} video={video.current} onClose={()=>setOpen(false)} onSaved={()=>setMessage('布防已保存；隔离服务未连接告警执行端')}/>}
  </div><p role="status">{message}</p>
 </main>
}
createRoot(document.getElementById('root')!).render(<Harness/>)
