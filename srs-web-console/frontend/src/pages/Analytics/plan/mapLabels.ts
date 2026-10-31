import type { Placement } from './planModel'

export interface MapAnnotation { summary: string; detail: string }
export interface LabelBox { key: string; x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; compact: boolean; ordinal: number }

/** Screen-space labels share the canvas transform; selection wins when labels compete. */
export function layoutMapLabels(placements: Record<string, Placement>, keys: string[], viewport: {x:number;y:number;w:number;h:number}, width: number, height: number, selected: string | null): LabelBox[] {
  if (width < 24 || height < 24) return []
  const scale = Math.max(.005, Math.min(width / viewport.w, height / viewport.h))
  const ox = (width - viewport.w * scale) / 2, oy = (height - viewport.h * scale) / 2
  const result: LabelBox[] = []
  const intersects = (a: LabelBox, b: LabelBox) => a.x < b.x+b.w+4 && a.x+a.w+4 > b.x && a.y < b.y+b.h+4 && a.y+a.h+4 > b.y
  const ordered = keys.filter(key => placements[key]).map((key,i)=>({key,ordinal:i+1})).sort((a,b)=>Number(b.key===selected)-Number(a.key===selected))
  for (const {key,ordinal} of ordered) {
    const p=placements[key]!, left=ox+(p.x-viewport.x)*scale, top=oy+(p.y-viewport.y)*scale
    const anchorX=left+p.w*scale/2, anchorY=top+p.h*scale/2
    const w=Math.min(216,width-8), h=Math.min(48,height-8)
    const candidates=[[anchorX-w/2,top-h-6],[anchorX-w/2,top+p.h*scale+6],[left+p.w*scale+6,anchorY-h/2],[left-w-6,anchorY-h/2],[anchorX-w/2,top+4]]
    let box:LabelBox|undefined
    for (const [x=0,y=0] of candidates) {
      const candidate={key,x:Math.max(4,Math.min(width-w-4,x)),y:Math.max(4,Math.min(height-h-4,y)),w,h,anchorX,anchorY,compact:false,ordinal}
      if (!result.some(other=>intersects(candidate,other))) {box=candidate;break}
    }
    // Dense areas keep a selectable marker instead of stacking unreadable cards.
    if (!box) {
      const points: {x:number;y:number}[]=[]
      for(let y=0;y<=height-24;y+=28) for(let x=0;x<=width-24;x+=28) points.push({x,y})
      points.sort((a,b)=>Math.hypot(a.x+12-anchorX,a.y+12-anchorY)-Math.hypot(b.x+12-anchorX,b.y+12-anchorY))
      for(const point of points) {
        const candidate={key,...point,w:24,h:24,anchorX,anchorY,compact:true,ordinal}
        if(!result.some(other=>intersects(candidate,other))) {box=candidate;break}
      }
      if(!box) box={key,x:Math.max(0,Math.min(width-24,anchorX-12)),y:Math.max(0,Math.min(height-24,anchorY-12)),w:24,h:24,anchorX,anchorY,compact:true,ordinal}
    }
    result.push(box)
  }
  return result
}
