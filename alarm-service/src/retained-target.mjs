// Reuse the alarm vault's exact-frame binding. Never use an enhanced image or
// another stage's crop as visual proof for the current alarm claim.
import {createHash} from 'node:crypto';
export async function retainedTarget(vault,row){
 const id=row.review?.evidence_id??row.behavior_event_ids?.[0];
 if(!vault||!/^[a-f0-9]{64}$/.test(id??'')||!row.behavior_event_ids?.includes(id))throw Error('missing_context');
 const meta=await vault.metadata(id),e=meta?.evidence,source=row.analysis_evidence?.source;
 if(['pending','not_queued'].includes(meta?.state))throw Error('evidence_pending');
 if(meta?.state!=='available'||!e?.variants?.includes('original'))throw Error('missing_context');
 if(e.kind!=='target_crop'||e.channel_id!==row.channel_id||e.stream_session_id!==row.stream_session_id||
  e.track_id!==row.track_ids?.[0]||e.source_pts_ns!==row.source_pts_ns||
  e.source_frame_index!==row.analysis_evidence?.source_frame_index||e.frame_width!==source?.width||e.frame_height!==source?.height||
  (e.label_id&&e.label_id!==row.analysis_evidence?.track?.label_id))throw Error('evidence_identity_mismatch');
 if(!Number.isInteger(e.image_width)||!Number.isInteger(e.image_height)||e.image_width<32||e.image_height<32)throw Error('insufficient_target_pixels');
 const label=(row.rule?.snapshot?.labels??row.analysis_evidence?.review_context?.labels)?.find(l=>l.label_id===row.analysis_evidence?.track?.label_id)?.name;
 if(!label)throw Error('missing_label');
 const data=await vault.image(id,'original');
 return {data,width:e.image_width,height:e.image_height,label,event_id:id,sha256:createHash('sha256').update(data).digest('hex')};
}
