// Copyright AINVR. Durable prepare/materialize/checkpoint protocol for standalone Mongo.
import {observationBarrier} from './observation-barrier.mjs';
import {randomUUID} from 'node:crypto';
import {digest,fail,identity,integerText,validateFrame} from './domain.mjs';
import {evaluate} from './engine.mjs';
import {behaviorEvent} from './behavior-events.mjs';
import {dwellStep,materializeDwell} from './dwell-visits.mjs';
import {beginRegionHeat,materializeRegionHeat,suspendRegionHeat} from './region-heat.mjs';

// Include every sealed proof frame, especially the trigger/exit frame. Candidate
// intents alone only retain the start of a behavior and can miss its conclusion.
export function evidenceCaptureIntents(pending) {
  const intents=new Map();
  for(const intent of pending.capture_intents??[])intents.set(digest([intent.channel_id,intent.stream_session_id,intent.sample.frame_id]),intent);
  for(const event of pending.events??[]){
    if(event.rule.snapshot.alarm_enabled===false)continue;
    for(const sample of event.analysis_evidence?.review_context?.samples??[]){
      if(!sample.event_eligible||sample.observation!=='detected')continue;
      const intent={channel_id:event.channel_id,stream_session_id:event.stream_session_id,source:event.analysis_evidence.source,sample};
      intents.set(digest([intent.channel_id,intent.stream_session_id,sample.frame_id]),intent);
    }
  }
  return [...intents.values()];
}

