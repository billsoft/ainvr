import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingEvidence} from '../src/recording-evidence.mjs';
const row={channel_id:'processor',stream_session_id:'session',analysis_evidence:{source:{width:7680,height:4320}}};
const sample={source_pts_ns:'100',source_frame_index:'42',track_id:'session:1',captured_at:'2026-10-30T00:00:00Z'};
test('recording fallback sends and verifies the exact source frame index',async t=>{
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  const identity=JSON.parse(init.body);assert.equal(identity.source_frame_index,'42');
  return Response.json({identity,provenance:{kind:'recording_exact_sei_v1',geometry:{method:'full_frame_axis_scale'}},jpeg_base64:'/9j/2Q=='});
 });
 const recover=createRecordingEvidence({control_url:'http://127.0.0.1:3001',service_token:'test'});
 assert.equal((await recover(row,sample)).provenance.geometry.method,'full_frame_axis_scale');
});
test('recording failure exposes only bounded known reason codes',async t=>{
 let code='recording_geometry_unverified';
 t.mock.method(globalThis,'fetch',async()=>Response.json({detail:code}, {status:409}));
 const recover=createRecordingEvidence({control_url:'http://127.0.0.1:3001',service_token:'test'});
 await assert.rejects(recover(row,sample),{message:'recording_geometry_unverified'});
 code='recording_not_found';await assert.rejects(recover(row,sample),{message:'recording_not_found'});
 code='secret /home/private camera:password';await assert.rejects(recover(row,sample),{message:'recording_evidence_unavailable'});
});
