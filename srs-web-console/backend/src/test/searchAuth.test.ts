import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestApp } from './buildTestApp.js';

it('root authentication scopes search configuration, AI producer projection and browser access separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ainvr-search-auth-'));
  const previousAi = process.env.CONFIG_SERVICE_TOKEN_AI_SERVICE, previousSearch = process.env.CONFIG_SERVICE_TOKEN_SEARCH_SERVICE;
  const ai = 'isolated-ai-config-'.repeat(3), search = 'isolated-search-config-'.repeat(3);
  process.env.CONFIG_SERVICE_TOKEN_AI_SERVICE = ai; process.env.CONFIG_SERVICE_TOKEN_SEARCH_SERVICE = search;
  const app = await buildTestApp({ dataDir: dir, srsApiHost: '127.0.0.1:19859' });
  try {
    await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'isolated-search-password' } });
    const auth = (token: string) => ({ 'x-service-token': token });
    expect((await app.inject({ url: '/api/internal/search/runtime-config', headers: auth(search) })).statusCode).toBe(503);
    expect((await app.inject({ url: '/api/internal/search/runtime-config', headers: auth(ai) })).statusCode).toBe(401);
    const producer = await app.inject({ url: '/api/internal/search/producer-config', headers: auth(ai) });
    expect(producer.statusCode).toBe(200);
    expect(producer.json()).toEqual({ enabled: false, reason: 'config_pending', endpoint: null, api_token: null,
      revision: null, model: { package_id: null }, sampling: null, sources: [], valid_for_ms: 0, limits: null });
    for (const path of ['/api/internal/search/producer-config', '/api/search/models', '/api/search/status', '/api/channels'])
      expect((await app.inject({ url: path, headers: auth(search) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/internal/search/runtime-config', headers: auth(search) })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'isolated-search-password' } });
    const consoleHeaders = { 'x-console-token': login.json().data.token };
    expect((await app.inject({ url: '/api/internal/search/runtime-config', headers: consoleHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/internal/search/producer-config', headers: consoleHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/search/status', headers: consoleHeaders })).json())
      .toEqual({ ready: false, reason: 'config_pending', model_version: null });
    expect(producer.body).not.toContain(search); expect(producer.body).not.toContain(ai);
  } finally {
    await app.close(); await rm(dir, { recursive: true, force: true });
    if (previousAi === undefined) delete process.env.CONFIG_SERVICE_TOKEN_AI_SERVICE; else process.env.CONFIG_SERVICE_TOKEN_AI_SERVICE = previousAi;
    if (previousSearch === undefined) delete process.env.CONFIG_SERVICE_TOKEN_SEARCH_SERVICE; else process.env.CONFIG_SERVICE_TOKEN_SEARCH_SERVICE = previousSearch;
  }
});
