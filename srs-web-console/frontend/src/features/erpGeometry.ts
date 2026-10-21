// ERP cylindrical geometry. Keep the TS/frontend/backend variants algorithmically identical.
export function unwrapErp(points:[number,number][]):[number,number][] {
  if (!Array.isArray(points) || !points.length) return [];
  const out:[number,number][] = [[...points[0]!]];
  for (let i=1;i<points.length;i++) {
    let dx=points[i]![0]-points[i-1]![0];
    if (Math.abs(Math.abs(dx)-.5)<1e-10) throw Error('区域边跨越半个全景，方向不明确，请增加顶点');
    dx-=Math.round(dx);
    out.push([out[i-1]![0]+dx,points[i]![1]]);
  }
  let close=points[0]![0]-points[points.length-1]![0];
  if (Math.abs(Math.abs(close)-.5)<1e-10) throw Error('区域边跨越半个全景，方向不明确，请增加顶点');
  close-=Math.round(close);
  if (Math.abs(out[out.length-1]![0]+close-out[0]![0])>1e-8) throw Error('区域环绕全景极点，请拆分为较小区域');
  const xs=out.map(p=>p[0]);
  if (Math.max(...xs)-Math.min(...xs)>=.5-1e-8) throw Error('全景区域须小于半圈，请拆分为较小区域');
  return out;
}
export function liftErp(point:[number,number],polygon:[number,number][]):[number,number] {
  const xs=polygon.map(p=>p[0]),center=(Math.min(...xs)+Math.max(...xs))/2;
  return [point[0]+Math.round(center-point[0]),point[1]];
}

/** Copies are clipped by the ERP viewport; never connect across the image centre. */
export function erpDisplayPolygons(points:[number,number][],wrap=false):[number,number][][] {
 if(!wrap||points.length<2)return [points];
 let poly:[number,number][];try{poly=unwrapErp(points)}catch{return []}
 const min=Math.min(...poly.map(p=>p[0])),max=Math.max(...poly.map(p=>p[0]));
 const out:[number,number][][]=[];
 for(let k=Math.ceil(-max);k<=Math.floor(1-min);k++)out.push(poly.map(([x,y])=>[x+k,y]));
 return out;
}
