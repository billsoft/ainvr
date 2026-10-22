interface Sample {bbox:{x:number;y:number;w:number;h:number};event_eligible:boolean;observation:string;source_pts_ns:string}
// Never draw a solid bridge over an ineligible or malformed observation.
export function reviewTrajectorySegments(trace:Sample[],until:string,anchor='bottom_center'){
 const segments:string[]=[];let points:string[]=[];
 const flush=()=>{if(points.length>1)segments.push(points.join(' '));points=[]}
 if(!/^\d+$/.test(until))return segments
 let previous:bigint|null=null;
 for(const t of trace){
  if(!/^\d+$/.test(t.source_pts_ns)){flush();previous=null;continue}
  const at=BigInt(t.source_pts_ns);if(at>BigInt(until)){flush();continue}
  const b=t.bbox;
  if(!t.event_eligible||t.observation!=='detected'||!b||![b.x,b.y,b.w,b.h].every(Number.isFinite)){flush();previous=null;continue}
  if(previous!==null&&at<=previous)flush();previous=at;
  points.push(`${b.x+b.w/2},${b.y+b.h*(anchor==='center'?.5:1)}`)
 }
 flush();return segments
}
