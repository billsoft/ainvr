import {makeFaceWatchlistAlarm} from './face-watchlist-candidate.mjs';

export class FaceWatchlistWorker {
 constructor(repository,{transport,clock=Date.now,intervalMs=5000,batchLimit=20,workBudgetMs=10000}={}){
  for(const [value,min,max] of [[intervalMs,1000,60000],[batchLimit,1,50],[workBudgetMs,1000,60000]])
   if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('invalid_face_worker_limits');
  Object.assign(this,{repository,transport,clock,intervalMs,batchLimit,workBudgetMs});
  this.closing=false;this.started=false;this.inFlight=null;this.timer=null;this.abort=new AbortController();this.failures=0;
  this.metrics={state:transport?'waiting':'disabled',fetched:0,persisted:0,replayed:0,acknowledged:0,invalid:0,failed:0,last_error:null,last_poll_at:null,last_ack_at:null};
 }
 async deliver(value){
  const event=makeFaceWatchlistAlarm(value),c=event.analysis_evidence.face;
  if(this.closing)return;
  // Mongo journal confirmation precedes the BFF ACK. A failed/ambiguous ACK is
  // retried from the persistent outbox; setOnInsert retains the first evidence.
  const inserted=await this.repository.insert(event,{durable:true});
  if(inserted)this.metrics.persisted++;else this.metrics.replayed++;
  const saved=await this.repository.events.findOne({alarm_id:event.alarm_id},
   {projection:{event_kind:1,'analysis_evidence.face.event_id':1},maxTimeMS:5000});
  if(saved){
   if(saved.event_kind!=='face_watchlist'||saved.analysis_evidence?.face?.event_id!==c.event_id)throw Error('face_alarm_identity_conflict');
  }else if(!await this.repository.isCleared(event))throw Error('face_alarm_write_unconfirmed');
  // Respect explicit clear-history tombstones; never revive an acknowledged or
  // deleted event merely because its upstream ACK was lost.
  if(this.closing)return;
  const ack=await this.transport.ack(c,this.abort.signal);
  if(ack?.acknowledged!==true||ack.record_id!==c.record_id||ack.event_id!==c.event_id)throw Error('face_ack_unconfirmed');
  this.metrics.acknowledged++;this.metrics.last_ack_at=new Date(this.clock()).toISOString();
 }
 async step(){
  if(this.closing||!this.transport)return false;
  const began=this.clock();let failed=false;
  this.metrics.state='polling';this.metrics.last_poll_at=new Date(began).toISOString();
  try{
   const result=await this.transport.poll(this.batchLimit,this.abort.signal);
   if(!result||!Array.isArray(result.items)||result.items.length>this.batchLimit)throw Error('invalid_face_outbox');
   for(const candidate of result.items){
    if(this.closing||this.clock()-began>=this.workBudgetMs)break;
    this.metrics.fetched++;
    try{await this.deliver(candidate);}
    catch(error){
     if(this.closing)break;
     failed=true;this.metrics.failed++;
     if(error.message==='invalid_face_candidate')this.metrics.invalid++;
     this.metrics.last_error=['invalid_face_candidate','face_alarm_identity_conflict','face_alarm_write_unconfirmed','face_ack_unconfirmed'].includes(error.message)?error.message:'face_delivery_unavailable';
    }
   }
  }catch{if(!this.closing){failed=true;this.metrics.failed++;this.metrics.last_error='face_outbox_unavailable';}}
  this.failures=failed?Math.min(6,this.failures+1):0;
  if(!this.closing){this.metrics.state=failed?'retrying':'waiting';if(!failed)this.metrics.last_error=null;}
  return !failed;
 }
 tick(){
  if(this.closing)return Promise.resolve(false);
  if(this.inFlight)return this.inFlight;
  this.inFlight=this.step().finally(()=>{this.inFlight=null;});return this.inFlight;
 }
 run(){
  if(this.started||this.closing||!this.transport)return;this.started=true;
  const work=async()=>{await this.tick();if(!this.closing){this.timer=setTimeout(work,Math.min(60000,this.intervalMs*2**this.failures));this.timer.unref?.();}};
  void work();
 }
 async close(){this.closing=true;this.metrics.state='stopped';clearTimeout(this.timer);this.abort.abort();await this.inFlight;}
 status(){return {...this.metrics,batch_limit:this.batchLimit,concurrency:1};}
}
