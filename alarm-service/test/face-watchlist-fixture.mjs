import {faceCandidateIdentity} from '../src/face-watchlist-candidate.mjs';
export function candidate(patch={}){
 const value={kind:'face_watchlist_candidate',event_kind:'face_watchlist',review_required:true,semantics_version:'faces-watchlist-v1',
  channel_id:'11111111-1111-4111-a111-111111111111',recording_channel_id:'11111111-1111-4111-a111-111111111111',processor_id:'ai-face',
  session_id:'session',track_id:'track',frame_id:'session:1',source_pts_ns:'1000000000',source_frame_index:'1',occurred_at:'2026-11-12T12:00:00.000Z',
  record_id:'22222222-2222-4222-a222-222222222222',photo_ref:'22222222-2222-4222-a222-222222222222',
  library_id:'33333333-3333-4333-a333-333333333333',library_version:7,library_name:'发生时名单',member_id:'44444444-4444-4444-a444-444444444444',member_name:'发生时姓名',
  model:'mbf',space_id:'a'.repeat(64),similarity:.91,threshold:.85,accuracy_verified:false,...patch};
 return {...value,event_id:faceCandidateIdentity(value)};
}
export const acknowledged=c=>({acknowledged:true,record_id:c.record_id,event_id:c.event_id});
