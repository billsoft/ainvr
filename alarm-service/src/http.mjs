// Copyright AINVR. Independent HTTP application; no AI-service business routes.
import {observationBarrier} from './observation-barrier.mjs';
import Fastify from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import {DomainError,identity,fail} from './domain.mjs';
import {evaluate} from './engine.mjs';

const tokenEquals=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createApp({repository,apiToken,producerToken,consumer,readiness=async()=>true}) {
  if(typeof apiToken!=='string'||apiToken.length<32)throw Error('API token must contain at least 32 characters');
  if(consumer&&(!producerToken||producerToken.length<32||tokenEquals(apiToken,producerToken)))throw Error('Independent producer credential required');
  const app=Fastify({logger:false,bodyLimit:1024*1024});
  app.setErrorHandler((error,req,reply)=>{
    const status=error instanceof DomainError?error.status:error.statusCode===400?400:error.statusCode===413?413:503;
    reply.code(status).send({error:{code:error instanceof DomainError?error.code:status===400?'invalid_request':status===413?'request_too_large':'service_unavailable',
      message:error instanceof DomainError?error.message:status===400?'Invalid request':status===413?'Request too large':'Service unavailable',retryable:status===503},request_id:req.id});
  });
  app.addHook('onRequest',async(req,reply)=>{
    // Loopback-only supervisor probes expose a Boolean, never business data.
    if(req.url==='/livez'||req.url==='/readyz')return;
    const header=req.headers.authorization;
    const isInput=req.url.split('?')[0]==='/v1/observations';
    const expected=isInput?producerToken:apiToken;
    if(!expected||!tokenEquals(header,`Bearer ${expected}`))return reply.code(401).send({error:{code:'unauthorized',message:'Authentication required'}});
  });
  app.post('/v1/observations',async(req,reply)=>{
    if(!consumer)throw new DomainError('input_unavailable','Observation input unavailable',503);
    const result=await consumer.consume(req.body);
    // Never acknowledge a merely queued or partially persisted observation.
    if(result.durable!==true)throw new DomainError('input_not_durable','Observation not persisted',503);
    return reply.code(200).send(result);
  });
  const actor=req=>identity(req.headers['x-ainvr-actor'],'Authenticated actor is required');
  app.get('/v1/alarms/:id/review-frames/:key',async(req,reply)=>{
    try{const data=await repository.reviewContext?.retained(req.params.id,req.params.key);if(!data)return reply.code(404).send({error:{code:'missing_context'}});return reply.type('image/jpeg').header('Cache-Control','private, no-store').send(data);}
    catch{return reply.code(404).send({error:{code:'missing_context'}});}
  });
  app.get('/livez',async()=>({status:'alive',service:'alarm-service'}));
  app.get('/readyz',async(req,reply)=>{const ready=await readiness();return reply.code(ready?200:503).send({ready});});
  app.get('/v1/capabilities',async()=>({schema_version:'1.0',service:'alarm-service',
    behaviors:['appearance','region_approach','region_enter','region_traverse'],
    review:{available:!!repository.reviewContext,mode:'asynchronous_image_and_trajectory'},notification:{available:false},
    schedules:['always','weekly'],limits:{bulk_items:200}}));
  app.post('/v1/flow/query',async req=>repository.flow.query(req.body));
  app.post('/v1/flow/dwell',async req=>repository.dwell.query(req.body));
  app.post('/v1/flow/heat',async req=>repository.heat.query(req.body));
  app.post('/v1/flow/clear',async req=>repository.flow.clear(req.body,actor(req),identity(req.headers['idempotency-key'],'Idempotency-Key')));
  app.post('/v1/flow/purge',async req=>{
    identity(req.body?.counter_id,'counter_id');
    if(!Array.isArray(req.body?.rule_ids)||!req.body.rule_ids.length||req.body.rule_ids.length>1000)fail('invalid_purge','Binding IDs required');
    req.body.rule_ids.forEach(id=>identity(id,'rule_id'));
    return observationBarrier(repository).configure(async()=>{
      await observationBarrier(repository).drain(async()=>{
        const snapshot=await repository.ruleSnapshots.current();
        if(!snapshot||snapshot.rules.some(r=>r.counter_id===req.body?.counter_id))fail('counter_active','Stop counting before deleting records',409);
        // A prepared frame can still materialize old rules after a snapshot update.
        // Retry instead of claiming deletion while any worker or matching replay is pending.
        const pending=await repository.checkpoints.findOne({$or:[
          {lease_until:{$gt:Date.now()}},
          {'pending.events.rule.snapshot.counter_id':req.body?.counter_id},
          {'pending.coverage.assignment_id':{$in:Array.isArray(req.body?.rule_ids)?req.body.rule_ids:[]}}
        ]});
        if(pending)fail('consumer_busy','Finish pending observations before deleting records',503);
      });
      // Admissions resume; publication remains fenced until deletion finishes.
      return repository.flow.purge(req.body);
    });
  });
  app.get('/v1/behavior-statistics',async req=>{
    const allowed=new Set(['from','to','channel_id','zone_id','label_id','event_type','bucket','timezone','rule_id','trigger_id','group_by']);
    if(Object.keys(req.query).some(key=>!allowed.has(key)))fail('invalid_query','Unsupported statistics filter');
    return repository.behaviors.statistics(req.query);
  });
  app.get('/v1/behavior-events',async req=>{
    const allowed=new Set(['from','to','channel_id','zone_id','label_id','event_type','limit','cursor','rule_id','trigger_id']);
    if(Object.keys(req.query).some(key=>!allowed.has(key)))fail('invalid_query','Unsupported behavior filter');
    return repository.behaviors.list({...req.query,limit:req.query.limit===undefined?50:Number(req.query.limit)});
  });
  app.get('/v1/behavior-events/:id',async req=>repository.behaviors.get(req.params.id));
  app.get('/v1/behavior-events/:id/evidence',async req=>{
    if(Object.keys(req.query).length)fail('invalid_query','Unsupported evidence query');
    await repository.behaviors.get(req.params.id);
    return {schema_version:'1.0',...(repository.evidenceVault?await repository.evidenceVault.metadata(req.params.id):{state:'not_configured'})};
  });
  app.get('/v1/behavior-events/:id/evidence/image',async(req,reply)=>{
    if(Object.keys(req.query).some(k=>k!=='variant'))fail('invalid_query','Unsupported evidence query');
    await repository.behaviors.get(req.params.id);
    if(!repository.evidenceVault)fail('evidence_unavailable','Evidence retention not configured',404);
    const data=await repository.evidenceVault.image(req.params.id,req.query.variant??'processed');
    return reply.header('Cache-Control','private, no-store').type('image/jpeg').send(data);
  });
  app.get('/v1/events',async req=>{
    const allowed=new Set(['status','channel_id','review','disposition','from','to','zone_id','behavior','locations','analytics','limit','cursor']);
    if(Object.keys(req.query).some(k=>!allowed.has(k)))fail('invalid_query','Unsupported alarm filter');
    return repository.list({...req.query,limit:req.query.limit===undefined?50:Number(req.query.limit)});
  });
  app.get('/v1/events/summary',async()=>repository.pendingSummary());
  app.post('/v1/events/statistics',async req=>repository.statistics(req.body));
  app.post('/v1/events/analytics',{bodyLimit:16384},async req=>repository.analytics(req.body));
  app.post('/v1/events/purge',async req=>{
    if(!req.body||Object.keys(req.body).length!==1||req.body.scope!=='all')fail('invalid_request','Explicit all scope required');
    const who=actor(req),key=identity(req.headers['idempotency-key'],'Idempotency-Key');
    return observationBarrier(repository).configure(()=>observationBarrier(repository).drain(()=>repository.clearAll(who,key)));
  });
  app.get('/v1/events/:id',async req=>repository.get(req.params.id));
  app.get('/v1/events/:id/logs',async req=>({items:(await repository.get(req.params.id)).logs}));
  app.post('/v1/events/:id/acknowledgements',async req=>repository.confirm(req.params.id,req.body,actor(req),identity(req.headers['idempotency-key'],'Idempotency-Key')));
  app.post('/v1/bulk-acknowledgements',async req=>{
    const who=actor(req),key=identity(req.headers['idempotency-key'],'Idempotency-Key'),body=req.body;
    if(!body||!Array.isArray(body.items)||!body.items.length||body.items.length>200)fail('invalid_batch','Select 1..200 alarms');
    const ids=new Set();for(const item of body.items){identity(item.alarm_id,'alarm_id');if(ids.has(item.alarm_id))fail('duplicate_item','Duplicate alarm');ids.add(item.alarm_id);}
    const items=[];
    for(const item of body.items){try{items.push({alarm_id:item.alarm_id,...await repository.confirm(item.alarm_id,{expected_handling_revision:item.expected_handling_revision,note:body.note??'',...(body.disposition!==undefined?{disposition:body.disposition}:{})},who,key)});}
      catch(e){items.push({alarm_id:item.alarm_id,outcome:e instanceof DomainError?e.code:'failed',retryable:!(e instanceof DomainError)||e.status===503});}}
    return {items};
  });
  app.get('/v1/rules',async req=>({items:await repository.listRules(req.query.channel_id)}));
  app.get('/v1/configuration/rules',async()=>repository.ruleSnapshots.status());
  app.post('/v1/configuration/rules',async req=>observationBarrier(repository).configure(()=>repository.ruleSnapshots.apply(req.body,actor(req))));
  app.post('/v1/rules',async(req,reply)=>reply.code(405).header('Allow','GET').send({error:{code:'configuration_authority',message:'Save monitors in the configuration service; direct rule writes are disabled'}}));
  app.post('/v1/dry-runs',async req=>{
    actor(req);const body=req.body;
    if(!body||!Array.isArray(body.frames)||body.frames.length<1||body.frames.length>200||!Array.isArray(body.rules)||body.rules.length>32)fail('invalid_dry_run','Bounded frames and rules required');
    let checkpoint=null;const events=[],issues=[];
    for(const f of body.frames){const result=evaluate(checkpoint,f,body.rules);checkpoint=result.checkpoint;events.push(...result.events);issues.push(...result.issues);}
    return {dry_run:true,events,issues}; // Intentionally no repository writes.
  });
  return app;
}
