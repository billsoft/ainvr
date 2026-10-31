import { useState } from 'react'
import { weekdayNames, type WeekCell } from './analyticsSource'
export function WeekHourPanel({grid,compact=false,onExpand}:{grid:WeekCell[][];compact?:boolean;onExpand?:()=>void}) {
  const small=compact
  const [active,setActive]=useState<[number,number]|null>(null)
  const max=Math.max(1,...grid.flat().map(c=>c.value??0)),cell=active?grid[active[0]]?.[active[1]]:null
  return <section className={`ui-panel flex min-w-0 flex-col lg:min-h-0 ${small?'min-h-[10rem] gap-1.5 p-2.5':'min-h-[16rem] gap-2 p-3'}`} aria-label="星期与小时规律">
    <header className="flex shrink-0 flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-ink" title="最近四个完整自然周，使用覆盖完整的时段计算">{small?'近 4 周规律':'近 4 周：一周里什么时候忙'}</h2>{small&&onExpand&&<button type="button" className="btn-secondary ml-auto !min-h-7 !px-2 !py-1 text-[11px] [@media(pointer:coarse)]:!min-h-11" onClick={onExpand}>查看完整规律</button>}<p aria-live="polite" className={small?'sr-only':'ml-auto text-xs text-ink-subtle'}>{active?`${weekdayNames[active[0]]} ${active[1]}时：${cell?.value===null?'无有效样本':(cell?.value??0).toFixed(1)+' 次'} · ${cell?.samples??0}/4 天`:'点格子查看读数'}</p></header>
    <div className="min-h-0 flex-1 overflow-auto"><div role="group" aria-label="星期与小时分布" className={`grid h-full min-w-0 gap-[2px] ${small?'min-h-24':'min-h-40 lg:min-h-0'}`} style={{gridTemplateColumns:'auto repeat(24,minmax(0,1fr))',gridTemplateRows:small?'10px repeat(7,minmax(10px,1fr))':'auto repeat(7,minmax(0,1fr))'}}>
      <span/>{Array.from({length:24},(_,h)=><span key={h} className="text-center text-[10px] leading-none text-ink-faint">{h%3===0?h:''}</span>)}
      {grid.map((row,d)=><div key={d} className="contents"><span className={`min-h-0 pr-1 leading-none text-ink-subtle ${small?'text-[10px]':'text-xs'}`}>{weekdayNames[d]}</span>{row.map((v,h)=>small?<span key={h} aria-hidden="true" className="block rounded-[3px]" style={{background:v.value===null?'#f1f5f9':`rgba(22,119,255,${(.1+.9*v.value/max).toFixed(3)})`,border:v.value!==null&&v.samples<4?'1px dashed #94a3b8':undefined}}/>:<button type="button" key={h} aria-label={`${weekdayNames[d]} ${h}时，${v.value===null?'无有效样本':v.value.toFixed(1)+' 次'}，${v.samples}天`} onClick={()=>setActive([d,h])} className={`w-full rounded-[3px] transition-shadow hover:ring-1 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary ${active?.[0]===d&&active[1]===h?'ring-2 ring-primary':''}`} style={{background:v.value===null?'#f1f5f9':`rgba(22,119,255,${(.1+.9*v.value/max).toFixed(3)})`,border:v.value!==null&&v.samples<4?'1px dashed #94a3b8':undefined}}/>)}</div>)}
    </div></div><p className="shrink-0 text-[11px] text-ink-faint">{small?'完整时段平均次数；灰色未知，虚线不足 4 天。':'浏览器时区；覆盖完整时段的平均已记录次数。灰色为未知，虚线表示不足 4 天；重复小时合并。'}</p>
  </section>
}
