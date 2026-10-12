import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPasswordCache } from '../services/passwordCache.js';
import { PgConfigStore } from '../store/pgStore.js';
import { buildTestApp } from './buildTestApp.js';
import Fastify from 'fastify';
import { aiProxyRoutes, invalidateAiKeyCache } from '../routes/aiProxy.js';
import { DEFAULT_SETTINGS } from '../types/channel.js';

vi.mock('../store/pgStartup.js', () => ({
  initPgStoreWithRetry: vi.fn(async () => { throw new Error('test PG unavailable'); }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('milestone authentication and transaction boundaries', () => {
  it('unreadable local password settings are not treated as no password', async () => {
    const cache = createPasswordCache({ read: async () => { throw new Error('I/O failure'); } } as any);
    await expect(cache.get()).rejects.toMatchObject({ statusCode: 503 });
  });
  it('unavailable authoritative password is an error, never a usable credential; recovery works', async () => {
    const getSecret = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('hash');
    const cache = createPasswordCache({ read: async () => ({}) } as any, 0,
      () => ({ getSecret }) as any);
    await expect(cache.get()).rejects.toMatchObject({ statusCode: 503 });
    expect(await cache.get()).toBe('hash');
  });

  it('configured PG initialization failure refuses to construct a partially authenticated app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milestone-app-'));
    vi.stubEnv('CONFIG_PG_HOST', 'test.invalid');
    vi.stubEnv('CONFIG_PG_DATABASE', 'test');
    vi.stubEnv('CONFIG_MASTER_KEY_PATH', path.join(dir, 'unused.key'));
    try {
      await expect(buildTestApp({ dataDir: dir })).rejects.toThrow('test PG unavailable');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('audit rejection rolls back the unpublished version on the same connection', async () => {
    const store = new PgConfigStore({ poolConfig: {}, masterKeyPath: '/unused-test-key' });
    const sql: string[] = [];
    const query = vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes('INSERT INTO config_audit_logs')) throw new Error('audit failed');
      return { rows: text.includes('RETURNING *') ? [{ id: 1, version: 1 }] : [], rowCount: 0 };
    });
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
    const poolQuery = vi.spyOn(store.pool, 'query').mockRejectedValue(new Error('must use transaction'));
    try {
      await expect(store.publish('test')).rejects.toThrow('audit failed');
      expect(sql).not.toContain('COMMIT');
      expect(sql.at(-1)).toBe('ROLLBACK');
      expect(poolQuery).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('single-image delete uses the PG key and start/stop use their operation deadlines', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    invalidateAiKeyCache();
    const app = Fastify();
    await app.register(aiProxyRoutes, {
      fallbackBaseUrl: 'http://test.invalid',
      settingsStore: { read: async () => structuredClone(DEFAULT_SETTINGS) } as any,
      srsClient: {} as any,
      pgStore: { getSecret: async () => 'test-pg-key' } as any,
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect((await app.inject({ method: 'DELETE', url: '/ai/channels/test/snapshots/image' })).statusCode).toBe(200);
      const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(request[1].headers).get('x-api-key')).toBe('test-pg-key');
      await app.inject({ method: 'POST', url: '/ai/channels/test/start' });
      await app.inject({ method: 'POST', url: '/ai/channels/test/stop' });
      expect(timers.mock.calls.some(call => call[1] === 35000)).toBe(true);
      expect(timers.mock.calls.some(call => call[1] === 15000)).toBe(true);
    } finally { await app.close(); }
  });
});
