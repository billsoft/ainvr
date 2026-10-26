import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSettingsTransferRoutes } from '../routes/settingsTransferRoutes.js';
import { DEFAULT_SETTINGS } from '../types/channel.js';
import { OnvifManager, onvifBindingSchema } from '../services/onvifManager.js';
import { onvifSettingsSchema, OnvifError } from '../store/onvifStore.js';
import { onvifRoutes } from '../routes/onvif.js';
import { sameOnvifBinding } from '../types/channel.js';

const binding = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  deviceVersion: 2,
  service: 'media2' as const,
  profileToken: 'main',
  videoSource: 'source-a',
};
const config = {
  name: 'Entrance',
  downstreamProtocols: ['flv' as const],
  primaryProtocol: 'flv' as const,
  inputEnabled: true,
};
const profile = {
  service: 'media2',
  token: 'main',
  name: 'Main',
  videoSource: 'source-a',
  videoCodec: 'H264',
  audioCodec: 'AAC',
  width: 1920,
  height: 1080,
  fps: 10,
};
function setup(change: Record<string, unknown> = {}) {
  const store = {
    recordProbe: vi.fn(async () => {}),
    settings: vi.fn(async () => ({
      revision: 1,
      tokenSet: true,
      settings: {
        enabled: true,
        serviceUrl: 'http://127.0.0.1:8150',
        allowedCIDRs: ['192.0.2.0/24'],
        interfaces: ['eth0'],
        timeoutSeconds: 3,
      },
    })),
    pg: { getSecret: vi.fn(async () => 'k'.repeat(32)) },
    device: vi.fn(async () => ({
      record: { version: 2 },
      device: {
        url: 'http://192.0.2.10/device',
        username: 'user',
        password: 'private',
        certificateSHA256: '',
      },
    })),
  };
  const channels = {
    createChannel: vi.fn(async (input) => ({
      ...input,
      id: '22222222-2222-4222-8222-222222222222',
      inputGeneration: '33333333-3333-4333-8333-333333333333',
    })),
    updateChannel: vi.fn(async () => ({})),
    listChannels: vi.fn(async () => []),
    getChannel: vi.fn(async (): Promise<any> => null),
    hasInputSource: vi.fn(async()=>true),
  };
  const fetchMock = vi.fn(
    async (url: string, options: any) =>
      new Response(
        JSON.stringify(
          url.endsWith('/v1/config')
            ? { appliedRevision: 1 }
            : {
                uri: 'rtsp://192.0.2.10/live',
                profile,
                timeoutSeconds: 0,
                invalidAfterConnect: false,
                invalidAfterReboot: false,
                ...change,
              },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { manager: new OnvifManager(store as any, channels as any), store, channels, fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
describe('ONVIF stable source binding', () => {
  it('requires an explicit camera network and exact physical source identity', () => {
    expect(
      onvifSettingsSchema.safeParse({
        enabled: true,
        serviceUrl: 'http://127.0.0.1:8150',
        allowedCIDRs: [],
        interfaces: [],
        timeoutSeconds: 3,
      }).success,
    ).toBe(false);
    expect(onvifBindingSchema.safeParse({ ...binding, videoSource: '' }).success).toBe(false);
  });
  it('uses the existing RTSP input and encryptable source fields, preserving ONVIF identity', async () => {
    const { manager, channels } = setup();
    await manager.saveChannel(binding, config);
    expect(channels.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamProtocol: 'rtsp',
        onvif: binding,
        rtspUrl: 'rtsp://192.0.2.10/live',
        inputUsername: 'user',
        inputPassword: 'private',
        inputAudioMode: 'auto',
      }),
    );
  });
  it('rejects another source returned with the selected token', async () => {
    const { manager, channels } = setup({ profile: { ...profile, videoSource: 'source-b' } });
    await expect(manager.saveChannel(binding, config)).rejects.toMatchObject({
      code: 'profile_identity_mismatch',
    });
    expect(channels.createChannel).not.toHaveBeenCalled();
  });
  it('does not send media credentials to another returned host', async () => {
    const { manager, channels } = setup({ uri: 'rtsp://192.0.2.11/live' });
    await expect(manager.saveChannel(binding, config)).rejects.toMatchObject({
      code: 'media_host_changed',
    });
    expect(channels.createChannel).not.toHaveBeenCalled();
  });
  it('does not save after a concurrent device configuration change', async () => {
    const { manager, store } = setup();
    store.device.mockResolvedValue({
      record: { version: 3 },
      device: {
        url: 'http://192.0.2.10/device',
        username: 'user',
        password: 'private',
        certificateSHA256: '',
      },
    });
    await expect(manager.saveChannel(binding, config)).rejects.toMatchObject({
      code: 'device_configuration_changed',
    });
  });
  it('keeps ONVIF disabled inputs separate from legacy RTSP', () => {
    const { manager } = setup();
    expect(manager.inputAllowed({ onvif: binding } as any)).toBe(false);
    expect(manager.inputAllowed({} as any)).toBe(true);
  });
  it('preserves identity through JSONB key reordering and allows offline metadata edits', async () => {
    const reordered = {
      videoSource: binding.videoSource,
      profileToken: binding.profileToken,
      service: binding.service,
      deviceVersion: binding.deviceVersion,
      deviceId: binding.deviceId,
    };
    expect(sameOnvifBinding(reordered, binding)).toBe(true);
    const { manager, channels, fetchMock } = setup();
    channels.getChannel.mockResolvedValue({ onvif: reordered });
    await manager.saveChannel(
      binding,
      config,
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    );
    expect(channels.updateChannel).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ name: 'Entrance' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not allow unauthenticated configuration or probes', async () => {
    const app = Fastify();
    await app.register(onvifRoutes, {
      store: {} as any,
      manager: {} as any,
      principal: async () => null,
    });
    const result = await app.inject({
      method: 'POST',
      url: '/onvif/devices/' + binding.deviceId + '/probe',
    });
    expect(result.statusCode).toBe(401);
    await app.close();
  });
});

describe('ONVIF runtime media URI lifetime', () => {
  const channel = {
    id: '22222222-2222-4222-8222-222222222222',
    inputGeneration: '33333333-3333-4333-8333-333333333333',
    onvif: binding,
    inputEnabled: true,
  };
  it('does not periodically renew an unchanged binding or interrupt its healthy publisher', async () => {
    const { manager, channels, fetchMock } = setup({ uri: 'rtsp://192.0.2.10/changed-token' });
    channels.listChannels.mockResolvedValue([channel] as any);
    await manager.synchronize();
    await manager.synchronize();
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/v1/config'))).toBe(true);
    expect(channels.updateChannel).not.toHaveBeenCalled();
  });
  it('acquires a new URI for a connection and declares when ffprobe consumes it', async () => {
    const { manager, channels } = setup({ invalidAfterConnect: true });
    channels.getChannel.mockResolvedValue(channel);
    expect(await manager.connectSource(channel as any)).toEqual({
      source: 'rtsp://user:private@192.0.2.10/live',
      allowedCIDRs: ['192.0.2.0/24'],
      refreshAfterProbe: true,
    });
  });
  it('renews unknown or fractional-positive URI lifetimes after the probe', async () => {
    for (const timeoutSeconds of [-1, 1]) {
      const { manager, channels } = setup({ timeoutSeconds });
      channels.getChannel.mockResolvedValue(channel);
      expect(await manager.connectSource(channel as any)).toMatchObject({ refreshAfterProbe: true });
    }
  });
  it('fences a source response if the channel changes during device resolution', async () => {
    const { manager, channels } = setup();
    channels.getChannel.mockResolvedValue({ ...channel, inputGeneration: 'new' });
    await expect(manager.connectSource(channel as any)).rejects.toMatchObject({
      code: 'source_configuration_changed',
    });
  });
  it('keeps an authentication stop across a backend restart until the device is corrected or explicitly probed', async () => {
    const { manager, channels, store, fetchMock } = setup();
    channels.listChannels.mockResolvedValue([channel] as any);
    const original = await store.device();
    store.device.mockResolvedValue({
      ...original,
      record: { version: 2, last_error: 'authentication_failed' },
    } as any);
    await manager.synchronize();
    const restarted = new OnvifManager(store as any, channels as any);
    await restarted.synchronize();
    expect(restarted.inputAllowed(channel as any)).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/v1/config'))).toBe(true);
  });
});

describe('ONVIF credential changes', () => {
  it('persists authentication failure for the attempted device version', async () => {
    const { manager, channels, store, fetchMock } = setup();
    const original = await store.device();
    store.device.mockResolvedValue({ ...original, record: { version: 3 } } as any);
    channels.listChannels.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        inputGeneration: '33333333-3333-4333-8333-333333333333',
        inputEnabled: true,
        onvif: binding,
      },
    ] as any);
    fetchMock.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith('/v1/config')
              ? { appliedRevision: 1 }
              : { error: 'authentication_failed' },
          ),
          { status: url.endsWith('/v1/config') ? 200 : 401 },
        ),
    );
    await manager.synchronize();
    expect(store.recordProbe).toHaveBeenCalledWith(
      binding.deviceId,
      3,
      null,
      'authentication_failed',
    );
  });
});

