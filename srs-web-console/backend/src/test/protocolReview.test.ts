import { describe, it, expect } from 'vitest';
import { ChannelService } from '../services/channelService.js';
import { registerSettingsTransferRoutes } from '../routes/settingsTransferRoutes.js';
import Fastify from 'fastify';

function setup() {
  let data: any = { channels: [] };
  const store: any = { read: async () => structuredClone(data),
    mutate: async (fn: any) => { const next = structuredClone(data); await fn(next); data = next; return structuredClone(data); },
    replace: async (next: any) => { data = structuredClone(next); } };
  const saved = new Map<string,string>();
  const pg: any = { getSecret: async (ref: string) => saved.get(ref),
    setSecret: async (ref: string,value: string) => { saved.set(ref,value); },
    deleteSecret: async (ref: string) => { saved.delete(ref); } };
  const srs: any = { listStreams: async () => [], isOnline: async () => false };
  const service = new ChannelService({ store, settingsStore: store, srsClient: srs, secrets: () => pg });
  return { store, saved, pg, srs, service };
}

describe('protocol review regressions', () => {
  it('preserves separate RTSP credentials when editing the host and leaving credentials blank', async () => {
    const { service, saved } = setup();
    const c = await service.createChannel({ name:'camera', streamName:'cam', upstreamProtocol:'rtsp',
      downstreamProtocols:['flv'], rtspUrl:'rtsp://camera-a/live', inputUsername:'operator', inputPassword:'password' });
    await service.updateChannel(c.id, { rtspUrl:'rtsp://camera-b/new', inputPassword:'' });
    expect([...saved.values()]).toEqual(['rtsp://operator:password@camera-b/new']);
  });
  it('lets new explicit credentials replace retained credentials', async () => {
    const { service, saved } = setup();
    const c = await service.createChannel({ name:'camera', streamName:'cam', upstreamProtocol:'rtsp',
      downstreamProtocols:['flv'], rtspUrl:'rtsp://old:password@camera-a/live' });
    await service.updateChannel(c.id, { rtspUrl:'rtsp://camera-b/new', inputUsername:'new', inputPassword:'new-password' });
    expect([...saved.values()]).toEqual(['rtsp://new:new-password@camera-b/new']);
  });
  it('does not modify channel data when imported settings fail validation', async () => {
    const { store,service,pg,srs,saved } = setup();
    await service.createChannel({name:'camera',streamName:'cam',upstreamProtocol:'rtsp',
      downstreamProtocols:['flv'],rtspUrl:'rtsp://operator:password@camera/live'});
    const app=Fastify();registerSettingsTransferRoutes(app,{channelStore:store,channelService:service,
      settingsStore:store,srsClient:srs,pgStore:pg,aiServiceFallbackBaseUrl:''});
    const response=await app.inject({method:'POST',url:'/import',payload:{mode:'overwrite',
      data:{channels:[],settings:{srsApiHost:123}}}});
    expect(response.statusCode).toBe(400);
    expect((await store.read()).channels).toHaveLength(1); expect(saved.size).toBe(1);
    await app.close();
  });
  it('treats malformed imported RTSP URLs as a client error and does not change channels', async () => {
    const { store,service,pg,srs } = setup();
    const c = await service.createChannel({name:'camera',streamName:'cam',upstreamProtocol:'rtmp',downstreamProtocols:['flv']});
    const app=Fastify(); registerSettingsTransferRoutes(app,{channelStore:store,channelService:service,
      settingsStore:store,srsClient:srs,pgStore:pg,aiServiceFallbackBaseUrl:''});
    const response=await app.inject({method:'POST',url:'/import',payload:{mode:'overwrite',data:{
      channels:[{...c,upstreamProtocol:'rtsp',rtspUrl:'not a URL'}]}}});
    expect(response.statusCode).toBe(400);
    expect((await store.read()).channels[0].upstreamProtocol).toBe('rtmp');
    await app.close();
  });
  it('removes credentials for replaced inputs after an import commit', async () => {
    const { store,service,pg,srs,saved } = setup();
    await service.createChannel({name:'camera',streamName:'cam',upstreamProtocol:'rtsp',
      downstreamProtocols:['flv'],rtspUrl:'rtsp://operator:password@camera/live'});
    const app=Fastify();registerSettingsTransferRoutes(app,{channelStore:store,channelService:service,
      settingsStore:store,srsClient:srs,pgStore:pg,aiServiceFallbackBaseUrl:''});
    const response=await app.inject({method:'POST',url:'/import',payload:{mode:'overwrite',data:{channels:[]}}});
    expect(response.statusCode).toBe(200);expect(saved.size).toBe(0);
    await app.close();
  });
});
