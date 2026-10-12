import { it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { recorderProxyRoutes } from '../routes/recorderProxy.js';
it('retired recorder draft endpoint refuses writes without forwarding or touching PG', async () => {
  const app = Fastify(); const write = vi.fn(); const read = vi.fn();
  await app.register(recorderProxyRoutes, { fallbackBaseUrl: 'http://127.0.0.1:9',
    settingsStore: { read } as any,
    pgStore: { upsertDocument: write } as any });
  const response = await app.inject({ method: 'PUT', url: '/v1/recorder/config', payload: { files: { segmentSeconds: 60 } } });
  expect(response.statusCode).toBe(410);
  expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  await app.close();
});
