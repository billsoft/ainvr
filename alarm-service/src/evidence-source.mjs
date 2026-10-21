// The BFF owns the AI credential; this narrow read API uses the alarm's own
// configuration-service identity, never a user's console password.
export function createEvidenceSource(bootstrap){
 const base=new URL(bootstrap.control_url);
 if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]','host.docker.internal'].includes(base.hostname)||!base.port||base.pathname!=='/'||base.username||base.password||base.search||base.hash||typeof bootstrap.service_token!=='string'||bootstrap.service_token.length<32)throw Error('Invalid evidence source bootstrap');
 const request=async(id,variant)=>{
  if(!/^[a-f0-9]{64}$/.test(id)||variant!==undefined&&!['original','processed'].includes(variant))throw Error('Invalid evidence request');
  const url=new URL(`/api/internal/alarm-evidence/${id}${variant?'/image':''}`,base);if(variant)url.searchParams.set('variant',variant);
  const response=await fetch(url,{headers:{'x-service-token':bootstrap.service_token},redirect:'error',signal:AbortSignal.timeout(variant?15000:10000)});
  if(!response.ok||!response.body||variant&&!response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg'))throw Error('Exact evidence source unavailable');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const p=await reader.read();if(p.done)break;total+=p.value.length;if(total>(variant?8*1024*1024:65536))throw Error('Evidence response too large');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
  const data=Buffer.concat(chunks);return variant?data:JSON.parse(data.toString('utf8'));
 };
 return {metadata:id=>request(id),image:(id,variant)=>request(id,variant)};
}
