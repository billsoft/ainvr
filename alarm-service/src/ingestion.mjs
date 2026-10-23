// Copyright AINVR. Durable prepare/materialize/checkpoint protocol for standalone Mongo.
import {observationBarrier} from './observation-barrier.mjs';
import {randomUUID} from 'node:crypto';
import {digest,fail,identity,integerText,validateFrame} from './domain.mjs';
import {evaluate} from './engine.mjs';
import {behaviorEvent} from './behavior-events.mjs';

export class ObservationConsumer {
  constructor(repository,{now=()=>Date.now(),leaseMs=30000,hook=async()=>{}}={}) {
    this.repository=repository;this.collection=repository.checkpoints;
    this.now=now;this.leaseMs=leaseMs;this.hook=hook;
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
      const pending={offset:envelope.offset,fingerprint,checkpoint:result.checkpoint,capture_intents:result.capture_intents??[],events:result.events,coverage:result.coverage??[],ended_episodes:result.ended_episodes??[],issues:result.issues};
      // Optional evidence must never turn an otherwise valid frame into a retry loop.
      if(Buffer.byteLength(JSON.stringify(pending))>7*1024*1024){
        pending.capture_intents=[];
        for(const state of Object.values(pending.checkpoint.states??{})){delete state.review_compact;state.review_unavailable=true;}
        for(const event of pending.events)if(event.analysis_evidence?.review_context){event.analysis_evidence.review_context={schema_version:'2.0',truncated:true,samples:[],trace:[],reason:'evidence_capacity'};}
        pending.issues=[...pending.issues,'optional_evidence_capacity'];
      }
      if(Buffer.byteLength(JSON.stringify(pending))>8*1024*1024)fail('checkpoint_capacity','Channel state exceeds bounded checkpoint capacity',503);
      const prepared=await this.collection.findOneAndUpdate({...validFence(),pending:null},{$set:{pending}},{returnDocument:'after'});
      if(!prepared)fail('lease_expired','Input lease expired; retry same input',503);
      await this.hook('prepared');
      doc=await this.finish(prepared,validFence);
      return {durable:true,outcome:'consumed',offset:doc.offset,events:[...new Set(result.events.filter(e=>e.rule.snapshot.alarm_enabled!==false).map(e=>e.episode_id??e.alarm_id))],behavior_events:result.events.map(e=>behaviorEvent(e).event_id),issues:result.issues};
    } finally {
      await this.collection.updateOne(fence,{$set:{lease_until:0},$unset:{lease_token:''}});
    }
  }
  async finish(doc,fence) {
    const p=doc.pending;
    if(this.repository.captureJobs)for(const intent of p.capture_intents??[]){
      const id=digest([intent.channel_id,intent.stream_session_id,intent.sample.frame_id]);
      await this.repository.captureJobs.updateOne({_id:id},{$setOnInsert:{...intent,state:'queued',next_at:0,created_at:Date.now()}},{upsert:true});
    }
    for(const event of p.events){
      const behaviorId=await this.repository.behaviors.insert(event);
      await this.hook('behavior_inserted');
      if(event.rule.snapshot.alarm_enabled!==false){
        await this.repository.insert({...event,behavior_event_ids:[behaviorId]});
        // Queue after the immutable fact/merged alarm; replay reuses the fact ID.
        await this.repository.evidenceVault?.enqueue(behaviorId,event);
      }
      await this.hook('event_inserted');
    }
    await this.repository.flow?.record(p.coverage);
    await this.hook('before_checkpoint');
    for(const episode of p.ended_episodes??[])await this.repository.endEpisode(episode);
    const saved=await this.collection.findOneAndUpdate({...fence(),'pending.fingerprint':p.fingerprint},
      {$set:{offset:p.offset,fingerprint:p.fingerprint,checkpoint:p.checkpoint,pending:null,last_consumed_at:new Date(this.now()).toISOString(),last_issues:p.issues}},
      {returnDocument:'after'});
    if(!saved)fail('lease_expired','Checkpoint not committed; retry same input',503);
    return saved;
  }
}
