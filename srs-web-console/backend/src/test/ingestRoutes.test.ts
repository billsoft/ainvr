import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ingestRoutes } from '../routes/ingest.js';
import { WhipSessions } from '../services/whipSessions.js';

const id = '2dd9af33-1e34-4f24-aabc-50933ea40e0e';
async function setup() {
  const app = Fastify();
  const secrets = new Map<string, string>([[`backend/ingest-publish/${id}`, 'camera-key']]);
  const channels = [{ id, upstreamProtocol: 'webrtc', inputGeneration: 'g1', app: 'live', streamName: 'whip_camera' }];
  await app.register(ingestRoutes, {
    channels: { read: async () => ({ channels }) } as any,
    settings: { read: async () => ({}) } as any,
    secrets: () => ({ getSecret: async (k: string) => secrets.get(k), setSecret: async (k: string, v: string) => secrets.set(k, v), deleteSecret: async (k: string) => secrets.delete(k) }) as any,
    token: 'internal-secret', workerUrl: 'http://worker:8120', srsUrl: 'http://srs:1985', srtEnabled: false,
  });
  return { app, channels, secrets };
}
describe('input publishing boundary', () => {
  it('does not create an orphan credential if the channel is deleted while waiting', async () => {
    const { app, channels, secrets } = await setup();
    const lock = vi.spyOn(WhipSessions.prototype, 'exclusive').mockImplementationOnce(
      async (_id, action) => { channels.splice(0); secrets.clear(); return await action(); });
    try {
      expect((await app.inject({ method: 'POST', url: `/api/channels/${id}/publish-credential` })).statusCode).toBe(400);
      expect(secrets.size).toBe(0);
    } finally { lock.mockRestore(); await app.close(); }
  });
  it('retains revocation ownership across a relay application restart', async () => {
    const data = new Map<string, string>();
    const pg = { getSecret: async (k: string) => data.get(k) ?? null,
      setSecret: async (k: string, v: string) => { data.set(k, v); },
      deleteSecret: async (k: string) => { data.delete(k); } };
    await new WhipSessions(() => pg, 'http://srs:1985').set(id,
      { key: 'owned', path: '/rtc/v1/whip/?action=delete&token=test', credential: 'hash' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await new WhipSessions(() => pg, 'http://srs:1985').terminate(id);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(data.size).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
  it('selects HEVC upstream for an H.265-only offer', async () => {
    const { app } = await setup();
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('v=0', {status: 201,
      headers: { location: '/rtc/v1/whip/?action=delete&token=session' }}));
    try {
      expect((await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: {
        authorization: 'Bearer camera-key', 'content-type': 'application/sdp' },
        payload: 'a=rtpmap:96 H265/90000\r\n' })).statusCode).toBe(201);
      expect(String(mock.mock.calls[0][0])).toContain('codec=hevc');
    } finally { mock.mockRestore(); await app.close(); }
  });
  it('does not claim revocation succeeded when the active session could not be terminated', async () => {
    const { app, secrets } = await setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('v=0', { status: 201, headers: { location: '/rtc/v1/whip/?action=delete&token=session' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    try {
      await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: { authorization: 'Bearer camera-key', 'content-type': 'application/sdp' }, payload: 'a=rtpmap:96 H264/90000\r\n' });
      expect((await app.inject({ method: 'DELETE', url: `/api/channels/${id}/publish-credential` })).statusCode).toBe(503);
      expect(secrets.get(`backend/ingest-publish/${id}`)).toBe('camera-key');
    } finally { fetchMock.mockRestore(); await app.close(); }
  });
  it('rejects missing device credentials and wrong codecs before contacting SRS', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: { 'content-type': 'application/sdp' }, payload: 'v=0\r\n' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: { authorization: 'Bearer camera-key', 'content-type': 'application/sdp' }, payload: 'a=rtpmap:96 VP8/90000\r\n' })).statusCode).toBe(415);
    expect((await app.inject({ url: '/internal/ingest/config' })).statusCode).toBe(403);
    await app.close();
  });
  it('preserves SDP and DELETE semantics without exposing the upstream session URL', async () => {
    const { app } = await setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('v=0\r\na=rtpmap:96 H264/90000\r\n', { status: 201, headers: { location: '/rtc/v1/whip/?action=delete&token=private-session&app=live&stream=whip_camera' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    try {
      const result = await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: { authorization: 'Bearer camera-key', 'content-type': 'application/sdp', host: '192.168.100.183' }, payload: 'v=0\r\na=rtpmap:96 H264/90000\r\n' });
      expect(result.statusCode).toBe(201);
      expect(result.headers.location).not.toContain('private-session');
      expect((await app.inject({ method: 'DELETE', url: String(result.headers.location), headers: { authorization: 'Bearer camera-key' } })).statusCode).toBe(204);
    } finally { fetchMock.mockRestore(); await app.close(); }
  });
  it('blocks disabled channels and does not advertise undeployed SRT', async () => {
    const { app, channels } = await setup();
    (channels[0] as any).inputEnabled = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const caps = (await app.inject({ url: '/api/ingest/capabilities' })).json().data;
      expect(caps.srt.enabled).toBe(false); expect(caps.rtsp.enabled).toBe(false);
      expect((await app.inject({ method: 'POST', url: `/ingest/whip/${id}`, headers: { authorization: 'Bearer camera-key', 'content-type': 'application/sdp' }, payload: 'a=rtpmap:96 H264/90000\r\n' })).statusCode).toBe(401);
    } finally { fetchMock.mockRestore(); await app.close(); }
  });
});


it('runtime ONVIF sources require service authentication and the current input generation',async()=>{
 const generation='33333333-3333-4333-8333-333333333333';const source=vi.fn(async()=>({source:'rtsp://operator:private@192.0.2.10/runtime',refreshAfterProbe:true,allowedCIDRs:['192.0.2.0/24']}));
 const app=Fastify();await app.register(ingestRoutes,{channels:{read:async()=>({channels:[{id,inputGeneration:generation,onvif:{deviceId:id},inputEnabled:true}]})} as any,settings:{} as any,secrets:()=>null,token:'internal-secret',workerUrl:'http://worker',srsUrl:'http://srs',srtEnabled:false,onvifAllowed:()=>true,onvifSource:source});
 try{
  expect((await app.inject({method:'POST',url:'/internal/ingest/source',payload:{id,generation}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/internal/ingest/source',headers:{'x-service-token':'internal-secret'},payload:{id,generation:'44444444-4444-4444-8444-444444444444'}})).statusCode).toBe(409);
  expect(source).not.toHaveBeenCalled();
  const result=await app.inject({method:'POST',url:'/internal/ingest/source',headers:{'x-service-token':'internal-secret'},payload:{id,generation}});
  expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('no-store');expect(result.json().generation).toBe(generation);
 }finally{await app.close()}
});