it('revalidates an imported ONVIF channel before enabling it without a stored source',async()=>{
 const {manager,channels,fetchMock}=setup();
 channels.getChannel.mockResolvedValue({onvif:binding,inputGeneration:'33333333-3333-4333-8333-333333333333'});
 channels.hasInputSource.mockResolvedValue(false);
 await manager.saveChannel(binding,config,'22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
 expect(fetchMock.mock.calls.some(([url])=>url.endsWith('/v1/resolve'))).toBe(true);
 expect(channels.updateChannel).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222',expect.objectContaining({rtspUrl:'rtsp://192.0.2.10/live',onvif:binding}));
});

describe('ONVIF public channel backups',()=>{
 function fixture() {
  let data:any={channels:[{id:'22222222-2222-4222-8222-222222222222',name:'NVR camera',upstreamProtocol:'rtsp',streamName:'nvr_a',downstreamProtocols:['flv'],app:'live',onvif:binding,inputAudioMode:'auto',inputEnabled:true,sourceRef:'backend/ingest/private',createdAt:1,updatedAt:1}]};
  const channelStore={read:async()=>structuredClone(data),mutate:async(fn:any)=>{const next=structuredClone(data);await fn(next);data=next;return next}};
  const app=Fastify();registerSettingsTransferRoutes(app,{channelStore,settingsStore:{read:async()=>DEFAULT_SETTINGS,mutate:async(fn:any)=>{const value=structuredClone(DEFAULT_SETTINGS);await fn(value);return value}},channelService:{cleanupDiscardedInputSecrets:async()=>{}},srsClient:{setApiHost:()=>{}},aiServiceFallbackBaseUrl:'http://127.0.0.1:8000'} as any);
  return {app,read:()=>data};
 }
 it('round-trips stable device/profile identity without importing credentials or starting media',async()=>{
  const {app,read}=fixture();try {
   const exported=(await app.inject({method:'GET',url:'/export'})).json().data;
   expect(exported.channels[0].sourceRef).toBeUndefined();
   const result=await app.inject({method:'POST',url:'/import',payload:{mode:'overwrite',data:exported}});
   expect(result.statusCode).toBe(200);expect(read().channels[0].onvif).toEqual(binding);expect(read().channels[0].inputAudioMode).toBe('auto');expect(read().channels[0].inputEnabled).toBe(false);expect(read().channels[0].sourceRef).toBeUndefined();
  } finally {await app.close()}
 });
 it('rejects duplicate managed sources atomically instead of creating two pull workers',async()=>{
  const {app,read}=fixture();try {
   const exported=(await app.inject({method:'GET',url:'/export'})).json().data;
   exported.channels.push({...exported.channels[0],id:'44444444-4444-4444-8444-444444444444',streamName:'nvr_b',onvif:{...binding,deviceVersion:3}});
   const result=await app.inject({method:'POST',url:'/import',payload:{mode:'overwrite',data:exported}});
   expect(result.statusCode).toBe(400);expect(read().channels).toHaveLength(1);expect(read().channels[0].sourceRef).toBe('backend/ingest/private');
  } finally {await app.close()}
 });
});
