import test from 'node:test';
import assert from 'node:assert/strict';
import {options,utc,manifest,sampleCollection,evaluate,wilson,candidateFilter} from '../scripts/review-audit-sample.mjs';
const input={start:'2026-10-30T00:00:00Z',end:'2026-11-01T00:00:00Z',sampleSize:2,cap:10,seed:'a'.repeat(64)};
const audit={action:'ai_review',actor:'ai-review',at:'2026-10-30T01:00:00Z',note:'not_supported; score=0.01; false_positive',decision_basis:'operator_authorized_dual_review',model:{package_sha256:'b'.repeat(64)},secondary:{version:'expanded-target-v1',outcome:'false_positive'}};
const row=id=>({alarm_id:id,occurred_at:'2026-10-30T00:00:00Z',handling:{state:'acknowledged',reviewed_by_kind:'ai',disposition:'false_positive'},logs:[{...audit}]});
test('requires explicit valid UTC, bounded sizes and reproducible cryptographic seed',()=>{
 assert.equal(utc('2026-10-30T00:00:00Z'),'2026-10-30T00:00:00.000Z');
 for(const start of ['2026-10-30','2026-02-30T00:00:00Z','2026-10-30T00:00:00+00:00'])assert.throws(()=>options({...input,start}));
 for(const patch of [{cap:10001},{sampleSize:1001},{sampleSize:0},{sampleSize:11},{seed:'guess'},{end:input.start}])assert.throws(()=>options({...input,...patch}));
 assert.match(options({...input,seed:undefined}).seed,/^[a-f0-9]{64}$/);
});
test('hash-ranked sample is deterministic, order independent, unique and capped',()=>{
 const rows=Array.from({length:10},(_,i)=>row(String(i))),a=manifest(rows,input),b=manifest([...rows].reverse(),input);
 assert.deepEqual(a.selected_ids,b.selected_ids);assert.equal(a.selection.N,10);assert.equal(a.selection.inclusion_probability,.2);assert.equal(new Set(a.selected_ids).size,2);
 assert.deepEqual(a.samples.map(x=>x.selection_rank),[...a.samples.map(x=>x.selection_rank)].sort());
 assert.notDeepEqual(a.selected_ids,manifest(rows,{...input,seed:'c'.repeat(64)}).selected_ids);
 assert.equal(a.selection.population_ids_sha256,b.selection.population_ids_sha256);
 assert.throws(()=>manifest([...rows,row('overflow')],input),/population_cap_exceeded/);
 assert.throws(()=>manifest([row('same'),row('same')],input),/duplicate/);
});
test('human overrides stay eligible and missing original audits are explicitly excluded',()=>{
 const overridden=row('override');overridden.handling={state:'acknowledged',reviewed_by_kind:'human',disposition:'handled',revision:2};overridden.logs.push({action:'acknowledged',actor:'operator',at:'2026-10-31T00:00:00Z'});
 const missing=row('missing');missing.logs=[];
 const result=manifest([overridden,missing],input);
 assert.equal(result.selection.N,1);assert.equal(result.selection.excluded_count,1);assert.equal(result.samples[0].ai_original_verdict.disposition,'false_positive');assert.equal(result.samples[0].current_handling.disposition,'handled');assert.equal(result.samples[0].human_override_linkage.subsequent_audit_entries.length,1);
 assert.equal(result.samples[0].details.api_relative_path,'/alarms/events/override');
 assert.equal(result.selection.excluded[0].reason,'no_retained_ai_false_positive_audit');
 assert.equal(manifest([],input).selection.N,0);assert.equal(manifest([],input).selection.inclusion_probability,null);
 const filter=candidateFilter(options(input));assert.ok(filter.$or[0].logs.$elemMatch);assert.equal(filter.occurred_at.$lt,'2026-11-01T00:00:00.000Z');
});
function collection(rows){
 let closed=false,opts,filter,limit;
 const cursor={sort(){return this},limit(n){limit=n;return this},batchSize(){return this},async close(){closed=true},async *[Symbol.asyncIterator](){yield* rows}};
 return {find(f,o){filter=f;opts=o;return cursor},inspect:()=>({closed,opts,filter,limit})};
}
test('Mongo reads use maxTimeMS and cap+1; overflow fails rather than sampling a biased prefix',async()=>{
 const c=collection([row('a'),row('b')]);assert.equal((await sampleCollection(c,input)).selection.N,2);
 assert.equal(c.inspect().opts.maxTimeMS,10000);assert.equal(c.inspect().limit,11);assert.equal(c.inspect().closed,true);
 const over=collection(Array.from({length:11},(_,i)=>row(String(i))));await assert.rejects(sampleCollection(over,input),/population_cap_exceeded/);assert.equal(over.inspect().closed,true);
});
const labeled=(id,predicted_disposition,gold)=>({alarm_id:id,predicted_disposition,gold,model_sha256:'b'.repeat(64),gate_version:'expanded-target-v1+non-target-proof-v1'});
const provenance={datasetId:'independent-labels-example',labelProvenance:'operator supplied labels; independence not attested'};
test('offline evaluator counts false dismissal of real people and excludes unclear/missing gold',()=>{
 const result=evaluate([labeled('a','false_positive','person'),labeled('b','handled','person'),labeled('c','false_positive','non_person'),labeled('d','handled','non_person'),labeled('e','false_positive','unclear'),labeled('f','false_positive',null)],provenance),p=result.profiles[0];
 assert.deepEqual(p.confusion,{real_person_kept:1,real_person_dismissed:1,non_person_kept:1,non_person_dismissed:1});assert.equal(p.unlabeled,1);assert.equal(p.unclear,1);assert.equal(p.labeled,4);assert.equal(p.insufficient_labels,true);
 assert.equal(p.false_dismiss_among_labeled_real_people.rate,.5);assert.equal(p.real_person_share_among_labeled_dismissals.rate,.5);assert.equal(result.qualification,false);assert.equal(result.inference,false);
});
test('Wilson 95 interval retains positive upper risk even after zero observed errors',()=>{
 const interval=wilson(0,100);assert.ok(interval.lower<1e-15);assert.ok(Math.abs(interval.upper-.0369934982)<1e-8);assert.equal(wilson(0,0),null);assert.throws(()=>wilson(2,1));
});
test('evaluation requires labels/proof boundaries and never pools gate/model profiles',()=>{
 const a=labeled('a','handled','person'),b={...labeled('b','false_positive','non_person'),gate_version:'another-gate'};
 assert.equal(evaluate([a,b],provenance).profiles.length,2);
 for(const patch of [{model_sha256:null},{gate_version:''},{predicted_disposition:'maybe'},{gold:'model_guess'}])assert.throws(()=>evaluate([{...a,...patch}],provenance));
 assert.throws(()=>evaluate([a,a],provenance),/duplicate/);assert.throws(()=>evaluate([a],{}));assert.equal(evaluate([],provenance).insufficient_labels,true);
 const rows=Array.from({length:30},(_,i)=>labeled(String(i),'handled',i%2?'person':'non_person'));
 assert.equal(evaluate(rows,provenance).insufficient_labels,false);assert.equal(evaluate(rows,provenance).qualification,false);
});

