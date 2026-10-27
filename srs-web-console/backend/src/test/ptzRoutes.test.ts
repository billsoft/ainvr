import Fastify from 'fastify';
import { it, expect, vi } from 'vitest';
import { ptzRoutes } from '../routes/ptz.js';
import type { PtzManager } from '../services/ptzManager.js';
import type { PtzStore } from '../store/ptzStore.js';
const id = '11111111-1111-4111-8111-111111111111',
  session = '22222222-2222-4222-8222-222222222222';
function fixture(auth = true) {
  const manager = {
    close: vi.fn(),
    command: vi.fn(async () => ({ moving: true })),
    emergencyStop: vi.fn(async () => ({ stopConfirmed: true })),
    inspect: vi.fn(async () => ({ supported: true })),
    catalog: vi.fn(async () => ({ items: [] })),
    acquire: vi.fn(async () => ({ sessionId: session })),
    invalidateCamera: vi.fn(async () => ({ state: 'applied' })),
  } as unknown as PtzManager;
  const store = {
    pool: { query: vi.fn(async () => ({ rows: [{ exists: 1 }] })) },
    camera: vi.fn(async () => ({
      revision: 0,
      settings: { enabled: true, panTilt: null, zoom: null, presets: null },
    })),
  } as unknown as PtzStore;
  const app = Fastify();
  app.register(ptzRoutes, {
    manager,
    store,
    principal: async () => (auth ? 'operator' : null),
    channels: async () => [],
  });
  return { app, manager, store };
}
it('PTZ administration requires authentication and never probes a camera before it', async () => {
  const f = fixture(false);
  try {
    const r = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: { sources: [{ protocol: 'onvif', deviceId: id, videoSource: 'sensor' }] },
    });
    expect(r.statusCode).toBe(401);
    expect(f.store.pool.query).not.toHaveBeenCalled();
    expect((await f.app.inject(`/channels/${id}/ptz`)).statusCode).toBe(401);
  } finally {
    await f.app.close();
  }
});
it('strict controls reject arbitrary addresses, credentials, malformed sessions and vectors', async () => {
  const f = fixture();
  try {
    for (const payload of [
      { sequence: 1, vector: { pan: 2, tilt: 0, zoom: 0 } },
      { sequence: 1, vector: { pan: 1, tilt: 0, zoom: 0 }, url: 'http://camera' },
      { sequence: 0, vector: { pan: 1, tilt: 0, zoom: 0 } },
    ])
      expect(
        (
          await f.app.inject({
            url: `/channels/${id}/ptz/control-session/${session}`,
            method: 'PUT',
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(f.manager.command).not.toHaveBeenCalled();
    const r = await f.app.inject({
      url: `/channels/${id}/ptz/control-session/${session}`,
      method: 'PUT',
      payload: { sequence: 1, vector: { pan: 1, tilt: 0, zoom: 0 } },
    });
    expect(r.statusCode).toBe(200);
    expect(f.manager.command).toHaveBeenCalledWith(
      id,
      session,
      'operator',
      1,
      { pan: 1, tilt: 0, zoom: 0 },
      undefined,
      undefined,
    );
  } finally {
    await f.app.close();
  }
});
it('offline camera settings use stable protocol identity and bounded selections', async () => {
  const f = fixture();
  try {
    const r = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: { sources: [{ protocol: 'onvif', deviceId: id, videoSource: 'sensor-a' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0].key).toBe(`onvif:${id}/sensor-a`);
    expect(f.manager.inspect).not.toHaveBeenCalled();
    const invalid = await f.app.inject({
      url: '/ptz/camera-configurations',
      method: 'POST',
      payload: {
        sources: Array.from({ length: 101 }, () => ({
          protocol: 'onvif',
          deviceId: id,
          videoSource: 'sensor-a',
        })),
      },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await f.app.close();
  }
});
it('emergency Stop is a separate explicit authenticated operation', async () => {
  const f = fixture();
  try {
    const r = await f.app.inject({
      url: `/channels/${id}/ptz/stop`,
      method: 'POST',
      payload: { sessionId: null },
    });
    expect(r.statusCode).toBe(200);
    expect(f.manager.emergencyStop).toHaveBeenCalledWith(id, 'operator');
  } finally {
    await f.app.close();
  }
});
