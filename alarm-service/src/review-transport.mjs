export function createReviewTransport(bootstrap){
 const target=new URL('/api/internal/alarm-review',bootstrap.control_url);
 if(target.protocol!=='http:'||!['localhost','127.0.0.1','host.docker.internal','[::1]'].includes(target.hostname))throw Error('Local review transport required');
 return async (body,{timeoutMs=120000}={})=>{
  const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.min(440000,timeoutMs)),headers:{'x-service-token':bootstrap.service_token,'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){
   let code;try{const raw=await response.text();if(raw.length<=65536)code=JSON.parse(raw)?.error?.code;}catch{}
   const permanent=new Set(['input_too_long','unsupported_image','invalid_request','insufficient_target_pixels','unvalidated_profile']);
   throw Error(permanent.has(code)?code:response.status===400||response.status===422?'invalid_request':'review_unavailable');
  }
  if(!response.body)throw Error('review_unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>2*1024*1024)throw Error('invalid_model_result');chunks.push(p.value)}}finally{await reader.cancel().catch(()=>{})}
  return JSON.parse(Buffer.concat(chunks).toString());
 };
}