test('isolated Mongo query retains original AI false positives after human override and excludes missing audits',{skip:!process.env.AINVR_REVIEW_TEST_MONGO_URI,timeout:15000},async()=>{
 const {MongoClient}=await import('mongodb'),{randomUUID}=await import('node:crypto');
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_audit_sample_test_'+randomUUID().replaceAll('-',''));
 try{
  const human=row('human-override');human.handling={state:'acknowledged',reviewed_by_kind:'human',disposition:'handled'};human.logs.push({action:'acknowledged',actor:'human',at:'2026-10-31T01:00:00Z'});
  const missing=row('missing-original');missing.logs=[];
  const old=row('out-of-interval');old.occurred_at='2026-10-29T23:59:59.999Z';
  const unrelated=row('human-only');unrelated.handling.reviewed_by_kind='human';unrelated.logs=[{action:'acknowledged',actor:'human'}];
  await db.collection('alarms').insertMany([row('ai-fp'),human,missing,old,unrelated]);
  const result=await sampleCollection(db.collection('alarms'),input);
  assert.equal(result.selection.N,2);assert.equal(result.selection.candidate_count,3);assert.equal(result.selection.excluded_count,1);
  assert.deepEqual([...result.selected_ids].sort(),['ai-fp','human-override']);
  assert.equal(result.samples.find(r=>r.alarm_id==='human-override').human_override_linkage.subsequent_audit_entries.length,1);
  await assert.rejects(sampleCollection(db.collection('alarms'),{...input,cap:2}),/population_cap_exceeded/);
 }finally{try{await db.dropDatabase()}finally{await client.close()}}
});
