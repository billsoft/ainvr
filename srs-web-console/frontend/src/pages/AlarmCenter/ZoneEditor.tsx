import {Pentagon,RectangleHorizontal,Undo2,Redo2,Trash2,Move,Check,Save,ArrowLeft,Globe} from 'lucide-react'
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
  reference:{url:string;width:number;height:number;geometryRevision:string;capturedAt:string}
  panoramaAllowed?:boolean
  draftOnly?:boolean
  initial?:ZoneDraft
  onSave:(draft:ZoneDraft)=>Promise<void>
  onCancel:()=>void
}
export function ZoneEditor({reference,initial,onSave,onCancel,draftOnly=false,panoramaAllowed=false}:Props){
  const [revision]=useState(reference.geometryRevision)
  const [panorama,setPanorama]=useState(false)
  const [erpWrap]=useState(initial?.erpWrap??panoramaAllowed)
  const [name,setName]=useState(initial?.name??'')
  const [points,setPoints]=useState<ZonePoint[]>(initial?.points??[])
  const [past,setPast]=useState<DrawingStep[]>([]),[future,setFuture]=useState<DrawingStep[]>([])
  const [mode,setMode]=useState<'polygon'|'rectangle'>('polygon')
  const [selectedVertex,setSelectedVertex]=useState<number|null>(null)
  const [pan,setPan]=useState(false)
  const panDrag=useRef<{pointerId:number;start:ZonePoint;before:ZonePoint[]}|null>(null)
  const [finished,setFinished]=useState(!!initial?.points.length)
  const [cleared,setCleared]=useState(false)
  const [loaded,setLoaded]=useState(''),[imageError,setImageError]=useState(''),[error,setError]=useState('')
  const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[confirmCancel,setConfirmCancel]=useState(false)
  const canvas=useRef<HTMLDivElement>(null)
  const drag=useRef<{pointerId:number;index:number;before:ZonePoint[]}|null>(null)
  const changed=JSON.stringify(points)!==JSON.stringify(initial?.points??[])||name!==(initial?.name??'')
  const stale=revision!==reference.geometryRevision||(initial&&initial.geometryRevision!==revision)
  const ready=loaded===reference.url&&!imageError&&!stale&&reference.width>0&&reference.height>0
  const locked=!ready||saving||(erpWrap&&!panoramaAllowed)
  const problem=zoneGeometryError(points,erpWrap)
  const edit=(next:ZonePoint[])=>{setPast(p=>[...p.slice(-99),{points,finished}]);setFuture([]);setPoints(next);setSelectedVertex(null);setSaved(false);setError('')}
  const coordinate=(x:number,y:number):ZonePoint|null=>{
    const box=canvas.current?.getBoundingClientRect();if(!box?.width||!box.height)return null
    return [Math.max(0,Math.min(1,(x-box.left)/box.width)),Math.max(0,Math.min(1,(y-box.top)/box.height))]
  }
  const addPoint=(point:ZonePoint)=>{
    if(locked||pan||finished||points.length>=32)return
    if(mode==='rectangle'&&points.length===1){const a=points[0];if(!a)return;edit([[Math.min(a[0],point[0]),Math.min(a[1],point[1])],[Math.max(a[0],point[0]),Math.min(a[1],point[1])],[Math.max(a[0],point[0]),Math.max(a[1],point[1])],[Math.min(a[0],point[0]),Math.max(a[1],point[1])]]);setFinished(true)}
    else edit([...points,point])
  }
  const add=(x:number,y:number)=>{const point=coordinate(x,y);if(point)addPoint(point)}
  const translated=(before:ZonePoint[],dx:number,dy:number):ZonePoint[]=>{
    if(!erpWrap)dx=Math.max(-Math.min(...before.map(p=>p[0])),Math.min(1-Math.max(...before.map(p=>p[0])),dx))
    dy=Math.max(-Math.min(...before.map(p=>p[1])),Math.min(1-Math.max(...before.map(p=>p[1])),dy))
    return before.map(p=>[erpWrap?((p[0]+dx)%1+1)%1:p[0]+dx,p[1]+dy])
  }
  const save=async()=>{
    if(locked||!finished||problem||!name.trim())return
    setSaving(true);setError('')
    const redrawn=cleared&&JSON.stringify(points)!==JSON.stringify(initial?.points??[])
    try{await onSave({name:name.trim(),points:points.map(p=>[...p] as ZonePoint),geometryRevision:revision,...(erpWrap?{erpWrap:true}:{}),...(redrawn?{redrawn:true}:{})});setSaved(true)}
    catch{setError('保存未确认，区域草稿已保留。请检查状态或处理版本冲突后重试。')}
    finally{setSaving(false)}
  }
  const button='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
  const insertAt=(edge:number)=>{
    const a=points[edge],b=points[(edge+1)%points.length]
    if(!a||!b||locked||pan||points.length>=32)return
    edit([...points.slice(0,edge+1),midpoint(a,b),...points.slice(edge+1)]);setSelectedVertex(edge+1)
  }
  const midpoint=(a:ZonePoint,b:ZonePoint):ZonePoint=>[erpWrap?((a[0]+(b[0]-a[0]-Math.round(b[0]-a[0]))/2)%1+1)%1:(a[0]+b[0])/2,(a[1]+b[1])/2]
  return <section aria-label="编辑警戒区" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex items-center gap-2 text-sm text-ink">区域名称<input className="form-input w-56" value={name} maxLength={128} disabled={saving} placeholder="例如：门前禁区" onChange={e=>{setName(e.target.value);setSaved(false)}}/></label>
      <span className="text-xs text-ink-faint">{erpWrap?'全景环绕区域：左右接缝相连，须小于半圈':'平面区域：画面左右边缘不相连'} · 参考帧 {reference.capturedAt}</span>
    </div>
    {erpWrap&&!panoramaAllowed&&<p role="alert" className="shrink-0 text-sm text-danger">请先在布防画面类型中确认来源为全景画面，再编辑此区域。</p>}
    {panorama&&<PanoramaZoneCanvas url={reference.url} points={points} erpWrap={erpWrap} pan={pan} locked={locked} finished={finished} selected={selectedVertex} onSelect={index=>{setSelectedVertex(index)}} onAdd={addPoint} onChange={edit}/>}
    <FitFrame hidden={panorama} frameRef={canvas} width={reference.width} height={reference.height}>
      <img src={reference.url} alt="警戒区原始参考画面" draggable={false} className="absolute inset-0 h-full w-full" onLoad={e=>{if(e.currentTarget.naturalWidth!==reference.width||e.currentTarget.naturalHeight!==reference.height){setImageError('参考图尺寸与来源不匹配');return}setLoaded(reference.url);setImageError('')}} onError={()=>{setLoaded('');setImageError('参考画面加载失败，不能绘制或保存')}}/>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${reference.width} ${reference.height}`} preserveAspectRatio="none" aria-label="警戒区绘图区域" onClick={e=>add(e.clientX,e.clientY)}>

        {erpDisplayPolygons(points,erpWrap).map((poly,i)=><polygon key={i} points={poly.map(([x,y])=>`${x*reference.width},${y*reference.height}`).join(' ')} fill="rgba(37,99,235,0.15)" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
      </svg>
      {finished&&<ZoneEdgeLabels points={points} wrap={erpWrap} offset/>}
      {points.map((p,index)=><button key={index} type="button" aria-label={`顶点 ${index+1}，方向键调整`} aria-pressed={selectedVertex===index} onClick={()=>{setSelectedVertex(index)}} disabled={locked||pan} className="zone-vertex group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" style={{left:`${p[0]*100}%`,top:`${p[1]*100}%`}}
        onPointerDown={e=>{if(locked||pan||drag.current||panDrag.current||e.button!==0)return;setSelectedVertex(index);e.currentTarget.setPointerCapture(e.pointerId);drag.current={pointerId:e.pointerId,index,before:points.map(q=>[...q] as ZonePoint)}}}
        onPointerMove={e=>{if(locked||drag.current?.index!==index||drag.current.pointerId!==e.pointerId)return;const next=coordinate(e.clientX,e.clientY);if(next){setPoints(current=>current.map((q,i)=>i===index?next:q));setSaved(false)}}}
        onPointerUp={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){const before=drag.current.before;setPast(current=>[...current.slice(-99),{points:before,finished}]);setFuture([]);drag.current=null}}}
        onPointerCancel={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){setPoints(drag.current.before);drag.current=null}}}
        onLostPointerCapture={e=>{if(drag.current?.pointerId===e.pointerId&&drag.current){setPoints(drag.current.before);drag.current=null}}}
        onKeyDown={e=>{if(locked||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const amount=e.shiftKey?.01:.001;const q:ZonePoint=[...p];q[0]=Math.max(0,Math.min(1,q[0]+(e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0)));q[1]=Math.max(0,Math.min(1,q[1]+(e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0)));edit(points.map((v,i)=>i===index?q:v))}}><span aria-hidden="true" className="zone-vertex-dot flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-primary text-[11px] font-semibold leading-none text-white shadow-sm transition-transform group-aria-pressed:scale-110 group-aria-pressed:ring-2 group-aria-pressed:ring-primary/40">{index+1}</span></button>)}
      {finished&&!pan&&points.map((p,i)=>{const q=points[(i+1)%points.length]!;const m=midpoint(p,q);return <button key={`mid-${i}`} type="button" aria-label={`在边 ${i+1} 中点插入顶点`} disabled={locked||points.length>=32}
        className="group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center disabled:hidden" style={{left:`${m[0]*100}%`,top:`${m[1]*100}%`}} onClick={()=>insertAt(i)}>
        <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-white/90 text-sm font-semibold leading-none text-primary shadow-sm group-hover:bg-primary group-hover:text-white">+</span></button>})}
      {pan&&!panorama&&<div role="group" aria-label="区域平移操作面" tabIndex={0} className="absolute inset-0 cursor-move focus:outline focus:outline-2 focus:outline-primary-600"
        onPointerDown={e=>{if(locked||panDrag.current||drag.current||e.button!==0)return;const start=coordinate(e.clientX,e.clientY);if(!start)return;e.currentTarget.setPointerCapture(e.pointerId);panDrag.current={pointerId:e.pointerId,start,before:points.map(p=>[...p] as ZonePoint)}}}
        onPointerMove={e=>{const d=panDrag.current;if(locked||!d||d.pointerId!==e.pointerId)return;const pos=coordinate(e.clientX,e.clientY);if(pos){setPoints(translated(d.before,pos[0]-d.start[0],pos[1]-d.start[1]));setSaved(false)}}}
        onPointerUp={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){const before=panDrag.current.before;setPast(p=>[...p.slice(-99),{points:before,finished}]);setFuture([]);panDrag.current=null}}}
        onPointerCancel={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){setPoints(panDrag.current.before);panDrag.current=null}}}
        onLostPointerCapture={e=>{if(panDrag.current?.pointerId===e.pointerId&&panDrag.current){setPoints(panDrag.current.before);panDrag.current=null}}}
        onKeyDown={e=>{if(locked||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const step=e.shiftKey?.01:.001;edit(translated(points,e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0))}}/>}
    </FitFrame>
    <div role="toolbar" aria-label="热区绘制工具" className="flex shrink-0 flex-wrap items-center gap-2">
      {panoramaAllowed&&<button type="button" className={button} aria-pressed={panorama} disabled={locked} onClick={()=>{setPanorama(!panorama);setPan(false)}}><Globe size={16} aria-hidden="true"/>{panorama?'切回平面画面':'360° 编辑'}</button>}
      <button type="button" className={button} aria-pressed={mode==='polygon'} disabled={locked||!!points.length} onClick={()=>setMode('polygon')}><Pentagon size={16} aria-hidden="true"/>多边形</button>
      <button type="button" className={button} aria-pressed={mode==='rectangle'} disabled={locked||!!points.length} onClick={()=>setMode('rectangle')}><RectangleHorizontal size={16} aria-hidden="true"/>矩形（点击两个对角）</button>
      <button type="button" className={button} disabled={locked||!past.length} onClick={()=>{const previous=past[past.length-1];if(!previous)return;setFuture([{points,finished},...future]);setPoints(previous.points);setPast(past.slice(0,-1));setFinished(previous.finished);setSelectedVertex(null);setPan(false);setSaved(false)}}><Undo2 size={16} aria-hidden="true"/>撤销</button>
      <button type="button" className={button} disabled={locked||!future.length} onClick={()=>{const next=future[0];if(!next)return;setPast([...past,{points,finished}]);setPoints(next.points);setFuture(future.slice(1));setFinished(next.finished);setSelectedVertex(null);setPan(false);setSaved(false)}}><Redo2 size={16} aria-hidden="true"/>重做</button>
      <button type="button" className={button} disabled={locked||!points.length} onClick={()=>{edit([]);setPan(false);setFinished(false);setCleared(true)}}><Trash2 size={16} aria-hidden="true"/>清空顶点</button>
      <button type="button" className={button} aria-pressed={pan} disabled={locked||!finished||!!problem} onClick={()=>{setPan(!pan);setSelectedVertex(null)}}><Move size={16} aria-hidden="true"/>平移区域</button>
      <button type="button" className={button} disabled={locked||pan||selectedVertex===null||points.length<=3} onClick={()=>{
        edit(points.filter((_,index)=>index!==selectedVertex));setSelectedVertex(null)
      }}><Trash2 size={16} aria-hidden="true"/>删除选中顶点</button>
      <span className="mx-1 h-6 w-px bg-line" aria-hidden="true"/>
      <button type="button" className={button} disabled={saving} onClick={()=>changed&&!saved?setConfirmCancel(true):onCancel()}><ArrowLeft size={16} aria-hidden="true"/>{draftOnly?'返回布防':'取消'}</button>
      <button type="button" className={button} disabled={locked||!!problem||finished||points.length<3} onClick={()=>setFinished(true)}><Check size={16} aria-hidden="true"/>完成绘制</button>
      <button type="button" className="btn-primary" disabled={locked||!finished||!!problem||!name.trim()} onClick={()=>void save()}><Save size={16} aria-hidden="true"/>{saving?'正在保存…':draftOnly?'加入区域草稿':'保存区域'}</button>
    </div>
    <div className="shrink-0 space-y-1 text-xs text-ink-faint">
      <p><span className="mr-2 text-primary">蓝色圆点为顶点</span><span className="mr-2 text-amber-800">暖色“边 N”为边编号</span>。{finished?'拖动顶点调整形状；点边上的 + 插入顶点；选中顶点后可删除；开启“平移区域”后拖动整体移动。键盘：方向键微调，Shift 加大步长。':mode==='rectangle'?'在画面上依次点击两个对角。':'在画面上依次点击顶点，至少 3 个，然后点“完成绘制”。'}</p>
      <div className="min-h-5" aria-live="polite">
      {stale&&<p role="alert" className="text-sm text-danger">来源画面已改变，请保留草稿并重新打开编辑器确认区域。</p>}
      {imageError&&<p role="alert" className="text-sm text-danger">{imageError}</p>}{points.length>0&&problem&&<p role="status" className="text-sm text-warning">{problem}</p>}{error&&<p role="alert" className="text-sm text-danger">{error}</p>}
      {saved&&<p role="status" className="text-sm">{draftOnly?'已加入布防草稿，尚未应用。':'区域已保存；尚未创建或启用监控规则。'}</p>}
      </div>
    </div>
    {confirmCancel&&<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"><div role="alert" className="w-full max-w-md space-y-3 rounded-panel bg-surface p-5 shadow-modal">
      <p className="text-base font-semibold">存在未保存的区域修改。</p><p className="text-sm text-ink-subtle">放弃后回到上一层，其他布防修改不受影响。</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setConfirmCancel(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onCancel}>放弃修改并退出</button></div>
    </div></div>}
  </section>
}