export class ObservationConsumer {
  constructor(repository,{now=()=>Date.now(),leaseMs=30000,hook=async()=>{}}={}) {
    this.repository=repository;this.collection=repository.checkpoints;
    this.now=now;this.leaseMs=leaseMs;this.hook=hook;this.dwellStarted=new Set();
  }
  async consume(envelope) {
    const release=observationBarrier(this.repository).enter();
    try{return await this.consumeFrame(envelope);}finally{release();}
  }
  async consumeFrame(envelope) {
    if(!envelope||envelope.schema_version!=='1.0')fail('invalid_envelope','Unsupported input envelope');
    const producer=identity(envelope.producer_id,'producer_id');
    const offset=integerText(envelope.offset,'offset');
    const frame=validateFrame(envelope.frame),channel=frame.channel_id;
    const fingerprint=digest([producer,envelope.offset,frame]);
    try{await this.collection.updateOne({channel_id:channel},{$setOnInsert:{channel_id:channel,producer_id:producer,
      offset:null,fingerprint:null,checkpoint:null,pending:null,lease_until:0,generation:0}},{upsert:true});}
    catch(e){if(e.code!==11000)throw e;}
    const token=randomUUID(),now=this.now();
    let doc=await this.collection.findOneAndUpdate({channel_id:channel,lease_until:{$lte:now}},
      {$set:{lease_token:token,lease_until:now+this.leaseMs},$inc:{generation:1}},{returnDocument:'after'});
    if(!doc)fail('consumer_busy','Channel is being processed; retry same input',503);
    const fence={channel_id:channel,lease_token:token,generation:doc.generation};
    const validFence=()=>({...fence,lease_until:{$gt:this.now()}});
    try {
      if(doc.producer_id!==producer)fail('producer_changed','Producer identity changed; explicit migration required',409);
      // Complete a previously prepared outcome before reading current rules.
      // Old/stale workers can only materialize this same immutable outcome.
      if(doc.pending)doc=await this.finish(doc,validFence);
      if(doc.offset!==null&&offset<=BigInt(doc.offset)) {
        if(offset===BigInt(doc.offset)&&doc.fingerprint!==fingerprint)fail('offset_conflict','Same offset has different content',409);
        return {durable:true,outcome:'already_consumed',offset:envelope.offset,events:[]};
      }
      const gap=doc.offset!==null&&offset!==BigInt(doc.offset)+1n;
      const rules=(await this.repository.listRules(channel)).map(({history,...r})=>r);
      const result=evaluate(doc.checkpoint,{...frame,...(gap?{gap:true}:{})},rules);
      for(const entry of result.checkpoint.dwell_gaps??[])if(entry.to===null&&entry.stream_session_id!==frame.stream_session_id)entry.to=frame.captured_at;
      const duplicate=result.issues.includes('duplicate_or_old_seq'),options={gap,previous:doc.checkpoint,restart:!this.dwellStarted.has(channel)};
      const heat=duplicate||!this.repository.heat?null:beginRegionHeat(doc.checkpoint?.region_heat,frame,options);
      const optional=callback=>value=>{try{callback(value);}catch{heat.suspend('heat_derivation_error');}};
      const dwell=duplicate?{facts:[],issues:[]}:dwellStep(doc.checkpoint?.dwell,frame,rules,{...options,...(heat?{onPair:optional(heat.add),onRegions:optional(heat.regions)}:{})});
      const heatResult=heat?.finish(dwell.issues)??{facts:[],issues:[]};
      if(!duplicate)result.checkpoint.dwell=dwell.state;
      if(heat)result.checkpoint.region_heat=heatResult.state;
      result.issues.push(...dwell.issues,...heatResult.issues);
      const pending={offset:envelope.offset,fingerprint,checkpoint:result.checkpoint,dwell_facts:dwell.facts,heat_facts:heatResult.facts,capture_intents:result.capture_intents??[],events:result.events,coverage:result.coverage??[],ended_episodes:result.ended_episodes??[],issues:result.issues};
      // Drop optional heat before touching dwell, alarm evidence or base state.
      // Ordinary frames need one exact measurement. Re-measure only after a
      // degradation mutates pending; never estimate away the hard safety cap.
      let pendingBytes=Buffer.byteLength(JSON.stringify(pending));
      if(pendingBytes>7*1024*1024&&(pending.heat_facts.length||pending.checkpoint.region_heat)){
        pending.checkpoint.region_heat=suspendRegionHeat(pending.checkpoint.region_heat,frame,'heat_capacity',pending.heat_facts);
        pending.heat_facts=[];pending.issues.push('heat_capacity');
        pendingBytes=Buffer.byteLength(JSON.stringify(pending));
      }
      // Dwell is derived and must never consume the original pipeline's budget.
      // Suspend for this stream session: re-opening discarded visits could count
      // the same uninterrupted target twice. A new session starts cleanly.
      if(pendingBytes>7*1024*1024&&(pending.dwell_facts.length||pending.checkpoint.dwell)){
        const starts=[...Object.values(pending.checkpoint.dwell?.visits??{}),...pending.dwell_facts].map(v=>Date.parse(v.started_at)).filter(Number.isFinite);
        const from=new Date(Math.min(Date.parse(frame.captured_at),...starts)).toISOString();
        pending.checkpoint.dwell_gaps??=[];
        if(!pending.checkpoint.dwell_gaps.some(g=>g.stream_session_id===frame.stream_session_id&&g.to===null))pending.checkpoint.dwell_gaps.push({stream_session_id:frame.stream_session_id,from,to:null,reason:'dwell_capacity'});
        pending.checkpoint.dwell_gaps=pending.checkpoint.dwell_gaps.slice(-64);
        pending.dwell_facts=[];pending.checkpoint.dwell={disabled_session:frame.stream_session_id};
        pending.issues.push('dwell_capacity');
        pendingBytes=Buffer.byteLength(JSON.stringify(pending));
      }
      // Optional evidence must never turn an otherwise valid frame into a retry loop.
      if(pendingBytes>7*1024*1024){
        pending.capture_intents=[];
        for(const state of Object.values(pending.checkpoint.states??{})){delete state.review_compact;state.review_unavailable=true;}
        for(const event of pending.events)if(event.analysis_evidence?.review_context){event.analysis_evidence.review_context={schema_version:'2.0',truncated:true,samples:[],trace:[],reason:'evidence_capacity'};}
        pending.issues=[...pending.issues,'optional_evidence_capacity'];
        pendingBytes=Buffer.byteLength(JSON.stringify(pending));
      }
      if(pendingBytes>8*1024*1024)fail('checkpoint_capacity','Channel state exceeds bounded checkpoint capacity',503);
      const prepared=await this.collection.findOneAndUpdate({...validFence(),pending:null},{$set:{pending}},{returnDocument:'after'});
      if(!prepared)fail('lease_expired','Input lease expired; retry same input',503);
      await this.hook('prepared');
      doc=await this.finish(prepared,validFence);
      this.dwellStarted.add(channel);
      if(this.dwellStarted.size>1024)this.dwellStarted.delete(this.dwellStarted.values().next().value);
      return {durable:true,outcome:'consumed',offset:doc.offset,events:[...new Set(result.events.filter(e=>e.rule.snapshot.alarm_enabled!==false).map(e=>e.episode_id??e.alarm_id))],behavior_events:result.events.map(e=>behaviorEvent(e).event_id),issues:result.issues};
    } finally {
      await this.collection.updateOne(fence,{$set:{lease_until:0},$unset:{lease_token:''}});
    }
  }
  async finish(doc,fence) {
    const p=doc.pending;
    if(this.repository.captureJobs)for(const intent of evidenceCaptureIntents(p)){
      const id=digest([intent.channel_id,intent.stream_session_id,intent.sample.frame_id]);
      await this.repository.captureJobs.updateOne({_id:id},{$setOnInsert:{...intent,state:'queued',next_at:0,created_at:Date.now()}},{upsert:true});
    }
    for(const event of p.events){
      const behaviorId=await this.repository.behaviors.insert(event);
      await this.hook('behavior_inserted');
      if(event.rule.snapshot.alarm_enabled!==false&&!await this.repository.isCleared?.(event)){
        await this.repository.insert({...event,behavior_event_ids:[behaviorId]});
        // Queue after the immutable fact/merged alarm; replay reuses the fact ID.
        await this.repository.evidenceVault?.enqueue(behaviorId,event);
      }
      await this.hook('event_inserted');
    }
    await this.repository.flow?.record(p.coverage);
    // Derived caches cannot hold the authoritative alarm/coverage pipeline.
    // A failed/uncertain batch is explicitly recorded as a conservative gap in
    // the same checkpoint commit. Deterministic IDs make late writes/replay safe.
    for(const [kind,facts,write] of [['dwell',p.dwell_facts,materializeDwell],['heat',p.heat_facts,materializeRegionHeat]]){
      if(!facts?.length)continue;
      let timer,written=false;
      try{
        await Promise.race([write(this.repository.db,facts),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('derived_write_timeout')),1000);})]);
        written=true;
      }catch{
        const state=kind==='heat'?(p.checkpoint.region_heat??={}):p.checkpoint;
        const key=kind==='heat'?'gaps':'dwell_gaps';
        const starts=facts.map(f=>Date.parse(f.from??f.started_at)).filter(Number.isFinite);
        const ends=facts.map(f=>Date.parse(f.to??f.ended_at)).filter(Number.isFinite);
        const from=new Date(starts.length?Math.min(...starts):this.now()).toISOString();
        const to=new Date(Math.max(Date.parse(from)+1,ends.length?Math.max(...ends):this.now())).toISOString();
        const reason=kind+'_write_failed';
        const gaps=state[key]??=[];
        const last=gaps.at(-1);
        if(last?.reason===reason&&last.to!==null&&Date.parse(last.to)>=Date.parse(from)){
          last.from=last.from<from?last.from:from;last.to=last.to>to?last.to:to;
        }else gaps.push({from,to,reason});
        state[key]=gaps.slice(-64);p.issues=[...new Set([...(p.issues??[]),reason])];
      }finally{clearTimeout(timer);}
      // Crash-injection hooks remain outside optional I/O degradation so tests
      // exercise the durable pending replay boundary, not a swallowed crash.
      if(written)await this.hook(kind==='heat'?'heat_inserted':'dwell_inserted');
    }
    await this.hook('before_checkpoint');
    for(const episode of p.ended_episodes??[])await this.repository.endEpisode(episode);
    const saved=await this.collection.findOneAndUpdate({...fence(),'pending.fingerprint':p.fingerprint},
      {$set:{offset:p.offset,fingerprint:p.fingerprint,checkpoint:p.checkpoint,pending:null,last_consumed_at:new Date(this.now()).toISOString(),last_issues:p.issues}},
      {returnDocument:'after'});
    if(!saved)fail('lease_expired','Checkpoint not committed; retry same input',503);
    return saved;
  }
}
