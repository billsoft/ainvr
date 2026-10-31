import { useEffect, useRef, useState } from 'react'
import type { Bucket, Slot } from './analyticsSource'
export function useElementSize<T extends HTMLElement>(fallback = { w: 640, h: 200 }) {
  const ref=useRef<T>(null),[size,setSize]=useState(fallback)
  useEffect(()=>{const el=ref.current;if(!el||typeof ResizeObserver==='undefined')return;const o=new ResizeObserver(([entry])=>{const b=entry?.contentRect;if(b&&b.width>0&&b.height>0)setSize({w:Math.round(b.width),h:Math.round(b.height)})});o.observe(el);return()=>o.disconnect()},[])
  return [ref,size] as const
}
export interface TrendSeries {name:string;color:string;values:(number|null)[]}
interface Props {series:TrendSeries[];slots:Slot[];bucket:Bucket;label:string;complete?:boolean[];onSelect?:(index:number|null)=>void}
const labelOf=(s:Slot,b:Bucket)=>{const d=new Date(s.from);return `${d.getMonth()+1}/${d.getDate()}${b==='hour'?` ${d.getHours()}时`:''}`}
export function TrendChart({series,slots,bucket,label,complete,onSelect}:Props) {
  const [active,setActive]=useState<number|null>(null),[box,{w,h}]=useElementSize<HTMLDivElement>()
  const max=Math.max(1,...series.flatMap(s=>s.values.map(v=>v??0))),left=34,bottom=22,pad=6,plotW=Math.max(40,w-left-pad),plotH=Math.max(30,h-bottom-pad),width=plotW/Math.max(1,slots.length),bar=Math.max(1,Math.min(18,(width-3)/Math.max(1,series.length))),every=Math.max(1,Math.ceil(slots.length/Math.max(2,Math.floor(plotW/44))))
  const shown=active===null?null:slots[active]
  return <figure aria-label={label} className="flex min-h-[12rem] flex-1 flex-col gap-1 lg:min-h-0">
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">{series.map(s=><span key={s.name} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{background:s.color}}/>{s.name}</span>)}<span className="ml-auto min-h-4 text-ink" aria-live="polite">{shown?`${labelOf(shown,bucket)}：${series.map(s=>`${s.name} ${s.values[active!]??'未知'}`).join('，')}${complete?.[active!]===false?' · 覆盖不足或未知':''}`:'点时段查看读数'}</span></div>
    <div ref={box} className="relative min-h-[8rem] flex-1 lg:min-h-0"><svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 h-full w-full" role="img" aria-label={label}>
      {[0,.25,.5,.75,1].map(t=><g key={t}><line x1={left} x2={w-pad} y1={pad+plotH*(1-t)} y2={pad+plotH*(1-t)} stroke="currentColor" className="text-line"/><text x={left-5} y={pad+plotH*(1-t)+4} textAnchor="end" fontSize="10" className="fill-ink-faint">{Math.round(max*t)}</text></g>)}
      {slots.map((s,i)=>{const x=left+i*width,start=x+(width-bar*series.length)/2;return <g key={s.from} className="cursor-pointer" onClick={()=>{setActive(i);onSelect?.(i)}}>
        <rect x={x} y={pad} width={width} height={plotH} fill={active===i?'rgba(22,119,255,.08)':'transparent'}/>
        {complete?.[i]===false&&<rect x={x} y={pad} width={width} height={plotH} fill="rgba(148,163,184,.13)"/>}
        {series.map((v,j)=>{const n=v.values[i];if(n===null||n===undefined)return null;const bh=n/max*plotH;return <rect key={v.name} x={start+j*bar} y={pad+plotH-bh} width={Math.max(1,bar-1)} height={Math.max(n?1.5:0,bh)} fill={v.color} opacity={complete?.[i]===false?.45:1}/>})}
        {i%every===0&&<text x={x+width/2} y={h-5} textAnchor="middle" fontSize="10" className="fill-ink-faint">{bucket==='hour'?new Date(s.from).getHours()+'时':labelOf(s,bucket)}</text>}</g>})}
    </svg></div><div className="max-h-12 overflow-auto text-xs text-ink-subtle"><label>选择时段 <select aria-label="趋势时段" value={active??''} onChange={e=>{const i=e.target.value===''?null:Number(e.target.value);setActive(i);onSelect?.(i)}} className="form-input !w-auto !py-1"><option value="">请选择</option>{slots.map((s,i)=><option value={i} key={s.from}>{labelOf(s,bucket)}</option>)}</select></label> 灰底表示覆盖不足或未知</div>
  </figure>
}
