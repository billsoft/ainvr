// Copyright AINVR. Temporal evidence only: no boxes, points or frame trajectories.
export const MAX_DWELL_INTERVALS=128;

// Old facts/checkpoints contain one continuous interval. New visits retain
// merged intervals between adjacent eligible detections, excluding every coast.
// Invalid evidence stays unknown instead of falling back to its elapsed span.
export function observedIntervals(visit){
  const start=Date.parse(visit.started_at),end=Date.parse(visit.ended_at);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isSafeInteger(visit.observed_ms)||visit.observed_ms<0)return null;
  if(visit.observed_intervals===undefined)return end-start===visit.observed_ms?(end>start?[[start,end]]:[]):null;
  if(!Array.isArray(visit.observed_intervals)||visit.observed_intervals.length>MAX_DWELL_INTERVALS)return null;
  let previous=start,total=0;
  for(const span of visit.observed_intervals){
    if(!Array.isArray(span)||span.length!==2)return null;
    const [a,b]=span;
    if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<previous||b<=a||a<start||b>end)return null;
    total+=b-a;previous=b;
  }
  return total===visit.observed_ms?visit.observed_intervals:null;
}
