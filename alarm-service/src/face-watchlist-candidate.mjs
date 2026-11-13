import {digest} from './domain.mjs';

const fields=['event_id','kind','event_kind','review_required','semantics_version','channel_id','processor_id','session_id','track_id','frame_id','source_pts_ns','source_frame_index','occurred_at','record_id','photo_ref','library_id','library_version','library_name','member_id','member_name','model','space_id','recording_channel_id','similarity','threshold','accuracy_verified'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pin=/^[a-f0-9]{64}$/;
const text=(v,max,empty=false)=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const invalid=()=>{throw Error('invalid_face_candidate');};
export function faceCandidateIdentity(c){return digest(['faces-watchlist-v1',c.channel_id,c.session_id,c.track_id||c.frame_id,c.library_id,c.library_version,c.member_id]);}
export function validateFaceCandidate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))invalid();
 let encoded;try{encoded=JSON.stringify(value);}catch{invalid();}
 if(Buffer.byteLength(encoded)>8192)invalid();
 const c=structuredClone(value);
 if(c.kind!=='face_watchlist_candidate'||c.event_kind!=='face_watchlist'||c.review_required!==true||c.semantics_version!=='faces-watchlist-v1'||c.accuracy_verified!==false)invalid();
 for(const key of ['channel_id','record_id','photo_ref','library_id','member_id'])if(typeof c[key]!=='string'||!uuid.test(c[key]))invalid();
 if(c.photo_ref!==c.record_id||(c.recording_channel_id!==null&&(typeof c.recording_channel_id!=='string'||!uuid.test(c.recording_channel_id))))invalid();
 if(!text(c.session_id,128)||!text(c.track_id,128,true)||!text(c.frame_id,256)||
   !text(c.processor_id,128))invalid();
 for(const key of ['library_name','member_name'])if(c[key]!==undefined&&!text(c[key],256))invalid();
 for(const key of ['source_pts_ns','source_frame_index'])if(typeof c[key]!=='string'||!/^\d{1,20}$/.test(c[key]))invalid();
 if(!Number.isSafeInteger(c.library_version)||c.library_version<1||!['mbf','r50'].includes(c.model)||typeof c.space_id!=='string'||!pin.test(c.space_id))invalid();
 if(!Number.isFinite(c.similarity)||c.similarity< -1||c.similarity>1||!Number.isFinite(c.threshold)||c.threshold< -1||c.threshold>1||c.similarity<c.threshold)invalid();
 if(typeof c.occurred_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(c.occurred_at)||!Number.isFinite(Date.parse(c.occurred_at)))invalid();
 if(typeof c.event_id!=='string'||!pin.test(c.event_id)||c.event_id!==faceCandidateIdentity(c))invalid();
 return c;
}
export function makeFaceWatchlistAlarm(value){
 const c=validateFaceCandidate(value),id=digest(['face-watchlist',c.event_id]),at=new Date(c.occurred_at).toISOString();
 const rule={id:`face-library:${c.library_id}`,version:c.library_version,name:c.library_name??'人脸名单候选',event_kind:'face_watchlist',
   library_id:c.library_id,library_version:c.library_version,member_id:c.member_id,
   ...(c.library_name!==undefined?{library_name:c.library_name}:{}),...(c.member_name!==undefined?{member_name:c.member_name}:{}),
   model:c.model,space_id:c.space_id,threshold:c.threshold,review_required:true,accuracy_verified:false,review:{enabled:false}};
 return {schema_version:'1.0',alarm_id:id,dedup_key:id,event_kind:'face_watchlist',incident_scope:'face',identity_kind:'face',
   // Alarm channel identity is the AI processor; the output/recording channel
   // belongs to the immutable face record and must not masquerade as an input.
   channel_id:c.processor_id,input_stream_id:null,stream_session_id:c.session_id,track_ids:c.track_id?[c.track_id]:[],
   trigger_id:rule.id,rule:{id:rule.id,version:rule.version,name:rule.name,snapshot:rule},behavior:'appearance',severity:'warning',
   occurred_at:at,last_seen_at:at,frame_id:c.frame_id,source_pts_ns:c.source_pts_ns,direction:null,
   model_snapshot:{id:c.model,space_id:c.space_id},
   analysis_evidence:{face:c,observation_mode:'face_candidate',engine_semantics:c.semantics_version,source_frame_index:c.source_frame_index},
   lifecycle:{state:'ended',end_reason:'discrete_trigger'},review:{state:'skipped',attempt:0,reason:'face_watchlist_manual_review',policy:{enabled:false}},
   handling:{state:'unacknowledged',revision:0,disposition:'unset'},
   // An immutable BFF-owned photo reference, not a downloaded/pinned crop or a URL.
   evidence:{state:'referenced',refs:[{kind:'face_record',record_id:c.record_id,photo_ref:c.photo_ref,frame_id:c.frame_id}]},version:1};
}
