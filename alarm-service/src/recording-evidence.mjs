// The backend owns recorder credentials. No caller-supplied URL or file path.
export function createRecordingEvidence(bootstrap){
 const target=new URL('/api/internal/alarm-recording-evidence',bootstrap.control_url);
 return async(row,sample)=>{
  const identity={channel_id:row.channel_id,stream_session_id:row.stream_session_id,source_pts_ns:sample.source_pts_ns,track_id:sample.track_id,captured_at:sample.captured_at,width:row.analysis_evidence.source.width,height:row.analysis_evidence.source.height};
  const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(36000),headers:{'x-service-token':bootstrap.service_token,'content-type':'application/json'},body:JSON.stringify(identity)});
  if(!response.ok||!response.body)throw Error('recording_evidence_unavailable');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024)throw Error('recording_evidence_capacity');parts.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
  const result=JSON.parse(Buffer.concat(parts));
  if(Object.entries(identity).some(([k,v])=>result.identity?.[k]!==v)||result.provenance?.kind!=='recording_exact_sei_v1')throw Error('evidence_identity_mismatch');
  if(typeof result.jpeg_base64!=='string')throw Error('invalid_image');
  return {data:Buffer.from(result.jpeg_base64,'base64'),provenance:result.provenance};
 };
}
