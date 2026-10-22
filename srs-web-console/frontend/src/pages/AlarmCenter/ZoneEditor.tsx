import {createPortal} from 'react-dom'
import {useWorkspaceDraft,type WorkspaceDraftRef} from './workspaceDraft'
import {Pentagon,RectangleHorizontal,Undo2,Redo2,Trash2,Move,ArrowLeft,Globe,Eraser} from 'lucide-react'
import {ToolButton,ToolDivider} from './ToolButton'
import {ZoneReferenceLayer,type ZoneReference} from './ZoneReferenceLayer'
import {ZoneEdgeLabels} from './ZoneEdgeLabels'
import {useRef,useState} from 'react'
import {erpDisplayPolygons} from '@/features/erpGeometry'
import {PanoramaZoneCanvas} from './PanoramaZoneCanvas'
import {FitFrame} from './FitFrame'
import {zoneGeometryError,type ZonePoint} from '@/features/alarmGeometry'
/** redrawn: the vertices were cleared and drawn again, so earlier edge identities no longer apply. */
export interface ZoneDraft {name:string;points:ZonePoint[];geometryRevision:string;erpWrap?:boolean;redrawn?:boolean}
interface DrawingStep {points:ZonePoint[];finished:boolean}
interface Props {
  referenceZones?:ZoneReference[]
  workspace:WorkspaceDraftRef
  onDiscard?:()=>void
  onCommit:(draft:ZoneDraft)=>void
  reference:{url:string;width:number;height:number;geometryRevision:string;capturedAt:string}
  panoramaAllowed?:boolean
  toolbarHost?:HTMLElement|null
  onEscape:()=>void
  /** Prefilled name for a new zone, so drawing never waits on typing. */
  defaultName?:string
  initial?:ZoneDraft
  onCancel:()=>void
}
export function ZoneEditor({reference,initial,onCancel,onEscape,toolbarHost,panoramaAllowed=false,defaultName='',workspace,onCommit,onDiscard,referenceZones=[]}:Props){
  const [revision]=useState(reference.geometryRevision)
  const [panorama,setPanorama]=useState(false)
  const [erpWrap]=useState(initial?.erpWrap??panoramaAllowed)
  const [name,setName]=useState(initial?.name??defaultName)
  const [points,setPoints]=useState<ZonePoint[]>(initial?.points??[])
  const [past,setPast]=useState<DrawingStep[]>([]),[future,setFuture]=useState<DrawingStep[]>([])
  const [mode,setMode]=useState<'polygon'|'rectangle'>('polygon')
  const [selectedVertex,setSelectedVertex]=useState<number|null>(null)
  const [pan,setPan]=useState(false)
  const panDrag=useRef<{pointerId:number;start:ZonePoint;before:ZonePoint[]}|null>(null)
  const rectangleDrag=useRef<{pointerId:number;anchor:ZonePoint;x:number;y:number}|null>(null)
  const [rectanglePreview,setRectanglePreview]=useState<ZonePoint[]|null>(null)
  const ignoreRectangleClick=useRef<{x:number;y:number}|null>(null)
  const [finished,setFinished]=useState(!!initial?.points.length)
  const [cleared,setCleared]=useState(false)
  const [loaded,setLoaded]=useState(''),[imageError,setImageError]=useState(''),[error,setError]=useState('')
  const canvas=useRef<HTMLDivElement>(null)
  const drag=useRef<{pointerId:number;index:number;before:ZonePoint[]}|null>(null)
  const changed=JSON.stringify(points)!==JSON.stringify(initial?.points??[])||name!==(initial?.name??defaultName)
  const stale=revision!==reference.geometryRevision||(initial&&initial.geometryRevision!==revision)
  const ready=loaded===reference.url&&!imageError&&!stale&&reference.width>0&&reference.height>0
  const locked=!ready||(erpWrap&&!panoramaAllowed)
  const problem=zoneGeometryError(points,erpWrap)
  const edit=(next:ZonePoint[])=>{setPast(p=>[...p.slice(-99),{points,finished}]);setFuture([]);setPoints(next);setSelectedVertex(null);setError('')}
  const coordinate=(x:number,y:number):ZonePoint|null=>{
    const box=canvas.current?.getBoundingClientRect();if(!box?.width||!box.height)return null
    return [Math.max(0,Math.min(1,(x-box.left)/box.width)),Math.max(0,Math.min(1,(y-box.top)/box.height))]
  }
  const rectangle=(a:ZonePoint,b:ZonePoint):ZonePoint[]=>{
    const left=Math.min(a[0],b[0]),right=Math.max(a[0],b[0]),top=Math.min(a[1],b[1]),bottom=Math.max(a[1],b[1])
    return [[left,top],[right,top],[right,bottom],[left,bottom]]
  }
  const addPoint=(point:ZonePoint)=>{
    if(locked||pan||finished||points.length>=32)return
    if(mode==='rectangle'&&points.length===1){const a=points[0];if(!a)return;edit(rectangle(a,point));setFinished(true)}
    else edit([...points,point])
  }
  const add=(x:number,y:number)=>{
    const ignored=ignoreRectangleClick.current;ignoreRectangleClick.current=null
    if(ignored&&Math.abs(ignored.x-x)<1&&Math.abs(ignored.y-y)<1)return
    const point=coordinate(x,y);if(point)addPoint(point)
  }
  const cancelRectangle=(pointerId:number)=>{
    if(rectangleDrag.current?.pointerId!==pointerId)return
    rectangleDrag.current=null;setRectanglePreview(null)
  }
  const translated=(before:ZonePoint[],dx:number,dy:number):ZonePoint[]=>{
    if(!erpWrap)dx=Math.max(-Math.min(...before.map(p=>p[0])),Math.min(1-Math.max(...before.map(p=>p[0])),dx))
    dy=Math.max(-Math.min(...before.map(p=>p[1])),Math.min(1-Math.max(...before.map(p=>p[1])),dy))
    return before.map(p=>[erpWrap?((p[0]+dx)%1+1)%1:p[0]+dx,p[1]+dy])
  }
  useWorkspaceDraft(workspace,{dirty:()=>changed,flush:()=>{
    if(!changed&&initial)return true
    if(!changed&&!points.length)return true
    if(locked||problem||!name.trim()||points.length<3){setError(problem||(!name.trim()?'请填写热区名称':'请先完成有效区域，并等待参考画面加载。'));return false}
    try{onCommit({name:name.trim(),points:points.map(p=>[...p] as ZonePoint),geometryRevision:revision,erpWrap,redrawn:cleared&&JSON.stringify(points)!==JSON.stringify(initial?.points??[])});return true}
    catch(e){setError(e instanceof Error?e.message:'区域修改无效');return false}
  }})
  const insertAt=(edge:number)=>{
    const a=points[edge],b=points[(edge+1)%points.length]
    if(!a||!b||locked||pan||points.length>=32)return
    edit([...points.slice(0,edge+1),midpoint(a,b),...points.slice(edge+1)]);setSelectedVertex(edge+1)
  }
  const midpoint=(a:ZonePoint,b:ZonePoint):ZonePoint=>[erpWrap?((a[0]+(b[0]-a[0]-Math.round(b[0]-a[0]))/2)%1+1)%1:(a[0]+b[0])/2,(a[1]+b[1])/2]

  const visiblePoints=rectanglePreview??points
  const closedPreview=visiblePoints.length>=3
  // Drawing tools sit above the picture; the workspace keeps its one global save.
  const tools=(<div className="flex min-w-max flex-1 items-center gap-2">
      <label className="flex shrink-0 items-center gap-2 text-sm text-ink"><span className="hidden lg:inline">名称</span><input aria-label="区域名称" className="form-input w-24 lg:w-40" value={name} maxLength={128}  placeholder="例如：门前禁区" onChange={e=>{setName(e.target.value)}}/></label>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <ToolDivider/>
        {panoramaAllowed&&<ToolButton icon={<Globe size={20} aria-hidden="true"/>} label={panorama?'平面':'360°'} name={panorama?'切回平面画面':'360° 编辑'} pressed={panorama} disabled={locked} onClick={()=>{setPanorama(!panorama);setPan(false)}}/>}
        <ToolButton icon={<Pentagon size={20} aria-hidden="true"/>} label="多边形" pressed={mode==='polygon'} disabled={locked||!!points.length} onClick={()=>setMode('polygon')}/>
        <ToolButton icon={<RectangleHorizontal size={20} aria-hidden="true"/>} label="矩形" pressed={mode==='rectangle'} disabled={locked||!!points.length} onClick={()=>setMode('rectangle')}/>
        <ToolDivider/>
        <ToolButton icon={<Move size={20} aria-hidden="true"/>} label="平移" name="平移区域" pressed={pan} disabled={locked||points.length<3||!!problem} onClick={()=>{setPan(!pan);setSelectedVertex(null)}}/>
        <ToolButton icon={<Trash2 size={20} aria-hidden="true"/>} label="删除顶点" name="删除选中顶点" disabled={locked||pan||selectedVertex===null||points.length<=3} onClick={()=>{edit(points.filter((_,index)=>index!==selectedVertex));setSelectedVertex(null)}}/>
        <ToolButton icon={<Eraser size={20} aria-hidden="true"/>} label="清空" name="清空顶点" disabled={locked||!points.length} onClick={()=>{edit([]);setPan(false);setFinished(false);setCleared(true)}}/>
        <ToolDivider/>
        <ToolButton icon={<Undo2 size={20} aria-hidden="true"/>} label="撤销" disabled={locked||!past.length} onClick={()=>{const previous=past[past.length-1];if(!previous)return;setFuture([{points,finished},...future]);setPoints(previous.points);setPast(past.slice(0,-1));setFinished(previous.finished);setSelectedVertex(null);setPan(false)}}/>
        <ToolButton icon={<Redo2 size={20} aria-hidden="true"/>} label="重做" disabled={locked||!future.length} onClick={()=>{const next=future[0];if(!next)return;setPast([...past,{points,finished}]);setPoints(next.points);setFuture(future.slice(1));setFinished(next.finished);setSelectedVertex(null);setPan(false)}}/>
      </div>
      {changed&&<button type="button" className="btn-secondary shrink-0" onClick={onDiscard}>撤销本处修改</button>}
      {!toolbarHost&&<button type="button" className="btn-secondary shrink-0" onClick={onCancel}><ArrowLeft size={16} aria-hidden="true"/>返回画面</button>}
    </div>)
  return <section aria-label="编辑警戒区" className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onEscape()}}}>
    {toolbarHost?createPortal(tools,toolbarHost):<div role="toolbar" aria-label="热区绘制工具">{tools}</div>}
    {erpWrap&&!panoramaAllowed&&<p role="alert" className="shrink-0 px-4 pt-2 text-sm text-danger">请先在布防画面类型中确认来源为全景画面，再编辑此区域。</p>}
    <div className="flex min-h-0 flex-1 flex-col bg-surface-page p-3">
    {panorama&&<PanoramaZoneCanvas url={reference.url} points={points} referenceZones={referenceZones} erpWrap={erpWrap} pan={pan} locked={locked} finished={finished} selected={selectedVertex} onSelect={setSelectedVertex} onAdd={addPoint} onChange={edit}/>}
    <FitFrame hidden={panorama} frameRef={canvas} width={reference.width} height={reference.height}>
      <img src={reference.url} alt="警戒区原始参考画面" draggable={false} className="absolute inset-0 h-full w-full" onLoad={e=>{if(e.currentTarget.naturalWidth!==reference.width||e.currentTarget.naturalHeight!==reference.height){setImageError('参考图尺寸与来源不匹配');return}setLoaded(reference.url);setImageError('')}} onError={()=>{setLoaded('');setImageError('参考画面加载失败，不能绘制或保存')}}/>
      <ZoneReferenceLayer zones={referenceZones} width={reference.width} height={reference.height}/>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${reference.width} ${reference.height}`} preserveAspectRatio="none" aria-label="警戒区绘图区域" onClick={e=>add(e.clientX,e.clientY)}
        onPointerDown={e=>{
          if(locked||pan||mode!=='rectangle'||finished||rectangleDrag.current||e.button!==0||e.isPrimary===false)return
          const point=coordinate(e.clientX,e.clientY);if(!point)return
          rectangleDrag.current={pointerId:e.pointerId,anchor:points[0]??point,x:e.clientX,y:e.clientY}
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e=>{
          const d=rectangleDrag.current;if(!d||d.pointerId!==e.pointerId||locked)return
          if(Math.hypot(e.clientX-d.x,e.clientY-d.y)<5)return
          const point=coordinate(e.clientX,e.clientY);if(point)setRectanglePreview(rectangle(d.anchor,point))
        }}
        onPointerUp={e=>{
          const d=rectangleDrag.current;if(!d||d.pointerId!==e.pointerId)return
          rectangleDrag.current=null;setRectanglePreview(null)
          if(Math.hypot(e.clientX-d.x,e.clientY-d.y)<5)return
          ignoreRectangleClick.current={x:e.clientX,y:e.clientY}
          const point=coordinate(e.clientX,e.clientY);if(!point||locked)return
          const next=rectangle(d.anchor,point),reason=zoneGeometryError(next,erpWrap)
          if(reason){setError('请拖出有宽度和高度的矩形。'+reason);return}
          edit(next);setFinished(true)
        }}
        onPointerCancel={e=>cancelRectangle(e.pointerId)} onLostPointerCapture={e=>cancelRectangle(e.pointerId)}>
        {closedPreview&&erpDisplayPolygons(visiblePoints,erpWrap).map((poly,i)=><polygon key={i} points={poly.map(([x,y])=>`${x*reference.width},${y*reference.height}`).join(' ')} fill="rgba(37,99,235,0.15)" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
        {!closedPreview&&visiblePoints.length>1&&<polyline points={visiblePoints.map(([x,y])=>`${x*reference.width},${y*reference.height}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/>}
      </svg>
      {closedPreview&&<ZoneEdgeLabels points={visiblePoints} wrap={erpWrap} offset/>}
      {points.map((p,index)=><button key={index} type="button" aria-label={`顶点 ${index+1}，方向键调整`} aria-pressed={selectedVertex===index} onClick={()=>{setSelectedVertex(index)}} disabled={locked||pan} className="zone-vertex group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" style={{left:`${p[0]*100}%`,top:`${p[1]*100}%`}}
        onPointerDown={e=>{if(locked||pan||drag.current||panDrag.current||e.button!==0)return;setSelectedVertex(index);e.currentTarget.setPointerCapture(e.pointerId);drag.current={pointerId:e.pointerId,index,before:points.map(q=>[...q] as ZonePoint)}}}
        onPointerMove={e=>{if(locked||drag.current?.index!==index||drag.current.pointerId!==e.pointerId)return;const next=coordinate(e.clientX,e.clientY);if(next){setPoints(current=>current.map((q,i)=>i===index?next:q))}}}
        onPointerUp={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){const before=drag.current.before;setPast(current=>[...current.slice(-99),{points:before,finished}]);setFuture([]);drag.current=null}}}
        onPointerCancel={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){setPoints(drag.current.before);drag.current=null}}}
        onLostPointerCapture={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){setPoints(drag.current.before);drag.current=null}}}
        onKeyDown={e=>{if(locked||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const amount=e.shiftKey?.01:.001;const q:ZonePoint=[...p];q[0]=Math.max(0,Math.min(1,q[0]+(e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0)));q[1]=Math.max(0,Math.min(1,q[1]+(e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0)));edit(points.map((v,i)=>i===index?q:v))}}><span aria-hidden="true" className={`zone-vertex-dot flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-primary text-[11px] font-semibold leading-none text-white shadow-sm transition-transform group-aria-pressed:scale-110 group-aria-pressed:ring-2 group-aria-pressed:ring-primary/40`}>{index+1}</span></button>)}
      {closedPreview&&!pan&&points.map((p,i)=>{const q=points[(i+1)%points.length]!;const m=midpoint(p,q);return <button key={`mid-${i}`} type="button" aria-label={`在边 ${i+1} 中点插入顶点`} disabled={locked||points.length>=32}
        className="group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center disabled:hidden" style={{left:`${m[0]*100}%`,top:`${m[1]*100}%`}} onClick={()=>insertAt(i)}>
        <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-white/90 text-sm font-semibold leading-none text-primary shadow-sm group-hover:bg-primary group-hover:text-white">+</span></button>})}
      {pan&&!panorama&&<div role="group" aria-label="区域平移操作面" tabIndex={0} className="absolute inset-0 cursor-move focus:outline focus:outline-2 focus:outline-primary-600"
        onPointerDown={e=>{if(locked||panDrag.current||drag.current||e.button!==0)return;const start=coordinate(e.clientX,e.clientY);if(!start)return;e.currentTarget.setPointerCapture(e.pointerId);panDrag.current={pointerId:e.pointerId,start,before:points.map(p=>[...p] as ZonePoint)}}}
        onPointerMove={e=>{const d=panDrag.current;if(locked||!d||d.pointerId!==e.pointerId)return;const pos=coordinate(e.clientX,e.clientY);if(pos){setPoints(translated(d.before,pos[0]-d.start[0],pos[1]-d.start[1]))}}}
        onPointerUp={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){const before=panDrag.current.before;setPast(p=>[...p.slice(-99),{points:before,finished}]);setFuture([]);panDrag.current=null}}}
        onPointerCancel={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){setPoints(panDrag.current.before);panDrag.current=null}}}
        onLostPointerCapture={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){setPoints(panDrag.current.before);panDrag.current=null}}}
        onKeyDown={e=>{if(locked||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const step=e.shiftKey?.01:.001;edit(translated(points,e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0))}}/>}
    </FitFrame>
    </div>
    <div className="flex min-h-9 shrink-0 flex-nowrap overflow-x-auto whitespace-nowrap items-center gap-x-3 border-t border-line px-4 py-1.5 text-xs text-ink-faint" aria-live="polite">
      <span>{finished?'拖动顶点调整形状；点边上的 + 插入顶点；选中顶点后可删除；开启“平移”后拖动整体移动。方向键微调，Shift 加大步长。':mode==='rectangle'?'拖动画面框选矩形；也可依次点击两个对角。':points.length>=3?'区域已自动闭合；继续点击加点，或拖动顶点调整。':'依次点击顶点；从第 3 个点起自动闭合，可继续加点。'}</span>
      <span>{erpWrap?'全景环绕区域：左右接缝相连，须小于半圈':'平面区域'} · 参考帧 {reference.capturedAt}</span>
      {stale&&<span role="alert" className="text-sm text-danger">来源画面已改变，请保留草稿并重新打开编辑器确认区域。</span>}
      {imageError&&<span role="alert" className="text-sm text-danger">{imageError}</span>}{points.length>0&&problem&&<span role="status" className="text-sm text-warning">{problem}</span>}{error&&<span role="alert" className="text-sm text-danger">{error}</span>}
    </div>
  </section>
}
