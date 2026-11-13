import {createBffTransport} from './vehicle-transport.mjs';
export function createFaceWatchlistTransport(bootstrap){
 const request=createBffTransport(bootstrap);
 return {
  poll:(limit,signal)=>{
   if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_face_poll_limit');
   return request(`/api/internal/faces/watchlist-outbox?limit=${limit}`,undefined,{signal,timeoutMs:5000,maxBytes:512*1024});
  },
  ack:(candidate,signal)=>request('/api/internal/faces/watchlist-outbox/ack',
   {record_id:candidate.record_id,event_id:candidate.event_id},{signal,timeoutMs:5000,maxBytes:4096}),
 };
}
