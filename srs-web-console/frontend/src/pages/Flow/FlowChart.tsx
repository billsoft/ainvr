import {useState} from 'react'
interface Series {name:string;color:string;buckets:{from:string;occurrences:number}[]}
interface Props {series:Series[];slots:{from:string;to:string}[];bucket:'hour'|'day';label:string}
/** Grouped bars per period with a y axis; tap or hover a period to read its numbers. */
export function FlowChart({series,slots,bucket,label}:Props){
 const [active,setActive]=useState<number|null>(null)
 // A bucket may start inside its period (a zone selected mid-hour), so match by containment.
 const values=slots.map(s=>{const a=Date.parse(s.from),z=Date.parse(s.to);return series.map(x=>x.buckets.filter(b=>{const t=Date.parse(b.from);return t>=a&&t<z}).reduce((n,b)=>n+b.occurrences,0))})
 const max=Math.max(1,...values.flat()),step=niceStep(max),top=Math.ceil(max/step)*step
 const W=720,H=200,left=36,bottom=24,plotW=W-left-8,plotH=H-bottom-8,slot=plotW/Math.max(1,slots.length)
 const bar=Math.max(2,Math.min(18,(slot-4)/Math.max(1,series.length)))
 const tick=(s:{from:string})=>{const d=new Date(s.from);return bucket==='hour'?`${d.getHours()}时`:`${d.getMonth()+1}/${d.getDate()}`}
 const every=Math.ceil(slots.length/(bucket==='hour'?12:10))
 const shown=active===null?null:slots[active]
 return <figure className="space-y-2" aria-label={label}>
  <div className="flex flex-wrap items-center gap-4 text-xs text-ink-subtle">{series.map(s=><span key={s.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{background:s.color}}/>{s.name}</span>)}
   <span className="ml-auto min-h-[1rem] text-ink">{shown?`${new Date(shown.from).toLocaleString('zh-CN',bucket==='hour'?{month:'numeric',day:'numeric',hour:'numeric'}:{month:'numeric',day:'numeric'})}${bucket==='hour'?'时':''}：${series.map((s,i)=>`${s.name} ${values[active!]![i]}`).join('，')}`:'点柱子查看数值'}</span></div>
  <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" role="img" aria-label={`${label}：${series.map(s=>`${s.name}共${s.buckets.reduce((n,b)=>n+b.occurrences,0)}`).join('，')}`}>
   {Array.from({length:Math.round(top/step)+1},(_,i)=>{const v=i*step,y=8+plotH-v/top*plotH;return <g key={v}><line x1={left} x2={W-8} y1={y} y2={y} stroke="currentColor" className="text-line" strokeWidth="1"/><text x={left-6} y={y+4} textAnchor="end" fontSize="11" className="fill-ink-faint">{v}</text></g>})}
   {slots.map((s,i)=>{const x=left+i*slot,group=bar*series.length,start=x+(slot-group)/2;return <g key={s.from} onMouseEnter={()=>setActive(i)} onClick={()=>setActive(i)} className="cursor-pointer">
    <rect x={x} y={8} width={slot} height={plotH} fill={active===i?'rgba(22,119,255,.06)':'transparent'}/>
    {series.map((ser,j)=>{const v=values[i]![j]!,h=v/top*plotH;return <rect key={ser.name} x={start+j*bar} y={8+plotH-h} width={bar-1} height={Math.max(v?1.5:0,h)} rx="1.5" fill={ser.color}/>})}
    {i%every===0&&<text x={x+slot/2} y={H-6} textAnchor="middle" fontSize="11" className="fill-ink-faint">{tick(s)}</text>}
   </g>})}
  </svg>
 </figure>
}
function niceStep(max:number){const raw=max/4,p=10**Math.floor(Math.log10(raw)),n=raw/p;return Math.max(1,(n<=1?1:n<=2?2:n<=5?5:10)*p)}
/** Period starts between from and to in local time. */
export function periodSlots(from:Date,to:Date,bucket:'hour'|'day'){
 const out:{from:string;to:string}[]=[],d=new Date(from)
 if(bucket==='hour')d.setMinutes(0,0,0);else d.setHours(0,0,0,0)
 while(d<to&&out.length<800){const next=new Date(d);if(bucket==='hour')next.setHours(next.getHours()+1);else next.setDate(next.getDate()+1);out.push({from:d.toISOString(),to:next.toISOString()});d.setTime(next.getTime())}
 return out
}
