import test from 'node:test';
import assert from 'node:assert/strict';
import {FOCUS_LAYOUT,FOCUS_PROMPT_VERSION,FOCUS_TEMPLATE,FOCUS_DEFAULTS,focusPreparation,validFocusResult,validFocusEnvelope,focusAssessment} from '../src/review-focus.mjs';
import {parseAuthorization,authorizedResult} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
import {SECONDARY_REVIEW_VERSION} from '../src/review-secondary.mjs';
const grant={schema:'ainvr.review-authorization.v1',enabled:true,mode:'confirm_or_reject',model_sha256:'a'.repeat(64),layout:'target-crop-v1',prompt_template:'alarm-review-zh-v1',caller_template:REVIEW_PROMPT_VERSION,labels:['person'],approve_above:.999,minimum_frame_score:.99,authorized_by:'test',authorized_at:'2026-11-06T00:00:00Z',secondary:{version:SECONDARY_REVIEW_VERSION,confirm_above:.999,reject_below:.001},focus:{...FOCUS_DEFAULTS}};
test('focused preparation preserves original edge target in both views',()=>{
 const sample={bbox:{x:800,y:0,w:140,h:220}},source={width:1920,height:1080};
 const tight=focusPreparation(sample,source),wide=focusPreparation(sample,source,'context');
 assert.deepEqual(tight.target,wide.target);assert.equal(tight.target[1],0);assert.equal(tight.view,'tight');assert.equal(wide.view,'context');
 for(const bbox of [{x:-1,y:0,w:10,h:10},{x:1900,y:0,w:30,h:30},{x:0,y:0,w:0,h:20}])assert.throws(()=>focusPreparation({bbox},source));
});
test('focus response must prove view, original target and canvas dimensions',()=>{
 const p=focusPreparation({bbox:{x:0,y:0,w:30,h:40}},{width:100,height:100});
 const valid={...p,width:896,height:448,expansion:1.15,marker:'no-target-box',region:[]};assert.ok(validFocusResult(valid,p));
 for(const patch of [{view:'context'},{target:[0,0,.4,.4]},{expansion:1.5},{width:448},{layout:'target-crop-v1'}])assert.equal(validFocusResult({...valid,...patch},p),false);
});
test('focus authorization is explicit, version bound and preserves legacy group input',()=>{
 const p=parseAuthorization(grant);assert.ok(p);const old=parseAuthorization({...grant,focus:undefined});assert.ok(old);assert.notEqual(p.id,old.id);
 const result={model:{package_sha256:grant.model_sha256},prepared_image:{layout:FOCUS_LAYOUT},template:FOCUS_TEMPLATE,caller_template:FOCUS_PROMPT_VERSION,target_label:'person'};
 assert.ok(authorizedResult(p,result));assert.equal(authorizedResult(old,result),false);
 assert.ok(authorizedResult(p,{...result,prepared_image:{layout:'target-crop-v1'},template:grant.prompt_template,caller_template:REVIEW_PROMPT_VERSION}));
 for(const focus of [{...grant.focus,layout:'future'}, {...grant.focus,caller_template:'old'},{}])assert.equal(parseAuthorization({...grant,focus}),null);
 assert.equal(parseAuthorization({...grant,mode:'confirm_only'}),null);
 assert.equal(authorizedResult(p,{...result,target_label:'dog'}),false);
});

const person=p=>({person:p,non_person:(1-p)/2,uncertain:(1-p)/2});
const other=p=>({person:(1-p)/2,non_person:p,uncertain:(1-p)/2});
const classify=(primary,context,complete=true)=>focusAssessment({primary,context,complete,policy:FOCUS_DEFAULTS,rule:{approve_above:.95}});
test('three-way verdict requires affirmative non-person evidence, not absence of person',()=>{
 assert.equal(classify([person(.995),person(.98)]).outcome,'confirmed');
 assert.equal(classify([person(.97),person(.98)],[person(.995),person(.995)]).outcome,'confirmed');
 assert.equal(classify([other(.995),other(.997)],[other(.999),other(.998)]).outcome,'false_positive');
 assert.equal(classify([other(.995)],[other(.999)],false).outcome,'uncertain');
 assert.equal(classify([{person:.01,non_person:.02,uncertain:.97}],[other(.999)]).outcome,'uncertain');
 assert.equal(classify([person(.945)],[person(.999)]).outcome,'uncertain');
 assert.equal(classify([person(.99)],[other(.999)]).outcome,'confirmed'); // valid primary settles before context is requested
});
test('malformed or binary results cannot masquerade as three-way evidence',()=>{
 const valid={template:FOCUS_TEMPLATE,score_kind:'three_way_softmax_uncalibrated',class_scores:person(.99),real_score:.99,submitted_prompt:'fixed task'};
 assert.ok(validFocusEnvelope(valid));
 for(const patch of [{template:'alarm-review-zh-v1'},{score_kind:'two_way_softmax_uncalibrated'},{class_scores:{person:.99,non_person:.8,uncertain:0}},{real_score:.5},{submitted_prompt:''}])assert.equal(validFocusEnvelope({...valid,...patch}),false);
 assert.equal(classify([{person:.01,non_person:.99,uncertain:.9}],[]).outcome,'uncertain');
});
