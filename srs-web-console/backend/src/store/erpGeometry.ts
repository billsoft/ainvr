// ERP cylindrical geometry. Keep the TS/frontend/backend variants algorithmically identical.
export function unwrapErp(points:[number,number][]):[number,number][] {
  if (!Array.isArray(points) || !points.length) return [];
  const out:[number,number][] = [[...points[0]!]];
  for (let i=1;i<points.length;i++) {
    let dx=points[i]![0]-points[i-1]![0];
    if (Math.abs(Math.abs(dx)-.5)<1e-10) throw Error('Ambiguous half-sphere edge');
    dx-=Math.round(dx);
    out.push([out[i-1]![0]+dx,points[i]![1]]);
  }
  let close=points[0]![0]-points[points.length-1]![0];
  if (Math.abs(Math.abs(close)-.5)<1e-10) throw Error('Ambiguous half-sphere edge');
  close-=Math.round(close);
  if (Math.abs(out[out.length-1]![0]+close-out[0]![0])>1e-8) throw Error('Region winds around a pole; divide it into smaller regions');
  const xs=out.map(p=>p[0]);
  if (Math.max(...xs)-Math.min(...xs)>=.5-1e-8) throw Error('Region must span less than half a revolution');
  return out;
}
export function liftErp(point:[number,number],polygon:[number,number][]):[number,number] {
  const xs=polygon.map(p=>p[0]),center=(Math.min(...xs)+Math.max(...xs))/2;
  return [point[0]+Math.round(center-point[0]),point[1]];
}
