import {digest} from './domain.mjs';
// Checkpoint state is prepared together with facts. A segment is a proven
// continuous span of consumed input for one counting binding and rule version.
// Writes are throttled: a new segment is written at once, an existing one is
// extended at most every five seconds (the tail may lag by that much).
const WRITE_EVERY_MS=5000;
export function coverageStep(cp,frame,rules,interrupted){
  const previous=cp.flow_coverage??{},next={},segments=[];
  for(const r of rules){
    if(r.behavior!=='region_traverse'||!r.counter_id)continue;
    const identity={assignment_id:r.assignment_id,rule_version:r.version,channel_id:frame.channel_id,input_stream_id:frame.input_stream_id};
    const key=digest(identity),at=new Date(frame.captured_at).toISOString(),old=previous[key];
    const continuous=!interrupted&&old&&old.session===frame.stream_session_id&&old.at<at;
    const start=continuous?old.from:at,first=continuous?old.first:frame.seq;
    const written=continuous?old.written:null;
    // The second frame is written at once so even a short session has a real span.
    const due=!written||written===start||Date.parse(at)-Date.parse(written)>=WRITE_EVERY_MS;
    const segment_id=digest([key,frame.stream_session_id,first]);
    if(due)segments.push({...identity,segment_id,from:start,to:at});
    next[key]={identity,from:start,first,at,session:frame.stream_session_id,written:due?at:written};
  }
  // A binding that changed version or stopped: write the tail its throttle had not written yet.
  for(const [key,old] of Object.entries(previous))if(!next[key]&&old.identity&&old.written!==old.at)
    segments.push({...old.identity,segment_id:digest([key,old.session,old.first]),from:old.from,to:old.at});
  cp.flow_coverage=next;return segments;
}
