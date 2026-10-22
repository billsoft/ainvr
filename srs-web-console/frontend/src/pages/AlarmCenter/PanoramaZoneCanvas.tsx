import {useEffect,useMemo,useRef,useState} from 'react'
import * as T from 'three'
import type {ZoneReference} from './ZoneReferenceLayer'
import type {ZonePoint} from '@/features/alarmGeometry'
import {erpToViewport,viewportToErp} from '@/components/player/panoramaCoordinates'
import {projectErpSegment} from '@/components/player/panoramaDetection'

interface Props {
  url:string
  referenceZones?:ZoneReference[]
  points:ZonePoint[]
  erpWrap?:boolean
  pan?:boolean
  locked:boolean
  finished:boolean
  selected:number|null
  onSelect:(index:number)=>void
  onAdd:(point:ZonePoint)=>void
  onChange:(points:ZonePoint[])=>void
}

/** Frozen reference only; never opens a second live media connection. Edits are
 * committed as source ERP coordinates, independent of view direction and zoom. */
export function PanoramaZoneCanvas({url,points,locked,finished,selected,onSelect,onAdd,onChange,erpWrap=false,pan=false,referenceZones=[]}:Props){
  const host=useRef<HTMLDivElement>(null)
  const [size,setSize]=useState({width:800,height:450})
  const [view,setView]=useState({yaw:0,pitch:0,fov:75})
  const [navigate,setNavigate]=useState(true)
  const [error,setError]=useState(''),[ready,setReady]=useState(false)
  const [preview,setPreview]=useState<ZonePoint[]|null>(null)
  const gesture=useRef<{id:number;x:number;y:number;view:typeof view;vertex:number|null;next:ZonePoint[]}|null>(null)
  const render=useRef<()=>void>(()=>{})
  const camera=useMemo(()=>{
    const c=new T.PerspectiveCamera(view.fov,size.width/size.height,.1,20)
    c.rotation.order='YXZ';c.rotation.set(view.pitch,view.yaw,0)
    c.updateMatrixWorld();c.updateProjectionMatrix()
    return c
  },[view,size])
  const currentCamera=useRef(camera);currentCamera.current=camera
  const matrix={view:camera.matrixWorldInverse.elements,projection:camera.projectionMatrix.elements}
  useEffect(()=>{
    const element=host.current;if(!element)return
    const resize=()=>setSize({width:Math.max(1,element.clientWidth),height:Math.max(1,element.clientHeight)})
    const observer=new ResizeObserver(resize);observer.observe(element);resize()
    return()=>observer.disconnect()
  },[])
  useEffect(()=>{
    const element=host.current;if(!element)return
    let disposed=false,renderer:T.WebGLRenderer|undefined,texture:T.Texture|undefined
    const geometry=new T.SphereGeometry(10,64,32).scale(-1,1,1)
    const material=new T.MeshBasicMaterial()
    const scene=new T.Scene();scene.add(new T.Mesh(geometry,material))
    setError('');setReady(false)
    try{
      renderer=new T.WebGLRenderer({antialias:true})
      renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2))
      element.prepend(renderer.domElement)
      renderer.domElement.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
      render.current=()=>{
        if(disposed||!renderer)return
        renderer.setSize(element.clientWidth,element.clientHeight,false)
        renderer.render(scene,currentCamera.current)
      }
      new T.TextureLoader().load(url,loaded=>{
        if(disposed){loaded.dispose();return}
        texture=loaded;texture.colorSpace=T.SRGBColorSpace
        material.map=texture;material.needsUpdate=true
        render.current();setReady(true)
      },undefined,()=>{if(!disposed)setError('全景参考画面加载失败，请返回平面编辑；草稿保留。')})
    }catch{setError('此设备无法创建全景编辑画面，请返回平面编辑；草稿保留。')}
    return()=>{
      disposed=true;render.current=()=>{}
      texture?.dispose();material.dispose();geometry.dispose()
      renderer?.domElement.remove();renderer?.dispose();renderer?.forceContextLoss()
    }
  },[url])
  useEffect(()=>{render.current()},[camera])
  const source=(x:number,y:number)=>{
    const rect=host.current?.getBoundingClientRect();if(!rect)return null
    return viewportToErp(x-rect.left,y-rect.top,matrix,rect.width,rect.height)
  }
  const visible=preview??points
  const edges=visible.flatMap((p,i)=>{
    if(visible.length<3&&i===visible.length-1)return []
    const q=visible[(i+1)%visible.length];if(!q)return []
    return projectErpSegment(p,q,matrix,size.width,size.height,erpWrap)
  })
  const end=(id:number,commit:boolean)=>{
    const g=gesture.current;if(!g||g.id!==id)return
    gesture.current=null;setPreview(null)
    if(g.vertex!==null&&commit)onChange(g.next)
    if(g.vertex===null&&!commit)setView(g.view)
  }
  const button='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div ref={host} role="group" aria-label="360°热区编辑画面" className="relative min-h-0 flex-1 overflow-hidden rounded-base bg-black" style={{touchAction:'none'}}
      onPointerDown={e=>{
        if((!navigate&&!pan)||locked||!ready||gesture.current||e.button!==0)return
        e.currentTarget.setPointerCapture(e.pointerId)
        gesture.current={id:e.pointerId,x:e.clientX,y:e.clientY,view,vertex:pan?-1:null,next:points}
      }}
      onPointerMove={e=>{
        const g=gesture.current;if(!g||g.id!==e.pointerId)return
        if(g.vertex===null){
          setView({...g.view,yaw:g.view.yaw+(e.clientX-g.x)*.004,
            pitch:Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,g.view.pitch+(e.clientY-g.y)*.004))})
        }else if(g.vertex===-1){
          const start=source(g.x,g.y),next=source(e.clientX,e.clientY);if(!start||!next)return
          let dx=next[0]-start[0];if(erpWrap)dx-=Math.round(dx);else dx=Math.max(-Math.min(...points.map(p=>p[0])),Math.min(1-Math.max(...points.map(p=>p[0])),dx))
          const dy=Math.max(-Math.min(...points.map(p=>p[1])),Math.min(1-Math.max(...points.map(p=>p[1])),next[1]-start[1]))
          g.next=points.map(p=>[erpWrap?((p[0]+dx)%1+1)%1:p[0]+dx,p[1]+dy]);setPreview(g.next)
        }else{
          const p=source(e.clientX,e.clientY);if(!p)return
          g.next=points.map((q,i)=>i===g.vertex?p:q);setPreview(g.next)
        }
      }}
      onPointerUp={e=>end(e.pointerId,true)}
      onPointerCancel={e=>end(e.pointerId,false)}
      onLostPointerCapture={e=>end(e.pointerId,false)}>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`} aria-label="全景区域绘图"
        onClick={e=>{
          if(pan||navigate||locked||!ready||finished)return
          const p=source(e.clientX,e.clientY);if(p)onAdd(p)
        }}>
        <g role="img" aria-label="已有热区参考" className="pointer-events-none">
          {referenceZones.map(z=>{
            const paths=z.points.flatMap((p,i)=>projectErpSegment(p,z.points[(i+1)%z.points.length]!,matrix,size.width,size.height,!!z.erpWrap))
            const label=z.points.map(p=>erpToViewport(p,matrix,size.width,size.height)).find(p=>p!==null)
            return <g key={z.id}><path d={paths.map(([a,b])=>`M${a[0]},${a[1]}L${b[0]},${b[1]}`).join(' ')} fill="none" stroke="#bae6fd" strokeWidth="2" strokeDasharray="6 4"/>{label&&<text x={label[0]+4} y={Math.max(18,label[1]-6)} fill="#e0f2fe" stroke="#0f172a" strokeWidth="3" paintOrder="stroke" fontSize="14">{z.name}</text>}</g>
          })}
        </g>
        {visible.length>=3&&visible.map((p,i)=>{const q=visible[(i+1)%visible.length]!;let dx=q[0]-p[0];if(erpWrap)dx-=Math.round(dx);const at=erpToViewport([p[0]+dx/2,(p[1]+q[1])/2],matrix,size.width,size.height);return at?<text key={i} x={at[0]} y={at[1]} fill="white" stroke="black" strokeWidth="3" paintOrder="stroke" fontSize="16" className="pointer-events-none">边 {i+1}</text>:null})}
        <path d={edges.map(([a,b])=>`M${a[0]},${a[1]}L${b[0]},${b[1]}`).join(' ')} fill="none" stroke="#60a5fa" strokeWidth="2" className="pointer-events-none"/>
      </svg>
      {visible.map((p,i)=>{
        const pos=erpToViewport(p,matrix,size.width,size.height);if(!pos)return null
        return <button key={i} type="button" aria-label={`全景顶点 ${i+1}`} aria-pressed={selected===i}
          disabled={pan||locked||navigate||!ready} className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-primary-600 text-white disabled:opacity-50"
          style={{left:pos[0],top:pos[1]}} onClick={e=>{e.stopPropagation();onSelect(i)}}
          onPointerDown={e=>{
            e.stopPropagation();if(pan||locked||navigate||!ready||gesture.current||e.button!==0)return
            onSelect(i);e.currentTarget.setPointerCapture(e.pointerId)
            gesture.current={id:e.pointerId,x:e.clientX,y:e.clientY,view,vertex:i,next:points}
          }}
          onKeyDown={e=>{
            const dx=e.key==='ArrowLeft'?-1:e.key==='ArrowRight'?1:0
            const dy=e.key==='ArrowUp'?-1:e.key==='ArrowDown'?1:0
            if(!dx&&!dy)return;e.preventDefault()
            const step=e.shiftKey?10:1
            const next=viewportToErp(pos[0]+dx*step,pos[1]+dy*step,matrix,size.width,size.height)
            if(next)onChange(points.map((q,j)=>j===i?next:q))
          }}>{i+1}</button>
      })}
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} aria-pressed={navigate} onClick={()=>setNavigate(true)}>调整视角</button>
      <button type="button" className={button} aria-pressed={!navigate} onClick={()=>setNavigate(false)}>绘制与拖点</button>
      <button type="button" className={button} onClick={()=>setView(v=>({...v,fov:Math.max(35,v.fov-10)}))}>放大视角</button>
      <button type="button" className={button} onClick={()=>setView(v=>({...v,fov:Math.min(100,v.fov+10)}))}>缩小视角</button>
      <button type="button" className={button} onClick={()=>setView({yaw:0,pitch:0,fov:75})}>重置视角</button>
    </div>
    {error&&<p role="alert">{error}</p>}
    <p className="text-sm text-ink-subtle">先拖动画面调整视角，再选择“绘制与拖点”。切回平面保留同一份区域草稿。</p>
  </div>
}
