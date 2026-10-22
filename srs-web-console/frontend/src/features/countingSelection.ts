import type {BindingDirection,CounterMethod} from '@/api/flowService'
/** Counting line being set on the canvas; incomplete while the user is still tapping edges. */
export interface CountingPick {method:CounterMethod;edge?:string;inSide:'inward'|'outward';from?:string;to?:string;entry:string[];exit:string[];target?:'from'|'to'|'entry'|'exit'}
export function pickFrom(method:CounterMethod,d?:BindingDirection):CountingPick{
 const base:CountingPick={method,inSide:'inward',entry:[],exit:[]}
 if(!d)return base
 if(d.kind==='line')return {...base,edge:d.edge,inSide:d.in_side}
 if(d.kind==='gates')return {...base,from:d.from,to:d.to}
 if(d.kind==='edges')return {...base,entry:[...d.entry],exit:[...d.exit]}
 return base
}
/** Tapping selects an edge. Direction changes use explicit tools, never click count. */
export function tapEdge(pick:CountingPick,id:string):CountingPick{
 if(pick.method==='line')return {...pick,edge:id}
 if(pick.method==='gates'){
  const target=pick.target??(!pick.from?'from':'to')
  if(target==='from')return {...pick,from:id,to:pick.to===id?undefined:pick.to,target:'to'}
  return id===pick.from?pick:{...pick,to:id,target:'to'}
 }
 const target=pick.target==='exit'?'exit':'entry',other=target==='entry'?'exit':'entry'
 return {...pick,[target]:pick[target].includes(id)?pick[target].filter(e=>e!==id):[...pick[target],id],[other]:pick[other].filter(e=>e!==id)}
}
export function pickDirection(pick:CountingPick):BindingDirection|null{
 if(pick.method==='line')return pick.edge?{kind:'line',edge:pick.edge,in_side:pick.inSide}:null
 if(pick.method==='gates')return pick.from&&pick.to?{kind:'gates',from:pick.from,to:pick.to}:null
 return pick.entry.length&&pick.exit.length?{kind:'edges',entry:pick.entry,exit:pick.exit}:null
}
