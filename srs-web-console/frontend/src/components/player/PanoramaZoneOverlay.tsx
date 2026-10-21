import {useEffect,useRef,type RefObject} from 'react'
import type {AlarmZone} from '@/api/alarmZoneService'
import {projectErpSegment,type PanoramaCamera} from './panoramaDetection'

/** Presentation only: uses the very same camera as the video and detection boxes. */
export function PanoramaZoneOverlay({video,zones,camera,compact}:{video:HTMLVideoElement;zones:AlarmZone[];camera:RefObject<PanoramaCamera|null>;compact:boolean}){
 const ref=useRef<HTMLCanvasElement>(null)
 useEffect(()=>{
  const canvas=ref.current,ctx=canvas?.getContext('2d');if(!canvas||!ctx)return
  let raf=0,last=''
  const draw=()=>{
   raf=requestAnimationFrame(draw);if(document.hidden)return
   const rect=video.getBoundingClientRect(),view=camera.current,dpr=Math.min(window.devicePixelRatio||1,2)
   const key=JSON.stringify([rect.width,rect.height,dpr,view?.view,view?.projection])
   if(last===key)return;last=key
   canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr)
   ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height)
   if(!view||!rect.width||!rect.height)return
   ctx.save();ctx.beginPath();ctx.rect(0,0,rect.width,rect.height);ctx.clip()
   ctx.lineWidth=2;ctx.strokeStyle='#22d3ee';ctx.font='13px sans-serif'
   for(const zone of zones){
    let label:[number,number]|undefined;ctx.beginPath()
    for(let i=0;i<zone.points.length;i++){
     const a=zone.points[i]!,b=zone.points[(i+1)%zone.points.length]!
     for(const [p,q] of projectErpSegment(a,b,view,rect.width,rect.height,zone.erp_wrap===true)){
      ctx.moveTo(...p);ctx.lineTo(...q)
      if(!label&&p[0]>=0&&p[0]<=rect.width&&p[1]>=0&&p[1]<=rect.height)label=p
     }
    }
    ctx.stroke()
    if(label&&!compact){const x=Math.max(4,Math.min(rect.width-ctx.measureText(zone.name).width-4,label[0])),y=Math.max(16,Math.min(rect.height-4,label[1]-5));
     ctx.lineWidth=3;ctx.strokeStyle='black';ctx.strokeText(zone.name,x,y);ctx.fillStyle='white';ctx.fillText(zone.name,x,y);ctx.lineWidth=2;ctx.strokeStyle='#22d3ee'}
   }
   ctx.restore()
  };raf=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf)
 },[video,zones,camera,compact])
 return <canvas ref={ref} aria-label="全景警戒区" className="pointer-events-none absolute inset-0 h-full w-full"/>
}
