import {digest,fail,identity,integerText,validateRule} from './domain.mjs';
import {validateMotionMetadata,motionStatus,canonicalDigest} from './motion-admission.mjs';

// Compare rules as the current code normalizes them, independent of key order, so
// defaults added by an upgrade are not mistaken for an unversioned rule change.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
// A rule the current code cannot read (an earlier behavior) is simply a different rule.
const normalized=rule=>{try{return digest(canonical(validateRule(rule)));}catch{return null;}};
// The authenticated PG publisher owns view protection. Its execution overlay
// changes independently of the authored rule version. Only a NEW view epoch in
// a newer snapshot may replace that overlay; every authored field still compares
// exactly after validation/default normalization. Same-revision replay remains strict.
function sameAuthoredRuleAcrossViews(previous,next){
  let old;try{old=validateRule(previous);}catch{return false;}
  if(!/^[a-f0-9]{64}$/.test(next.view_epoch??'')||old.view_epoch===next.view_epoch||
    !['enabled','paused'].includes(old.state))return false;
  for(const [before,after] of [[old.view_not_before,next.view_not_before],
    [old.source_binding?.not_before,next.source_binding?.not_before]]){
    if(before!==undefined&&(after===undefined||Date.parse(after)<Date.parse(before)))return false;
  }
  const authored=r=>{
    // Formal preset recovery retains canonical points. Geometry is authored data,
    // never an overlay exception, even when a new epoch accompanies the edit.
    const {state,view_epoch,view_not_before,...rest}=r;
    if(rest.source_binding){const {not_before,...binding}=rest.source_binding;rest.source_binding=binding;}
    return digest(canonical(rest));
  };
  return authored(old)===authored(next);
}
// One Mongo document makes replacement atomic on standalone Mongo as well as replicas.
// PostgreSQL remains the authority; this is only the durable execution snapshot.
export class RuleSnapshots {
  constructor(db,{clock=()=>new Date().toISOString()}={}){this.collection=db.collection('alarm_rule_snapshot');this.required=db.collection('alarm_motion_required_scopes');this.clock=clock;}
  async current(){return this.collection.findOne({_id:'active'});}
  async requiredForChannel(channel){return this.required.find({channel_id:channel}).limit(5001).toArray();}
  async needsMotionDrain(input){
    // Only installation changes an unguarded consumer into a guarded one.
    // Existing scopes already fail closed independently of snapshot delivery.
    let meta;
    try{if(!Array.isArray(input?.rules))return false;input.rules.forEach(validateRule);meta=validateMotionMetadata(input.motion_admission,input.rules);}catch{return false;}
    if(!meta?.scopes.length)return false;
    const ids=meta.scopes.map(s=>canonicalDigest([s.input_stream_id,s.channel_id]));
    const registered=await this.required.find({_id:{$in:ids}},{projection:{_id:1}}).toArray();
    return registered.length!==ids.length;
  }
  async status(){
    const current=await this.current();
    return current?{state:'applied',revision:current.revision,digest:current.digest,applied_at:current.applied_at,rule_count:current.rules.length,motion_admission:motionStatus(current.motion_admission)}:
      {state:'not_configured',revision:null,digest:null,applied_at:null,rule_count:0,motion_admission:null};
  }
  async apply(input,actor){
    identity(actor,'actor');
    if(!input||input.schema_version!=='1.0'||Object.keys(input).some(k=>!['schema_version','revision','rules','motion_admission'].includes(k))||!Array.isArray(input.rules)||input.rules.length>5000)fail('invalid_snapshot','Invalid rule snapshot');
    const revision=integerText(input.revision,'revision');
    const ids=new Set();
    const rules=input.rules.map(rule=>{
      if(!rule||typeof rule!=='object'||Array.isArray(rule))fail('invalid_rule','Rule must be an object');
      const parsed=validateRule(rule);
      if(!['enabled','paused'].includes(parsed.state))fail('unsupported_rule','Snapshot requires enabled or paused execution rules');
      if(ids.has(parsed.id))fail('duplicate_rule','Duplicate rule identity');
      ids.add(parsed.id);return parsed;
    }).sort((a,b)=>a.id.localeCompare(b.id));
    // Hash the publisher's raw validated rules, never their default-normalized copies.
    const motion=validateMotionMetadata(input.motion_admission,input.rules);
    if(Buffer.byteLength(JSON.stringify(rules))>8*1024*1024)fail('snapshot_capacity','Rule snapshot exceeds capacity');
    const fingerprint=digest(rules);
    for(let attempt=0;attempt<8;attempt++){
      const previous=await this.current();
      if(previous){
        const old=BigInt(previous.revision);
        if(revision<old)fail('stale_revision','A newer rule snapshot is already applied',409);
        if(revision===old){
          const same=fingerprint===previous.digest||(previous.rules.length===rules.length&&previous.rules.every((r,i)=>normalized(r)===digest(canonical(rules[i]))));
          if(!same||canonicalDigest(previous.motion_admission??null)!==canonicalDigest(motion))fail('revision_conflict','Same revision has different content',409);
          return {applied:true,revision:previous.revision,digest:previous.digest,applied_at:previous.applied_at,motion_admission:motionStatus(previous.motion_admission)};
        }
        // Authored edits require a new rule version. Runtime view overlays use
        // the strictly increasing global revision plus a changed view epoch.
        const oldRules=new Map(previous.rules.map(r=>[r.id,r]));
        for(const rule of rules){const oldRule=oldRules.get(rule.id);if(oldRule&&(rule.version<oldRule.version||(rule.version===oldRule.version&&digest(canonical(rule))!==normalized(oldRule)&&!sameAuthoredRuleAcrossViews(oldRule,rule))))fail('rule_version_conflict','Changed rules require a newer rule version',409);}
      }
      // Registration is durable BEFORE publication. A partial installation fails
      // closed; never delete tombstones merely because a later snapshot omits them.
      for(const scope of motion?.scopes??[])await this.required.updateOne({_id:canonicalDigest([scope.input_stream_id,scope.channel_id])},
       {$setOnInsert:{input_stream_id:scope.input_stream_id,channel_id:scope.channel_id,registered_at:this.clock()}},{upsert:true,writeConcern:{w:1,j:true}});
      const next={_id:'active',schema_version:'1.0',revision:input.revision,digest:fingerprint,rules,motion_admission:motion,applied_at:this.clock(),actor};
      if(previous){
        const result=await this.collection.replaceOne({_id:'active',revision:previous.revision,digest:previous.digest},next,{writeConcern:{w:1,j:true}});
        if(!result.modifiedCount)continue;
      }else{
        try{await this.collection.insertOne(next,{writeConcern:{w:1,j:true}});}catch(error){if(error.code===11000)continue;throw error;}
      }
      return {applied:true,revision:next.revision,digest:next.digest,applied_at:next.applied_at,motion_admission:motionStatus(next.motion_admission)};
    }
    fail('configuration_busy','Concurrent configuration update; retry',409);
  }
}
