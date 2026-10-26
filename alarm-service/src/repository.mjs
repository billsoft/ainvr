import {reviewAuthorization} from './review-authorization.mjs';
// Copyright AINVR. Mongo single-document atomic operations (no replica-set assumption).
import {reviewFor} from './review-worker.mjs';
import {randomUUID} from 'node:crypto';
import {FlowStatistics} from './flow-statistics.mjs';
import {BehaviorEvents} from './behavior-events.mjs';
import {RuleSnapshots} from './rule-snapshots.mjs';
import {stageRank} from './episodes.mjs';
import {acknowledge, digest, fail, identity, validateRule} from './domain.mjs';

const withoutInternal=d=>{if(!d)return null;const {_id,operations,...publicDoc}=d;return publicDoc;};
const pendingFilter=()=>({'handling.state':'unacknowledged','handling.disposition':{$ne:'false_positive'}});
export class AlarmRepository {
  constructor(db,{clock=()=>new Date().toISOString()}={}) {
    this.behaviors=new BehaviorEvents(db);
    this.flow=new FlowStatistics(db);
    this.ruleSnapshots=new RuleSnapshots(db,{clock});
    this.db=db;this.events=db.collection('alarms');this.rules=db.collection('alarm_rules');
    this.captureJobs=db.collection('alarm_capture_jobs');this.checkpoints=db.collection('alarm_consumer_checkpoints');this.clock=clock;
  }
  async initialize() {
    await this.behaviors.initialize();
    await this.flow.initialize();
    await this.events.createIndex({alarm_id:1},{unique:true});
    await this.events.createIndex({dedup_key:1},{unique:true});
    await this.events.createIndex({'handling.state':1,'handling.disposition':1,'review.state':1,ingested_at:1});
    await this.events.createIndex({'lifecycle.state':1,'rule.id':1,'rule.version':1});
    await this.events.createIndex({occurred_at:-1,alarm_id:-1});
    await this.events.createIndex({channel_id:1,occurred_at:-1,alarm_id:-1});
    await this.rules.createIndex({id:1},{unique:true});
    await this.checkpoints.createIndex({channel_id:1},{unique:true});
    await this.captureJobs.createIndex({state:1,next_at:1,created_at:1});
    await this.captureJobs.createIndex({finished_at:1},{expireAfterSeconds:86400});
  }
  async isCleared(event){
    const state=await this.db.collection('alarm_history_clear').findOne({_id:'state'});
    return !!state&&event.occurred_at<=state.cutoff;
  }
  async clearAll(actor,key){
    identity(actor,'actor');identity(key,'operation key');
    const operations=this.db.collection('alarm_history_clear_operations'),id=digest([actor,key]);
    let op=await operations.findOne({_id:id});
    if(!op){
      const cutoff=this.clock();
      const count=await this.events.countDocuments({ingested_at:{$lte:cutoff}});
      await operations.updateOne({_id:id},{$setOnInsert:{actor,cutoff,matched_count:count,state:'prepared',created_at:cutoff}},{upsert:true});
      op=await operations.findOne({_id:id});
    }
    if(op.state!=='completed'){
      // Durable tombstone precedes deletion: crash replay cannot recreate cleared alarms.
      await this.db.collection('alarm_history_clear').updateOne({_id:'state'},{$max:{cutoff:op.cutoff}},{upsert:true});
      await this.events.deleteMany({ingested_at:{$lte:op.cutoff}});
      await operations.updateOne({_id:id},{$set:{state:'completed',completed_at:this.clock()}});
    }
    return {cleared:true,cutoff:op.cutoff,deleted_count:op.matched_count};
  }
  async insert(event) {
    if(await this.isCleared(event))return false;
    if(event.episode_id)return this.mergeEpisode(event);
    const document={...structuredClone(event),review:reviewFor(event),ingested_at:this.clock(),operations:[],logs:[{
      operation_id:`created:${event.alarm_id}`,alarm_id:event.alarm_id,action:'created',actor:'alarm-service',at:this.clock()}]};
    const result=await this.events.updateOne({alarm_id:event.alarm_id},{$setOnInsert:document},{upsert:true});
    return result.upsertedCount===1;
  }
  // An activity spans several triggers: it ends only when none of its rules remain.
  async reconcileActivities(snapshot){
    if(!snapshot)return;
    const rules=snapshot.rules.map(r=>({id:r.id,version:r.version}));
    const still=rules.length?[{rules:{$elemMatch:{$or:rules}}},...rules.map(r=>({'rule.id':r.id,'rule.version':r.version}))]:[];
    await this.events.updateMany({'lifecycle.state':'active',...(still.length?{$nor:still}:{})},
      {$set:{lifecycle:{state:'ended',ended_at:snapshot.applied_at,end_reason:'configuration_changed'}},$inc:{version:1}});
  }
  async closeStaleEpisode(event){
    const snapshot=await this.ruleSnapshots.current(),activity=snapshot&&await this.events.findOne({alarm_id:event.episode_id},{projection:{rules:1,rule:1}});
    const used=activity?.rules??[{id:event.rule.id,version:event.rule.version}];
    if(snapshot&&!used.some(u=>snapshot.rules.some(r=>r.id===u.id&&r.version===u.version)))
      await this.endEpisode({episode_id:event.episode_id,ended_at:new Date(Math.max(Date.parse(snapshot.applied_at),Date.parse(event.occurred_at))).toISOString(),end_reason:'configuration_changed'});
  }
  async mergeEpisode(event){
    const id=event.episode_id,stage={event_id:event.dedup_key,behavior:event.behavior,at:event.occurred_at,trigger_id:event.trigger_id??event.rule.id,zone_id:event.rule.snapshot.zone_id??null,
      direction:event.direction,frame_id:event.frame_id,behavior_event_ids:event.behavior_event_ids??[]};
    const ruleRef={id:event.rule.id,version:event.rule.version};
    const document={...structuredClone(event),review:reviewFor(event),alarm_id:id,dedup_key:id,occurred_at:event.occurred_at,activity_started_at:event.episode_started_at??event.occurred_at,rules:[],
      ingested_at:this.clock(),stages:[],operations:[],logs:[{operation_id:`created:${id}`,alarm_id:id,action:'created',actor:'alarm-service',at:this.clock()}]};
    try{await this.events.updateOne({alarm_id:id},{$setOnInsert:document},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
    for(let retry=0;retry<8;retry++){
      const current=await this.events.findOne({alarm_id:id});
      if(current.stages.some(s=>s.event_id===stage.event_id)){await this.closeStaleEpisode(event);return false;}
      // Store each trigger/zone/stage once per activity. All repeated facts
      // already live independently in behavior_events for counting. Otherwise a
      // busy boundary can exhaust the stage array and block this channel forever.
      if(current.stages.some(s=>s.behavior===stage.behavior&&s.trigger_id===stage.trigger_id&&s.zone_id===stage.zone_id)){
        const seen=await this.events.updateOne({alarm_id:id,version:current.version},
          {$max:{last_seen_at:event.last_seen_at},$inc:{version:1},$addToSet:{rules:ruleRef}});
        if(seen.modifiedCount){await this.closeStaleEpisode(event);return false;}
        continue;
      }
      if(current.stages.length>=1024)fail('episode_capacity','Activity stage capacity reached',503);
      // Alarm time is the first time a selected rule fired; the activity start is kept separately.
      const set={last_seen_at:event.last_seen_at>current.last_seen_at?event.last_seen_at:current.last_seen_at};
      if(event.occurred_at<current.occurred_at)set.occurred_at=event.occurred_at;
      // The alarm shows the highest level reached and the trigger that reached it.
      // Same-stage recurrence remains a behavior fact, not a new review job.
      // A higher stage changes the claim and may reopen an AI decision.
      if(current.stages.length===0||(stageRank[event.behavior]??0)>(stageRank[current.behavior]??0))Object.assign(set,{
        behavior:event.behavior,direction:event.direction,analysis_evidence:event.analysis_evidence,frame_id:event.frame_id,source_pts_ns:event.source_pts_ns,
        rule:event.rule,trigger_id:event.trigger_id,severity:event.severity,review:reviewFor(event)});
      if(Object.hasOwn(set,'review')&&current.handling?.reviewed_by_kind==='human')set.review={...set.review,state:'skipped',reason:'human_handled'};
      // A new highest-stage evidence invalidates an AI decision, never a human one.
      if(Object.hasOwn(set,'review')&&current.handling?.reviewed_by_kind==='ai')set.handling={state:'unacknowledged',revision:current.handling.revision+1,disposition:'unset'};
      // Human acknowledgement/audit are never replaced.
      const result=await this.events.updateOne({alarm_id:id,version:current.version,'stages.event_id':{$ne:stage.event_id}},
        {$set:set,$inc:{version:1},$push:{stages:stage},$addToSet:{behavior_event_ids:{$each:event.behavior_event_ids??[]},rules:ruleRef}});
      if(result.modifiedCount){await this.closeStaleEpisode(event);return true;}
    }
    fail('version_conflict','Concurrent activity update; retry input',503);
  }
  async endEpisode({episode_id,ended_at,end_reason}){
    await this.events.updateOne({alarm_id:episode_id,'lifecycle.state':'active'},
      {$set:{lifecycle:{state:'ended',ended_at,end_reason}},$inc:{version:1}});
  }
  async get(id) {
    identity(id,'alarm_id');const d=await this.events.findOne({alarm_id:id});
    if(!d) fail('not_found','Alarm not found',404);return withoutInternal(d);
  }
  async confirm(id,request,actor,key) {
    identity(id,'alarm_id');identity(actor,'actor');identity(key,'Idempotency-Key');
    const fingerprint=digest([actor,request]);
    // CAS on handling only: a concurrent review does not cause an ack conflict.
    for(let retry=0;retry<4;retry++) {
      const current=await this.events.findOne({alarm_id:id});
      if(!current) fail('not_found','Alarm not found',404);
      const previous=current.operations.find(o=>o.key===key);
      if(previous) {if(previous.fingerprint!==fingerprint)fail('idempotency_conflict','Key used with different payload',409);return previous.response;}
      const result=acknowledge(current,request,actor,randomUUID(),this.clock());
      if(result.outcome==='already_acknowledged')return {outcome:result.outcome,handling:current.handling};
      if(current.operations.length>=256||current.logs.length>=1024)fail('audit_capacity','Audit capacity reached; maintenance required',503);
      const response={outcome:'succeeded',handling:result.event.handling,operation_id:result.log.operation_id};
      const saved=await this.events.updateOne({alarm_id:id,'handling.revision':current.handling.revision,
        'operations.key':{$ne:key}},{$set:{handling:result.event.handling},$inc:{version:1},
        $push:{logs:result.log,operations:{key,fingerprint,response}}});
      if(saved.modifiedCount)return response;
    }
    fail('version_conflict','Concurrent update; refresh',409);
  }
  async pendingSummary(){
    const as_of=this.clock();
    const pending=await this.events.countDocuments({...pendingFilter(),ingested_at:{$lte:as_of}},{maxTimeMS:3000});
    const [referenceCounts,runtime]=await Promise.all([
      this.events.aggregate([{$match:pendingFilter()},{$group:{_id:{$cond:[{$eq:['$review.state','running']},'running',{$ifNull:['$review.reference.state','waiting']}]},count:{$sum:1}}}],{maxTimeMS:3000}).toArray(),
      this.db.collection('alarm_reference_runtime').findOne({_id:'reference'},{projection:{_id:0,expires_at:1}})
    ]);
    const authorization=await reviewAuthorization();
    return {pending,as_of,automatic_review:authorization?{mode:authorization.mode,accuracy_validated:false,approve_above:authorization.approve_above,labels:authorization.labels}:null,reference:{active:(runtime?.expires_at??0)>Date.now(),counts:Object.fromEntries(referenceCounts.map(r=>[r._id,r.count]))}};
  }
  async list({status='pending',channel_id,review,disposition,from,to,zone_id,behavior,limit=50,cursor}={}) {
    if(!['pending','all','acknowledged','human','ai'].includes(status))fail('invalid_filter','status');
    if(!Number.isInteger(limit)||limit<1||limit>200)fail('invalid_limit','limit');
    if(disposition&&!['handled','false_positive'].includes(disposition))fail('invalid_filter','disposition');
    if(channel_id)identity(channel_id,'channel_id');
    if(review&&!['skipped','queued','running','supported','not_supported','uncertain','failed'].includes(review))fail('invalid_filter','review');
    if(zone_id!==undefined)identity(zone_id,'zone_id');
    if(behavior!==undefined&&!Object.hasOwn(stageRank,behavior))fail('invalid_filter','behavior');
    const start=from===undefined?null:Date.parse(from),end=to===undefined?null:Date.parse(to);
    if((from!==undefined&&(!Number.isFinite(start)||typeof from!=='string'))||(to!==undefined&&(!Number.isFinite(end)||typeof to!=='string'))||(start!==null&&end!==null&&end<=start))fail('invalid_time_range','Invalid alarm time range');
    const signature=digest([status,disposition??null,channel_id??null,review??null,from??null,to??null,zone_id??null,behavior??null]);
    let page={as_of:this.clock()};
    if(cursor) {
      try {if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();page=JSON.parse(Buffer.from(cursor,'base64url').toString());
        if(page.signature!==signature||!Number.isFinite(Date.parse(page.as_of))||!Number.isFinite(Date.parse(page.occurred_at))||typeof page.alarm_id!=='string')throw Error();
      }catch{fail('invalid_cursor','Cursor does not match filters');}
    }
    const query={ingested_at:{$lte:page.as_of}};
    if(channel_id)query.channel_id=channel_id;
    // An activity can span several zones: match the top rule or any stage.
    query.$and=[...(zone_id?[{$or:[{'rule.snapshot.zone_id':zone_id},{'stages.zone_id':zone_id}]}]:[]),...(behavior?[{$or:[{behavior},{'stages.behavior':behavior}]}]:[])];
    if(!query.$and.length)delete query.$and;
    if(from!==undefined||to!==undefined)query.occurred_at={...(start!==null?{$gte:new Date(start).toISOString()}:{}),...(end!==null?{$lt:new Date(end).toISOString()}:{})};
    if(status==='pending')Object.assign(query,pendingFilter());
    if(status==='acknowledged')query['handling.state']='acknowledged';
    if(status==='human')Object.assign(query,{'handling.state':'acknowledged','handling.reviewed_by_kind':{$ne:'ai'}});
    if(status==='ai')Object.assign(query,{'handling.state':'acknowledged','handling.reviewed_by_kind':'ai'});
    if(disposition){
      if(status==='pending')return {items:[],next_cursor:null,as_of:page.as_of};
      Object.assign(query,{'handling.state':'acknowledged','handling.disposition':disposition});
    }
    if(review)query['review.state']=review;
    if(page.alarm_id)query.$or=[{occurred_at:{$lt:page.occurred_at}},{occurred_at:page.occurred_at,alarm_id:{$lt:page.alarm_id}}];
    const rows=await this.events.find(query,{projection:{_id:0,operations:0,logs:0,'rule.snapshot':0,analysis_evidence:0,model_snapshot:0}})
      .sort({occurred_at:-1,alarm_id:-1}).limit(limit+1).toArray();
    const more=rows.length>limit;const items=rows.slice(0,limit),last=items.at(-1);
    return {items,next_cursor:more?Buffer.from(JSON.stringify({signature,as_of:page.as_of,occurred_at:last.occurred_at,alarm_id:last.alarm_id})).toString('base64url'):null,as_of:page.as_of};
  }
  async listRules(channel_id) {
    const snapshot=await this.ruleSnapshots.current();
    if(snapshot)return snapshot.rules.filter(rule=>!channel_id||rule.channel_id===channel_id);
    return (await this.rules.find(channel_id?{channel_id}:{}).limit(1000).toArray()).map(withoutInternal);
  }
  async saveRule(input,expected,actor) {
    if(await this.ruleSnapshots.current())fail('configuration_managed','Rules are managed by the PostgreSQL configuration authority',409);
    identity(actor,'actor');const r=validateRule(input);
    if(r.state==='enabled'&&r.review.enabled)fail('review_unavailable','No validated review executor configured',409);
    const current=await this.rules.findOne({id:r.id});
    if(!current) {
      if(expected!==0||r.version!==1)fail('version_conflict','New rule requires version 1',409);
      const doc={...r,history:[{version:r.version,snapshot:r,actor,at:this.clock()}]};
      try{await this.rules.insertOne(doc);}catch(e){if(e.code===11000)fail('version_conflict','Rule already exists',409);throw e;}
    } else {
      if(current.version!==expected||r.version!==expected+1)fail('version_conflict','Rule version changed',409);
      if(current.history.length>=256)fail('rule_history_capacity','Rule version history requires archival',409);
      const saved=await this.rules.updateOne({id:r.id,version:expected},{$set:r,$push:{history:{version:r.version,snapshot:r,actor,at:this.clock()}}});
      if(!saved.modifiedCount)fail('version_conflict','Rule version changed',409);
    }
    return withoutInternal(await this.rules.findOne({id:r.id}));
  }
}
