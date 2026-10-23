// Observed outside -> inside -> outside only. Ambiguous polygon crossings reset.
import {inside,boundaryDistance} from './geometry.mjs';
const eps=1e-9;
function hits(poly,a,b){
  const result=[],v=[b[0]-a[0],b[1]-a[1]];
  for(let i=0;i<poly.length;i++){
    const c=poly[i],d=poly[(i+1)%poly.length],w=[d[0]-c[0],d[1]-c[1]],q=[c[0]-a[0],c[1]-a[1]];
    const den=v[0]*w[1]-v[1]*w[0];if(Math.abs(den)<eps)continue;
    const t=(q[0]*w[1]-q[1]*w[0])/den,u=(q[0]*v[1]-q[1]*v[0])/den;
    if(t>=-eps&&t<=1+eps&&u>=-eps&&u<=1+eps){
      const point=[a[0]+t*v[0],a[1]+t*v[1]];
      const duplicate=result.find(h=>Math.hypot(h.point[0]-point[0],h.point[1]-point[1])<eps);
      if(duplicate)duplicate.ambiguous=true;else result.push({point,edge:i,t});
    }
  }return result.sort((x,y)=>x.t-y.t);
}
// Shared conservative continuity check: endpoints alone cannot prove an in-zone path.
export function crossesBoundary(poly,a,b){return hits(poly,a,b).length>0;}
function center(poly){
  let area=0,x=0,y=0;
  for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],c=a[0]*b[1]-b[0]*a[1];area+=c;x+=(a[0]+b[0])*c;y+=(a[1]+b[1])*c;}
  return [x/(3*area),y/(3*area)];
}
export function heading(a,b,width,height){
  const dx=(b[0]-a[0])*width,dy=(b[1]-a[1])*height;
  if(Math.hypot(dx,dy)<eps)return null;
  const degrees=(Math.atan2(dx,-dy)*180/Math.PI+360)%360;
  return degrees<eps||360-degrees<eps?0:degrees;
}
// Screen coordinates: 0 degrees is up, clockwise; never geographic north.
export function regionDirection(rule,frame,point,previous=null,{entry=false}={}){
  const {width,height}=frame.source;
  const crossings=entry&&previous?hits(rule.points,previous,point):[];
  let boundary=null,reference='nearest_boundary',edge=null;
  if(entry){
    reference='observed_boundary_crossing';
    if(crossings.length===1&&!crossings[0].ambiguous){boundary=crossings[0].point;edge=crossings[0].edge;}
  }else{
    let best=Infinity;
    for(let i=0;i<rule.points.length;i++){
      const a=rule.points[i],b=rule.points[(i+1)%rule.points.length];
      const dx=(b[0]-a[0])*width,dy=(b[1]-a[1])*height;
      const t=Math.max(0,Math.min(1,((point[0]-a[0])*width*dx+(point[1]-a[1])*height*dy)/(dx*dx+dy*dy)));
      const q=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];
      const distance=Math.hypot((point[0]-q[0])*width,(point[1]-q[1])*height);
      if(distance<best){best=distance;boundary=q;edge=i;}
    }
  }
  const side=boundary?heading(center(rule.points),boundary,width,height):null;
  return {coordinate_reference:'image_up_clockwise',reference,boundary_point:boundary,
    region_side_deg:side,entry_side_deg:entry?side:null,
    // Zone edge index: the crossed edge on entry, otherwise the nearest edge.
    ...(entry?{entry_edge:edge}:{nearest_edge:edge}),
    motion_heading_deg:previous?heading(previous,point,width,height):null};
}
function result(rule,frame,entry,exit,t,extra={}){
  const c=center(rule.points),{width,height}=frame.source;
  const gaps=t.gaps??0,gap_ms=t.gap_ms??0;delete t.gaps;delete t.gap_ms;
  return {entry,exit,duration_ms:Number(BigInt(exit.pts)-BigInt(entry.pts))/1e6,
    direction:{entry_side_deg:heading(c,entry.boundary,width,height),exit_side_deg:heading(c,exit.boundary,width,height),
      motion_heading_deg:heading(entry.point,exit.point,width,height),...extra},
    method:rule.passage?.kind??'zone',observation_gaps:gaps,gap_ms,
    same_boundary_edge:entry.edge===exit.edge,trajectory_complete:true};
}
function lineStep(rule,frame,point,state){
  const t=state.traversal??={previous:null,entry:null},edge=rule.passage.edges[0],a=rule.points[edge],b=rule.points[(edge+1)%rule.points.length];
  const area=rule.points.reduce((s,p,i)=>{const q=rule.points[(i+1)%rule.points.length];return s+p[0]*q[1]-q[0]*p[1];},0);
  const signed=((b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]))*Math.sign(area)/Math.hypot(b[0]-a[0],b[1]-a[1]);
  if(Math.abs(signed)<rule.hysteresis)return null;
  const current={point,side:Math.sign(signed),pts:frame.source_pts_ns,at:frame.captured_at,seq:frame.seq,frame_id:frame.frame_id};
  const prev=t.previous;t.previous=current;
  if(!prev||prev.side===current.side)return null;
  const h=hits([a,b],prev.point,point).find(h=>h.edge===0);
  // hits([a,b]) sees the reverse edge too. Finite edge endpoints are ambiguous.
  if(!h||Math.hypot(h.point[0]-a[0],h.point[1]-a[1])<eps||Math.hypot(h.point[0]-b[0],h.point[1]-b[1])<eps)return null;
  return result(rule,frame,{...prev,boundary:h.point,edge},{...current,boundary:h.point,edge},t,{line_direction:current.side>0?'inward':'outward'});
}
export function traversalStep(rule,frame,point,state){
  const last=state.traversal?.previous;
  if(last&&last.point[0]===point[0]&&last.point[1]===point[1]){
    state.traversal.previous={...last,pts:frame.source_pts_ns,at:frame.captured_at,seq:frame.seq,frame_id:frame.frame_id};
    return null; // Stationary real observation cannot cross a boundary.
  }
  if(rule.passage?.kind==='line')return lineStep(rule,frame,point,state);
  const t=state.traversal??={previous:null,entry:null};
  if(boundaryDistance(rule.points,point)<rule.hysteresis)return null;
  const current={point,inside:inside(rule.points,point),pts:frame.source_pts_ns,at:frame.captured_at,seq:frame.seq,frame_id:frame.frame_id};
  const prev=t.previous;t.previous=current;
  if(!prev)return null;
  if(prev.inside===current.inside){
    // A concave shortcut may leave and re-enter between samples; never assume continuity.
    if(current.inside&&crossesBoundary(rule.points,prev.point,point)){t.entry=null;state.traversal_issue='ambiguous_concave_crossing';}
    if(!current.inside&&rule.passage?.kind==='gates'){
      const h=hits(rule.points,prev.point,point),gates=rule.passage.edges;
      if(h.length===2&&h.every(h=>!h.ambiguous&&gates.includes(h.edge))&&h[0].edge!==h[1].edge)
        return result(rule,frame,{...prev,boundary:h[0].point,edge:h[0].edge},{...current,boundary:h[1].point,edge:h[1].edge},t);
    }
    return null;
  }
  const crossings=hits(rule.points,prev.point,point);
  if(crossings.length!==1||crossings[0].ambiguous){t.entry=null;state.traversal_issue='ambiguous_boundary_crossing';return null;}
  const hit=crossings[0];
  if(rule.passage?.kind==='gates'&&!rule.passage.edges.includes(hit.edge)){t.entry=null;return null;}
  if(current.inside){t.entry={...current,boundary:hit.point,edge:hit.edge};return null;}
  const entry=t.entry;t.entry=null;
  if(!entry)return null; // First observed inside does not prove entry.
  if(entry.edge===hit.edge)return null; // Stepping back out over the entry edge is not a passage.
  const elapsed=Number(BigInt(current.pts)-BigInt(entry.pts))/1e6;
  if(elapsed<rule.duration_ms)return null;
  return result(rule,frame,entry,{...current,boundary:hit.point,edge:hit.edge},t);
}
