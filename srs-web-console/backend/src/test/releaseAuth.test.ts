import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTestApp } from './buildTestApp.js';

describe('release authentication boundaries', () => {
  it('password changes invalidate playback and recorder credentials; recorder identity is scoped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-auth-'));
    const previous = process.env.CONFIG_SERVICE_TOKEN_RECORDER;
    process.env.CONFIG_SERVICE_TOKEN_RECORDER = 'isolated-recorder-secret';
    const app = await buildTestApp({ dataDir: dir, srsApiHost: '127.0.0.1:19859' });
    try {
      const verify = (token?: string, cookie?: string) => app.inject({ method: 'POST', url: '/internal/recorder-auth',
        headers: { 'x-service-token': 'isolated-recorder-secret' }, payload: { token, cookie } });
      expect((await verify()).statusCode).toBe(204);
      await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'first-password' } });
      expect((await verify()).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'first-password' } });
      const token = login.json().data.token;
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect(cookie).not.toContain(token);
      expect((await verify(token)).statusCode).toBe(204);
      expect((await verify(undefined, cookie)).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/auth/media-check', headers: { cookie } })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/settings', headers: { cookie } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/internal/recorder-auth', payload: {} })).statusCode).toBe(403);
      const service = { 'x-service-token': 'isolated-recorder-secret' };
      expect((await app.inject({ url: '/api/channels', headers: service })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/api/settings/password', headers: service,
        payload: { password: 'forbidden' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: '/api/settings/password', headers: { 'x-console-token': token }, payload: { password: 'second-password', oldPassword: 'first-password' } })).statusCode).toBe(200);
      expect((await verify(token, cookie)).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/auth/media-check', headers: { cookie } })).statusCode).toBe(401);
      const second = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'second-password' } });
      expect((await app.inject({ method: 'PUT', url: '/api/settings/password', headers: { 'x-console-token': second.json().data.token }, payload: { password: '', oldPassword: 'second-password' } })).statusCode).toBe(200);
      expect((await verify()).statusCode).toBe(204);
    } finally {
      await app.close(); fs.rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.CONFIG_SERVICE_TOKEN_RECORDER;
      else process.env.CONFIG_SERVICE_TOKEN_RECORDER = previous;
    }
  });
});
