// Re-queue reviews that failed for transient reasons (not for evidence or model verdicts).
// Operator run: no cap. Automatic sweep (options.auto): at most auto.max automatic re-queues per alarm,
// and only after the alarm has been failed for auto.cooldownMs, so a hard fault cannot loop forever.
import {randomUUID} from 'node:crypto';
export const RETRYABLE_REVIEW_REASONS=['review_unavailable','storage_busy','storage_unavailable'];
export async function requeueFailedReviews(events,{now=Date.now(),limit=Infinity,auto=null}={}){
 const filter={'handling.state':'unacknowledged','review.policy.enabled':true,'review.state':'failed','review.reason':{$in:RETRYABLE_REVIEW_REASONS},
  ...(auto?{'review.auto_requeues':{$not:{$gte:auto.max}},'review.next_attempt_at':{$lte:now-auto.cooldownMs}}:{})};
 const at=new Date(now).toISOString();let requeued=0;
 while(requeued<limit){
  const rows=await events.find(filter,{projection:{alarm_id:1},sort:{occurred_at:-1},limit:Math.min(100,limit-requeued)}).toArray();
  if(!rows.length)break;
  let progressed=0;
  for(const row of rows){
   const result=await events.updateOne({alarm_id:row.alarm_id,...filter},{
    $set:{'review.state':'queued','review.attempt':0,'review.next_attempt_at':0,'review.lease_until':0,'review.storage_retries':0},
    $unset:{'review.reason':'','review.token':''},$inc:{version:1,...(auto?{'review.auto_requeues':1}:{})},
    $push:{logs:{$each:[{operation_id:randomUUID(),action:'review_requeued',actor:'review-requeue',at,note:auto?'transient review failure re-queued automatically':'transient review failure re-queued'}],$slice:-1024}}});
   progressed+=result.modifiedCount;
  }
  requeued+=progressed;
  if(!progressed)break;
 }
 return {requeued};
}
