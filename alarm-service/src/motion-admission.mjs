import {digest,fail,identity,integerText} from './domain.mjs';
import {createBffTransport} from './vehicle-transport.mjs';

export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
 Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const canonicalDigest=value=>digest(canonical(value));
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const compare=(a,b)=>a.localeCompare(b);
export const orderedScopes=scopes=>[...scopes].sort((a,b)=>compare(a.input_stream_id,b.input_stream_id)||compare(a.channel_id,b.channel_id));
export function validateMotionMetadata(meta,rawRules){
 if(meta===undefined)return null;
 if(!meta||meta.protocol!==1||Object.keys(meta).some(k=>!['protocol','scopes'].includes(k))||!Array.isArray(meta.scopes)||meta.scopes.length>5000)
  fail('invalid_motion_metadata','Invalid motion admission metadata');
 const seen=new Set();
 const scopes=meta.scopes.map(s=>{
  if(!s||Object.keys(s).sort().join(',')!=='channel_id,execution_digest,guard_epoch,input_stream_id')fail('invalid_motion_scope','Invalid motion scope');
  identity(s.input_stream_id,'input_stream_id');identity(s.channel_id,'channel_id');
  const key=JSON.stringify([s.input_stream_id,s.channel_id]);
  const rules=rawRules.filter(r=>r.input_stream_id===s.input_stream_id&&r.channel_id===s.channel_id).sort((a,b)=>compare(a.id,b.id));
  if(seen.has(key)||!hex(s.guard_epoch)||!hex(s.execution_digest)||!rules.length||canonicalDigest(rules)!==s.execution_digest)
   fail('invalid_motion_scope','Duplicate scope or raw execution digest mismatch');
  seen.add(key);return {...s};
 });
 return {protocol:1,scopes:orderedScopes(scopes)};
}
export const motionStatus=meta=>meta?{protocol:1,scopes_digest:canonicalDigest(orderedScopes(meta.scopes))}:null;
export function createMotionAdmission(bootstrap){
 const request=createBffTransport(bootstrap);
 return {admit:body=>request('/api/internal/ptz-motion/admit',body,{timeoutMs:2000,maxBytes:16384})};
}
const unavailable=reason=>fail('motion_admission_required',reason,503);
export function validatePermit(permit,input){
 if(!permit||permit.protocol!==1||typeof permit.authorized_at!=='string'||!Number.isFinite(Date.parse(permit.authorized_at))||
  ['frame_digest','producer_id','offset','channel_id','input_stream_id','guard_epoch','execution_digest'].some(k=>permit[k]!==input[k]))
  unavailable('Motion permit does not match the immutable input');
 return structuredClone(permit);
}
export async function admitFrame(transport,scope,envelope,fingerprint){
 const f=envelope.frame;
 integerText(f.source_frame_index,'source_frame_index');
 const input={protocol:1,producer_id:envelope.producer_id,offset:envelope.offset,frame_digest:fingerprint,
  channel_id:f.channel_id,input_stream_id:f.input_stream_id,stream_session_id:f.stream_session_id,
  source_frame_index:f.source_frame_index,captured_at:f.captured_at,
  guard_epoch:scope.guard_epoch,execution_digest:scope.execution_digest};
 if(!transport?.admit)unavailable('Motion admission transport unavailable');
 let result;try{result=await transport.admit(input);}catch{unavailable('Motion admission authority unavailable');}
 if(result?.decision!=='permit')unavailable('Motion admission not granted');
 return {input,permit:validatePermit(result.permit,input)};
}
export function validatePendingPermit(p,channel,producer){
 const input=p.motion_input;
 if(!input||input.frame_digest!==p.fingerprint||input.offset!==p.offset||input.producer_id!==producer||input.channel_id!==channel)
  unavailable('Prepared outcome has no matching motion admission; explicit migration required');
 validatePermit(p.motion_permit,input);
}
