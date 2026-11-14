// The AI cache refuses a review frame when its spool (a bounded memory filesystem)
// is full; the alarm then publishes without a screenshot. Its counters live only in
// cache-status.json, so report new refusals, at most once a minute.
export class SpoolRefusalWatch {
 constructor({read,clock=()=>Date.now(),emit=record=>console.warn(JSON.stringify(record))}){this.read=read;this.clock=clock;this.emit=emit;this.checkedAt=-Infinity;this.seen=null;}
 async check(){
  const now=this.clock();if(now-this.checkedAt<60000)return;this.checkedAt=now;
  let status;try{status=JSON.parse(await this.read());}catch{return;}
  const failed=Number(status?.failed),dropped=Number(status?.dropped);
  if(!Number.isSafeInteger(failed)||!Number.isSafeInteger(dropped))return;
  const last=this.seen;this.seen={failed,dropped};
  // First sight, or the AI service restarted and its counters began again.
  if(!last||failed<last.failed||dropped<last.dropped)return;
  if(failed===last.failed&&dropped===last.dropped)return;
  try{this.emit({kind:'review_frame_spool_refused',failed:failed-last.failed,dropped:dropped-last.dropped,
   cached_bytes:status.cached_bytes??null,max_bytes:status.max_bytes??null,spool_free_bytes:status.spool_free_bytes??null,at:new Date(now).toISOString()});}catch{}
 }
}
