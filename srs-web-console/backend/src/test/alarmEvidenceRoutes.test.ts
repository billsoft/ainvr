import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {alarmEvidenceRoutes} from '../routes/alarmEvidenceRoutes.js';
const id='a'.repeat(64),token='operator-'.repeat(8),fact={event_id:id,channel_id:'channel',stream_session_id:'session',track_id:'track',label_id:'person',source_pts_ns:'9007199254740993',source_frame_index:'9007199254740995',analysis_evidence:{source:{width:3840,height:2160}}};
const evidence={state:'available',evidence:{kind:'target_crop',image_id:'exact-image',channel_id:'channel',stream_session_id:'session',track_id:'track',label_id:'person',source_pts_ns:fact.source_pts_ns,source_frame_index:fact.source_frame_index,frame_width:3840,frame_height:2160,image_width:320,image_height:240,variants:['processed','original']}};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(principal=async()=> 'operator' as string|null){const app=Fastify();await app.register(alarmEvidenceRoutes,{connection:async()=>({baseUrl:'http://127.0.0.1:9111',apiToken:token,timeoutMs:2000}),aiConnection:async()=>({baseUrl:'http://127.0.0.1:8000',apiKey:'private-ai'}),principal,internalPrincipal:async req=>req.headers['x-service-token']==='alarm-only-token'});return app;}
it('resolves a stored fact first and forwards exact integer identities without leaking credentials',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'not_queued'})).mockResolvedValueOnce(json(evidence));const app=await fixture();
 try{
  const result=await app.inject(`/alarms/behavior-events/${id}/evidence`);expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({state:'available',evidence:{pinned:false,retention:'ai_history'}});
  const url=new URL(String(fetchMock.mock.calls[2]![0]));expect(url.searchParams.get('source_pts_ns')).toBe(fact.source_pts_ns);expect(url.searchParams.get('source_frame_index')).toBe(fact.source_frame_index);
  expect(result.body).not.toContain(token);expect(result.body).not.toContain('private-ai');expect(result.body).not.toContain('http://');
 }finally{fetchMock.mockRestore();await app.close();}
});
it('rejects cross-frame evidence and missing original identity rather than substituting a nearby image',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'not_queued'})).mockResolvedValueOnce(json({...evidence,evidence:{...evidence.evidence,source_pts_ns:'1'}}));const app=await fixture();
 try{
  expect((await app.inject(`/alarms/behavior-events/${id}/evidence`)).statusCode).toBe(503);
  fetchMock.mockResolvedValueOnce(json({...fact,source_frame_index:null}));
  const old=await app.inject(`/alarms/behavior-events/${id}/evidence`);expect(old.json()).toMatchObject({state:'unavailable',reason:'frame_identity_unavailable'});expect(fetchMock).toHaveBeenCalledTimes(4);
 }finally{fetchMock.mockRestore();await app.close();}
});
it('authenticated binary retrieval revalidates the fact and reports expired images',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'not_queued'})).mockResolvedValueOnce(json(evidence)).mockResolvedValueOnce(new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}));const app=await fixture();
 try{
  const image=await app.inject(`/alarms/behavior-events/${id}/evidence/image?variant=original`);expect(image.statusCode).toBe(200);expect(image.rawPayload).toEqual(Buffer.from([255,216,255,217]));expect(image.headers['cache-control']).toBe('private, no-store');
  fetchMock.mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'not_queued'})).mockResolvedValueOnce(json(evidence)).mockResolvedValueOnce(new Response(null,{status:404}));
  expect((await app.inject(`/alarms/behavior-events/${id}/evidence/image`)).statusCode).toBe(404);
 }finally{fetchMock.mockRestore();await app.close();}
});
it('unauthenticated and arbitrary URL queries never reach either service',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch'),app=await fixture(async()=>null);
 try{expect((await app.inject(`/alarms/behavior-events/${id}/evidence`)).statusCode).toBe(401);expect(fetchMock).not.toHaveBeenCalled();}finally{await app.close();fetchMock.mockRestore();}
 const configured=await fixture();try{expect((await configured.inject(`/alarms/behavior-events/${id}/evidence?url=http://example.com`)).statusCode).toBe(422);}finally{await configured.close();}
});

it('retained evidence is served by the alarm service after AI history disappeared; expired records never fall back to a live image',async()=>{
 const retained={...evidence,evidence:{...evidence.evidence,pinned:true,retention:'alarm',saved_at:'2026-10-19T01:00:00Z',expires_at:'2026-11-18T01:00:00Z'}}
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json(retained)).mockResolvedValueOnce(new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}}));const app=await fixture();
 try{
  const result=await app.inject(`/alarms/behavior-events/${id}/evidence/image`);expect(result.statusCode).toBe(200);
  expect(fetchMock.mock.calls.every(([url])=>String(url).startsWith('http://127.0.0.1:9111/'))).toBe(true);
  fetchMock.mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json({state:'unavailable',reason:'capacity'}));
  expect((await app.inject(`/alarms/behavior-events/${id}/evidence`)).json()).toMatchObject({state:'unavailable',reason:'capacity'});
  expect(fetchMock).toHaveBeenCalledTimes(5);
 }finally{fetchMock.mockRestore();await app.close();}
});
it('private source endpoint requires the alarm service identity and bypasses retained reads to avoid recursion',async()=>{
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(fact)).mockResolvedValueOnce(json(evidence));const app=await fixture();
 try{
  for(const headers of [{},{'x-service-token':'recorder-token'},{'x-console-token':'console-password-token'}])expect((await app.inject({url:`/internal/alarm-evidence/${id}`,headers})).statusCode).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
  const source=await app.inject({url:`/internal/alarm-evidence/${id}`,headers:{'x-service-token':'alarm-only-token'}});
  expect(source.statusCode).toBe(200);expect(source.json()).toMatchObject({evidence:{pinned:false,retention:'ai_history'}});expect(fetchMock).toHaveBeenCalledTimes(2);
 }finally{fetchMock.mockRestore();await app.close();}
});
