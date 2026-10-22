export function createReviewTransport(bootstrap){
 const target=new URL('/api/internal/alarm-review',bootstrap.control_url);
 if(target.protocol!=='http:'||!['localhost','127.0.0.1','host.docker.internal','[::1]'].includes(target.hostname))throw Error('Local review transport required');
 return async body=>{
  const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(445000),headers:{'x-service-token':bootstrap.service_token,'content-type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){await response.body?.cancel();throw Error(response.status===422?'unsupported_image':'review_unavailable');}
  if(!response.body)throw Error('review_unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536)throw Error('invalid_model_result');chunks.push(p.value)}}finally{await reader.cancel().catch(()=>{})}
  return JSON.parse(Buffer.concat(chunks).toString());
 };
}
