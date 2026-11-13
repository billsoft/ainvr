import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewFor} from '../src/review-worker.mjs';
for(const event_kind of ['fire_smoke','suspected_down','helmet_violation','region_count','region_absence']){
 test(`${event_kind} never inherits person review, including retained fullframes`,()=>{
  const frames=[{frame_id:'start'},{frame_id:'trigger'}];
  const event={event_kind,incident_scope:'region',identity_kind:'region',rule:{id:'r',version:1,snapshot:{region_state:{event_kind},review:{enabled:true}}},analysis_evidence:{region_state:{event_kind},delivery:{state:'complete',frames}}};
  const review=reviewFor(event);
  assert.equal(review.state,'skipped');assert.equal(review.reason,'region_manual_review');assert.equal(review.policy.enabled,false);assert.equal(review.generation,undefined);assert.deepEqual(review.frames,frames);
  for(const marker of [{incident_scope:'region'},{identity_kind:'region'},{analysis_evidence:{region_state:{event_kind}}},{rule:{snapshot:{region_state:{event_kind},review:{enabled:true}}}}]){
   assert.equal(reviewFor({...marker,event_kind}).reason,'region_manual_review');
  }
 });
}
test('ordinary person target retains its existing review queue policy',()=>{
 assert.equal(reviewFor({frame_id:'f',rule:{id:'r',version:1,snapshot:{review:{enabled:true}}}}).state,'queued');
});
