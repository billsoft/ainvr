import { useEffect, useRef, useState } from 'react'
import type { Bucket, Slot } from './analyticsSource'
export function useElementSize<T extends HTMLElement>(fallback = { w: 640, h: 200 }) {
  const ref=useRef<T>(null),[size,setSize]=useState(fallback)
  useEffect(()=>{const el=ref.current;if(!el||typeof ResizeObserver==='undefined')return;const o=new ResizeObserver(([entry])=>{const b=entry?.contentRect;if(b&&b.width>0&&b.height>0)setSize({w:Math.round(b.width),h:Math.round(b.height)})});o.observe(el);return()=>o.disconnect()},[])
  return [ref,size] as const
}
export interface TrendSeries {name:string;color:string;values:(number|null)[]}
/** `reference` is the comparison period drawn as a dashed line over the bars, slot for slot. */
interface Props {series:TrendSeries[];reference?:TrendSeries|null;slots:Slot[];bucket:Bucket;label:string;complete?:boolean[];onSelect?:(index:number|null)=>void}
const labelOf=(s:Slot,b:Bucket)=>{const d=new Date(s.from);return `${d.getMonth()+1}/${d.getDate()}${b==='hour'?` ${d.getHours()}时`:''}`}
export function TrendChart({series,reference,slots,bucket,label,complete,onSelect}:Props) {
  const [active,setActive]=useState<number|null>(null),[box,{w,h}]=useElementSize<HTMLDivElement>()
  const all=[...series,...(reference?[reference]:[])]
  const max=Math.max(1,...all.flatMap(s=>s.values.map(v=>v??0))),left=34,bottom=22,pad=6,plotW=Math.max(40,w-left-pad),plotH=Math.max(30,h-bottom-pad),width=plotW/Math.max(1,slots.length),bar=Math.max(1,Math.min(18,(width-3)/Math.max(1,series.length))),every=Math.max(1,Math.ceil(slots.length/Math.max(2,Math.floor(plotW/44))))
  const shown=active===null?null:slots[active]
  const pick=(i:number)=>{setActive(i);onSelect?.(i)}
  const y=(n:number)=>pad+plotH-n/max*plotH
  // Gaps in the reference stay gaps: an unknown slot is never drawn as zero.
  const refPath=reference?reference.values.map((v,i)=>v===null||v===undefined?null:`${left+i*width+width/2},${y(v)}`).reduce<string[][]>((runs,p)=>{if(p===null){runs.push([])}else runs[runs.length-1]!.push(p);return runs},[[]]).filter(r=>r.length):[]
  return <figure aria-label={label} className="flex min-h-[12rem] flex-1 flex-col gap-1 [@container(min-width:44rem)]:min-h-0">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
      {series.map(s=><span key={s.name} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{background:s.color}}/>{s.name}</span>)}
      {reference&&<span className="flex items-center gap-1"><svg width="14" height="4" aria-hidden="true"><line x1="0" x2="14" y1="2" y2="2" stroke={reference.color} strokeWidth="1.5" strokeDasharray="3 2"/></svg>{reference.name}</span>}
      {complete?.some(c=>!c)&&<span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-slate-400/25"/>覆盖不足或未知</span>}
      <span className="ml-auto min-h-4 text-ink" aria-live="polite">{shown?`${labelOf(shown,bucket)}：${all.map(s=>`${s.name} ${s.values[active!]??'未知'}`).join('，')}${complete?.[active!]===false?' · 覆盖不足或未知':''}`:onSelect?'点时段查看通行记录':'点时段查看读数'}</span>
    </div>
    <div ref={box} className="relative min-h-[8rem] flex-1 [@container(min-width:44rem)]:min-h-0"><svg viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 h-full w-full" role="group" aria-label={label}>
      {[0,.25,.5,.75,1].map(t=><g key={t} aria-hidden="true"><line x1={left} x2={w-pad} y1={pad+plotH*(1-t)} y2={pad+plotH*(1-t)} stroke="currentColor" className="text-line"/><text x={left-5} y={pad+plotH*(1-t)+4} textAnchor="end" fontSize="10" className="fill-ink-faint">{Math.round(max*t)}</text></g>)}
      {slots.map((s,i)=>{const x=left+i*width,start=x+(width-bar*series.length)/2;return <g key={s.from} role="button" tabIndex={0} aria-label={`${labelOf(s,bucket)}：${series.map(v=>`${v.name} ${v.values[i]??'未知'}`).join('，')}`} className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:fill-primary/10" onClick={()=>pick(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(i)}}}>
        <rect x={x} y={pad} width={width} height={plotH} fill={active===i?'rgba(22,119,255,.08)':'transparent'}/>
        {complete?.[i]===false&&<rect x={x} y={pad} width={width} height={plotH} fill="rgba(148,163,184,.13)"/>}
        {series.map((v,j)=>{const n=v.values[i];if(n===null||n===undefined)return null;const bh=n/max*plotH;return <rect key={v.name} x={start+j*bar} y={pad+plotH-bh} width={Math.max(1,bar-1)} height={Math.max(n?1.5:0,bh)} fill={v.color} opacity={complete?.[i]===false?.45:1}/>})}
        {i%every===0&&<text x={x+width/2} y={h-5} textAnchor="middle" fontSize="10" className="fill-ink-faint">{bucket==='hour'?new Date(s.from).getHours()+'时':labelOf(s,bucket)}</text>}</g>})}
      {reference&&refPath.map((run,k)=><polyline key={k} aria-hidden="true" points={run.join(' ')} fill="none" stroke={reference.color} strokeWidth="1.5" strokeDasharray="4 3" pointerEvents="none"/>)}
    </svg></div>
  </figure>
}
