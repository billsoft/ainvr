import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';

const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const motionDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export interface MotionScope {input_stream_id:string;channel_id:string;guard_epoch:string;execution_digest:string}
export interface MotionSnapshot {schema_version:string;revision:string;rules:unknown[];motion_admission?:{protocol:1;scopes:MotionScope[]}}
type Guard={resource:string;epoch:string;sources:string[];moving:boolean};
const epoch=(guards:Guard[])=>createHash('sha256').update(guards.map(g=>`${g.resource}:${g.epoch}`).sort().join('|')).digest('hex');
export const orderedScopes=(scopes:MotionScope[])=>[...scopes].sort((a,b)=>a.input_stream_id.localeCompare(b.input_stream_id)||a.channel_id.localeCompare(b.channel_id));
const id=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/),integer=z.string().regex(/^\d{1,30}$/);
export const motionRequest=z.object({protocol:z.literal(1),producer_id:id,offset:integer,frame_digest:hash,
 channel_id:id,input_stream_id:id,stream_session_id:id,source_frame_index:integer,captured_at:z.string().datetime({offset:true}),
 guard_epoch:hash,execution_digest:hash}).strict();

/** A short PG authorization precedes immutable evaluation, never Mongo/network I/O under its lock. */
export class PtzMotionAdmission {
 private readonly publications=new WeakMap<MotionSnapshot,{resource:string;source_digest:string;eligible:boolean}[]>();
 constructor(private pool:Pool){}
 private async transaction<T>(action:(c:PoolClient,revision:string,guards:Guard[])=>Promise<T>){
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("SET LOCAL lock_timeout='500ms'");
   await c.query("SET LOCAL statement_timeout='1500ms'");
   const {rows:[row]}=await c.query('SELECT revision::text FROM alarm_configuration_revision WHERE singleton FOR UPDATE');
   if(!row)throw Error('Motion protection configuration unavailable');
   const {rows}=await c.query(`SELECT resource_key AS resource,revision::text AS epoch,source_ids AS sources,
    stop_pending AS moving FROM ptz_view_guards WHERE blocked OR restored_at IS NOT NULL`);
   const result=await action(c,row.revision,rows);
   await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async snapshot(source:{snapshot():Promise<MotionSnapshot>}):Promise<MotionSnapshot>{
  for(let attempt=0;attempt<3;attempt++){
   const s=await source.snapshot();
   const saved=await this.transaction(async(c,revision,guards)=>{
    if(revision!==s.revision)return null;
    const groups=new Map<string,{source:string;channel:string;rules:any[];guards:Guard[]}>();
    for(const raw of s.rules){
     const r=raw as any;if(!r.input_stream_id)continue; // Legacy bindings retain the synchronous path.
     const relevant=guards.filter(g=>g.sources.includes(r.input_stream_id));if(!relevant.length)continue;
     const key=JSON.stringify([r.input_stream_id,r.channel_id]);
     let group=groups.get(key);
     if(!group){group={source:r.input_stream_id,channel:r.channel_id,rules:[],guards:relevant};groups.set(key,group);}
     group.rules.push(r);
    }
    const scopes:MotionScope[]=[];
    for(const group of groups.values()){
     const item={input_stream_id:group.source,channel_id:group.channel,guard_epoch:epoch(group.guards),
      execution_digest:motionDigest(group.rules.sort((a,b)=>a.id.localeCompare(b.id)))};
     await c.query(`INSERT INTO ptz_motion_scopes(source_id,processor_id,guard_epoch,execution_digest,snapshot_revision,allowed)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,processor_id) DO UPDATE SET
      guard_epoch=$3,execution_digest=$4,snapshot_revision=$5,allowed=$6,updated_at=clock_timestamp()`,
      [item.input_stream_id,item.channel_id,item.guard_epoch,item.execution_digest,revision,group.rules.some(r=>r.state==='enabled')]);
     scopes.push(item);
    }
    // A legacy rule cannot be attributed to a protected source reliably. Keep
    // its execution unchanged, but revoke fast-motion eligibility for every
    // guard until a legacy-free snapshot has actually been acknowledged.
    // Checking only current PG rules in ready() misses PG-disable/Mongo-old lag.
    const eligible=!s.rules.some(raw=>{const r=raw as any;return r.state==='enabled'&&!r.input_stream_id;});
    const fences=[];
    for(const g of guards){
     const source_digest=motionDigest([...g.sources].sort());
     await c.query(`INSERT INTO ptz_motion_guard_installations(resource_key,source_digest,snapshot_revision)
      VALUES($1,$2,$3) ON CONFLICT(resource_key) DO UPDATE SET source_digest=$2,snapshot_revision=$3,
      installed=ptz_motion_guard_installations.installed AND ptz_motion_guard_installations.source_digest=$2 AND $4::boolean`,[g.resource,source_digest,revision,eligible]);
     fences.push({resource:g.resource,source_digest,eligible});
    }
    const published={...s,motion_admission:{protocol:1 as const,scopes:orderedScopes(scopes)}};
    this.publications.set(published,fences);return published;
   });
   if(saved)return saved;
  }
  throw Error('Motion protection changed during publication');
 }
 async acknowledge(snapshot:MotionSnapshot,ack:unknown){
  const meta=snapshot.motion_admission,a=ack as any;
  if(!meta||a?.protocol!==1||a.scopes_digest!==motionDigest(meta.scopes))return;
  await this.transaction(async(c,_revision,_guards)=>{
   for(const s of meta.scopes)await c.query(`UPDATE ptz_motion_scopes SET installed=true
    WHERE source_id=$1 AND processor_id=$2 AND guard_epoch=$3 AND execution_digest=$4 AND snapshot_revision=$5`,
    [s.input_stream_id,s.channel_id,s.guard_epoch,s.execution_digest,snapshot.revision]);
   for(const g of this.publications.get(snapshot)??[])if(g.eligible)await c.query(`UPDATE ptz_motion_guard_installations SET installed=true
    WHERE resource_key=$1 AND source_digest=$2 AND snapshot_revision=$3`,[g.resource,g.source_digest,snapshot.revision]);
  });
 }
 async ready(sources:string[],processors:string[]){
  return this.transaction(async(c,_revision,guards)=>{
   // A complete source-set installation, including empty aliases, proves old
   // Mongo execution has been replaced. Another alias's ACK is not sufficient.
   const installed=(await c.query('SELECT resource_key,source_digest FROM ptz_motion_guard_installations WHERE installed')).rows;
   if(!sources.length||sources.some(source=>!guards.some(g=>g.sources.includes(source)&&installed.some(i=>
    i.resource_key===g.resource&&i.source_digest===motionDigest([...g.sources].sort())))))return false;
   // Legacy bindings do not carry a trusted source identity and cannot use admission yet.
   if((await c.query(`SELECT 1 FROM alarm_triggers t CROSS JOIN LATERAL jsonb_array_elements(t.document->'bindings') b
    WHERE t.document->>'state'='enabled' AND (b->>'input_stream_id'=ANY($1::text[]) OR b->>'channel_id'=ANY($2::text[]) OR
      (COALESCE(b->>'input_stream_id','')='' AND b->>'channel_id'=ANY($1::text[]))) LIMIT 1`,[sources,processors])).rowCount)return false;
   const {rows}=await c.query(`SELECT source_id,processor_id FROM (
    SELECT source_id,compiled_rule->>'channel_id' AS processor_id FROM alarm_trigger_assignments WHERE active AND compiled_rule IS NOT NULL
    UNION SELECT source_id,compiled_rule->>'channel_id' AS processor_id FROM flow_counter_bindings WHERE active AND compiled_rule IS NOT NULL
   ) r WHERE source_id=ANY($1::text[]) AND processor_id=ANY($2::text[])`,[sources,processors]);
   for(const r of rows)if(!(await c.query('SELECT 1 FROM ptz_motion_scopes WHERE source_id=$1 AND processor_id=$2 AND installed',[r.source_id,r.processor_id])).rowCount)return false;
   return true;
  });
 }
 async admit(input:unknown){
  const r=motionRequest.parse(input);
  return this.transaction(async(c,revision,guards)=>{
   const {rows:[scope]}=await c.query('SELECT * FROM ptz_motion_scopes WHERE source_id=$1 AND processor_id=$2',[r.input_stream_id,r.channel_id]);
   const relevant=guards.filter(g=>g.sources.includes(r.input_stream_id));
   if(!scope?.installed||!scope.allowed||String(scope.snapshot_revision)!==revision||!relevant.length||relevant.some(g=>g.moving)||
      scope.guard_epoch!==r.guard_epoch||epoch(relevant)!==r.guard_epoch||scope.execution_digest!==r.execution_digest)
    return {decision:'retry' as const,reason:'motion_scope_not_current'};
   return {decision:'permit' as const,permit:{protocol:1 as const,frame_digest:r.frame_digest,producer_id:r.producer_id,
    offset:r.offset,channel_id:r.channel_id,input_stream_id:r.input_stream_id,guard_epoch:r.guard_epoch,
    execution_digest:r.execution_digest,authorized_at:new Date().toISOString()}};
  });
 }
}
