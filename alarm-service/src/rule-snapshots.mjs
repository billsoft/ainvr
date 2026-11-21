import {digest,fail,identity,integerText,validateRule} from './domain.mjs';

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
  constructor(db,{clock=()=>new Date().toISOString()}={}){this.collection=db.collection('alarm_rule_snapshot');this.clock=clock;}
  async current(){return this.collection.findOne({_id:'active'});}
  async status(){
    const current=await this.current();
    return current?{state:'applied',revision:current.revision,digest:current.digest,applied_at:current.applied_at,rule_count:current.rules.length}:
      {state:'not_configured',revision:null,digest:null,applied_at:null,rule_count:0};
  }
  async apply(input,actor){
    identity(actor,'actor');
    if(!input||input.schema_version!=='1.0'||Object.keys(input).some(k=>!['schema_version','revision','rules'].includes(k))||!Array.isArray(input.rules)||input.rules.length>5000)fail('invalid_snapshot','Invalid rule snapshot');
    const revision=integerText(input.revision,'revision');
    const ids=new Set();
    const rules=input.rules.map(rule=>{
      if(!rule||typeof rule!=='object'||Array.isArray(rule))fail('invalid_rule','Rule must be an object');
      const parsed=validateRule(rule);
      if(!['enabled','paused'].includes(parsed.state))fail('unsupported_rule','Snapshot requires enabled or paused execution rules');
      if(ids.has(parsed.id))fail('duplicate_rule','Duplicate rule identity');
      ids.add(parsed.id);return parsed;
    }).sort((a,b)=>a.id.localeCompare(b.id));
    if(Buffer.byteLength(JSON.stringify(rules))>8*1024*1024)fail('snapshot_capacity','Rule snapshot exceeds capacity');
    const fingerprint=digest(rules);
    for(let attempt=0;attempt<8;attempt++){
      const previous=await this.current();
      if(previous){
        const old=BigInt(previous.revision);
        if(revision<old)fail('stale_revision','A newer rule snapshot is already applied',409);
        if(revision===old){
          const same=fingerprint===previous.digest||(previous.rules.length===rules.length&&previous.rules.every((r,i)=>normalized(r)===digest(canonical(rules[i]))));
          if(!same)fail('revision_conflict','Same revision has different content',409);
          return {applied:true,revision:previous.revision,digest:previous.digest,applied_at:previous.applied_at};
        }
        // Authored edits require a new rule version. Runtime view overlays use
        // the strictly increasing global revision plus a changed view epoch.
        const oldRules=new Map(previous.rules.map(r=>[r.id,r]));
        for(const rule of rules){const oldRule=oldRules.get(rule.id);if(oldRule&&(rule.version<oldRule.version||(rule.version===oldRule.version&&digest(canonical(rule))!==normalized(oldRule)&&!sameAuthoredRuleAcrossViews(oldRule,rule))))fail('rule_version_conflict','Changed rules require a newer rule version',409);}
      }
      const next={_id:'active',schema_version:'1.0',revision:input.revision,digest:fingerprint,rules,applied_at:this.clock(),actor};
      if(previous){
        const result=await this.collection.replaceOne({_id:'active',revision:previous.revision,digest:previous.digest},next);
        if(!result.modifiedCount)continue;
      }else{
        try{await this.collection.insertOne(next);}catch(error){if(error.code===11000)continue;throw error;}
      }
      return {applied:true,revision:next.revision,digest:next.digest,applied_at:next.applied_at};
    }
    fail('configuration_busy','Concurrent configuration update; retry',409);
  }
}
