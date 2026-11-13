import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmEvidenceRoutes} from '../routes/alarmEvidenceRoutes.js';
const id='a'.repeat(64),json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const fact={event_id:id,track_id:null,label_id:null,analysis_evidence:{region_state:{semantics:'region-state-v1'}}};
const metadata={state:'available',evidence:{kind:'region_frame',variants:['processed'],image_width:1920,image_height:1080,pinned:true,retention:'alarm',expires_at:'2099-01-01T00:00:00Z',frames:[{frame_id:'f1',captured_at:'2026-11-12T00:00:00Z',count:0},{frame_id:'f2',captured_at:'2026-11-12T00:00:01Z',count:0}],region:{points:[[.1,.1],[.9,.1],[.9,.9]],erp_wrap:false}}};
async function app(){const a=Fastify();await a.register(alarmEvidenceRoutes,{connection:async()=>({baseUrl:'http://127.0.0.1:9111',apiToken:'fixture-'.repeat(8),timeoutMs:2000}),aiConnection:async()=>{throw Error('Region must not call target crop');},principal:async()=> 'operator'});return a;}
it('region with no target identity uses retained full-frame evidence and selected exact frame',async()=>{
 const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json(metadata));const a=await app();
 try{
  const r=await a.inject(`/alarms/behavior-events/${id}/evidence`);expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject(metadata);
  mock.mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}));
  const image=await a.inject(`/alarms/behavior-events/${id}/evidence/image?frame=f1`);expect(image.statusCode).toBe(200);
  expect(new URL(String(mock.mock.calls.at(-1)![0])).searchParams.get('frame')).toBe('f1');
  expect(mock.mock.calls.every(([url])=>String(url).startsWith('http://127.0.0.1:9111/'))).toBe(true);
 }finally{mock.mockRestore();await a.close();}
});
it('region rejects another event frame and expired evidence without live fallback',async()=>{
 const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json(metadata));const a=await app();
 try{
  expect((await a.inject(`/alarms/behavior-events/${id}/evidence/image?frame=other`)).statusCode).toBe(422);
  mock.mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'unavailable',reason:'retention'}));
  expect((await a.inject(`/alarms/behavior-events/${id}/evidence/image`)).statusCode).toBe(404);
  expect(mock).toHaveBeenCalledTimes(4);
 }finally{mock.mockRestore();await a.close();}
});
