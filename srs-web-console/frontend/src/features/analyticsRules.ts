import type { AiAnalyticsRule } from '@/types/aiChannel'
type Point = [number, number]
const cross = (a: Point, b: Point, c: Point) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
const on = (a: Point,b: Point,p: Point) => Math.abs(cross(a,b,p))<1e-10 && p[0]>=Math.min(a[0],b[0]) && p[0]<=Math.max(a[0],b[0]) && p[1]>=Math.min(a[1],b[1]) && p[1]<=Math.max(a[1],b[1])
const intersects = (a:Point,b:Point,c:Point,d:Point) => cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0 || on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b)
export function ruleError(rule: AiAnalyticsRule): string | null {
  const p=rule.points
  if (!rule.id.trim() || rule.id.length>128) return '规则名称不能为空，且不能超过128个字符'
  if(p.some(v=>v.some(n=>!Number.isFinite(n)||n<0||n>1))) return '请在画面范围内标点'
  if(rule.type==='line') {
    if(p.length!==2) return '越线规则需要两个端点'
    if(p[0]![0]===p[1]![0]&&p[0]![1]===p[1]![1]) return '两个端点不能重合'
  } else {
    if(p.length<3||p.length>32) return '区域需要3至32个顶点'
    let area=0
    for(let i=0;i<p.length;i++){
      const a=p[i]!,b=p[(i+1)%p.length]!
      if(a[0]===b[0]&&a[1]===b[1]) return '相邻顶点不能重合'
      area+=a[0]*b[1]-b[0]*a[1]
      for(let j=i+1;j<p.length;j++){
        if(j===i+1||i===0&&j===p.length-1) continue
        if(intersects(a,b,p[j]!,p[(j+1)%p.length]!)) return '区域边界不能交叉'
      }
    }
    if(Math.abs(area)<1e-10) return '区域必须有实际面积'
  }
  if(rule.type==='dwell'&&(!Number.isFinite(rule.dwell_seconds)||rule.dwell_seconds!<=0||rule.dwell_seconds!>86400)) return '停留时间需为1至86400秒'
  return null
}
