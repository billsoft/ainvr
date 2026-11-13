import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {fail} from './domain.mjs';

export const isRegionFact=fact=>!!fact?.analysis_evidence?.region_state;
function frames(fact){
 const delivery=fact.analysis_evidence?.delivery;
 if(delivery?.state!=='complete'||!Array.isArray(delivery.frames)||delivery.frames.length<2||delivery.frames.length>3)return [];
 const valid=delivery.frames.every(f=>f.identity_kind==='region'&&f.observation==='region'&&typeof f.frame_id==='string'
  &&/^[a-f0-9]{64}$/.test(f.key)&&/^[a-f0-9]{64}$/.test(f.content_sha256)&&['mongodb','ssd'].includes(f.storage)
  &&Number.isInteger(f.width)&&f.width>0&&Number.isInteger(f.height)&&f.height>0&&Number.isSafeInteger(f.count)&&f.count>=0
  &&Number.isFinite(Date.parse(f.captured_at)));
 return valid&&new Set(delivery.frames.map(f=>f.frame_id)).size===delivery.frames.length?delivery.frames:[];
}
export async function regionEvidenceMetadata(context,fact){
 const refs=frames(fact);
 if(!context||refs.length<2)return {state:'unavailable',reason:'frame_identity_unavailable'};
 let expires=Date.parse(fact.occurred_at)+(context.policy?.retention_days??7)*86400000;
 if(!Number.isFinite(expires)||expires<=Date.now())return {state:'unavailable',reason:'retention'};
 for(const ref of refs){
  if(ref.storage==='mongodb'){
   const meta=await context.images?.metadata('context',ref.key);
   if(!meta||meta.sha256!==ref.content_sha256)return {state:'unavailable',reason:'stored_file_missing'};
   expires=Math.min(expires,Number(new Date(meta.expires_at)));
  }else{try{await readRegionFrame(context,fact,ref);}catch{return {state:'unavailable',reason:'stored_file_missing'};}}
 }
 if(!Number.isFinite(expires)||expires<=Date.now())return {state:'unavailable',reason:'retention'};
 const last=refs.at(-1),region=fact.analysis_evidence.review_context?.region;
 return {state:'available',evidence:{kind:'region_frame',variants:['processed'],image_width:last.width,image_height:last.height,
  pinned:true,retention:'alarm',expires_at:new Date(expires).toISOString(),
  frames:refs.map(f=>({frame_id:f.frame_id,captured_at:f.captured_at,count:f.count})),
  region:region?.points?{points:region.points,erp_wrap:region.erp_wrap===true}:null}};
}
async function readRegionFrame(context,fact,ref){
 // A retained-evidence read never repopulates from a live frame or rolling spool.
 let data;
 if(ref.storage==='mongodb')data=await context.images?.get('context',ref.key);
 else{
  const file=await open(join(context.root,'pinned',ref.key+'.jpg'),'r');
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024**2)throw Error('invalid_evidence_size');data=await file.readFile();}
  finally{await file.close();}
 }
 if(!data||data.length<4||data.length>8*1024**2||createHash('sha256').update(data).digest('hex')!==ref.content_sha256)throw Error('evidence_integrity_mismatch');
 return data;
}
export async function regionEvidenceImage(context,fact,variant='processed',frameId){
 if(variant!=='processed'&&variant!=='original')fail('invalid_variant','Invalid image variant');
 const meta=await regionEvidenceMetadata(context,fact);
 if(meta.state!=='available')fail('evidence_unavailable','Region source evidence unavailable',404);
 const refs=frames(fact),ref=frameId===undefined?refs.at(-1):refs.find(f=>f.frame_id===frameId);
 if(!ref)fail('invalid_frame','Frame does not belong to this event',404);
 return readRegionFrame(context,fact,ref);
}
