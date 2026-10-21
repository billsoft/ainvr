import {unwrapErp} from './erpGeometry'
export type ZonePoint = [number, number]
const cross = (a: ZonePoint,b: ZonePoint,c: ZonePoint) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
const on = (a: ZonePoint,b: ZonePoint,p: ZonePoint) => Math.abs(cross(a,b,p))<1e-10 && p[0]>=Math.min(a[0],b[0])-1e-10 && p[0]<=Math.max(a[0],b[0])+1e-10 && p[1]>=Math.min(a[1],b[1])-1e-10 && p[1]<=Math.max(a[1],b[1])+1e-10
export function zoneGeometryError(points: ZonePoint[],erpWrap=false): string {
  if(points.length<3||points.length>32)return '区域需要 3～32 个顶点'
  if(points.some(p=>p.length!==2||p.some(x=>!Number.isFinite(x)||x<0||x>1)))return '顶点必须位于原始画面内'
  if(erpWrap){try{points=unwrapErp(points)}catch(e){return e instanceof Error?e.message:'全景区域无效'}}
  let area=0
  for(let i=0;i<points.length;i++){
    const a=points[i]!,b=points[(i+1)%points.length]!
    if(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-8)return '相邻顶点不能重合'
    area+=a[0]*b[1]-b[0]*a[1]
    for(let j=i+1;j<points.length;j++){
      if(j===i+1||(i===0&&j===points.length-1))continue
      const c=points[j]!,d=points[(j+1)%points.length]!
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))return '区域边界不能交叉或重叠'
    }
  }
  return Math.abs(area)<1e-8?'区域面积不能为零':''
}
