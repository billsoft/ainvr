export function createVehicleTransport(bootstrap){
 const base=new URL(bootstrap.control_url);
 if(base.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal','[::1]'].includes(base.hostname))throw Error('local_vehicle_transport_required');
 async function request(path,body){
  let r;try{r=await fetch(new URL(path,base),{method:body?'POST':'GET',redirect:'error',headers:{'x-service-token':bootstrap.service_token,...(body?{'content-type':'application/json'}:{})},signal:AbortSignal.timeout(body?31000:5000),body:body?JSON.stringify(body):undefined});}
  catch{throw Object.assign(Error('vehicle_transport_unavailable'),{code:'vehicle_transport_unavailable'});}
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536)throw Error('vehicle_result_too_large');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('vehicle_invalid_response');}
  if(!r.ok){const code=typeof data.error?.code==='string'&&/^[a-z_]{1,80}$/.test(data.error.code)?data.error.code:'vehicle_service_unavailable';throw Object.assign(Error(code),{code,status:r.status});}
  return data;
 }
 const invoke=(meta,jpeg)=>request('/api/internal/vehicle-recognize',{meta,jpeg:jpeg.toString('base64')});
 invoke.watchlist=version=>request('/api/internal/vehicle-watchlist/'+version);
 return invoke;
}
