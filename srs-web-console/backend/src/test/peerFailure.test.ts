import { it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyIdentity, clientIdentity } from '../services/proxyIdentity.js';
import { buildTestApp } from './buildTestApp.js';

it('missing peer addresses remain untrusted, even with forged forwarding headers', async () => {
  const identify = createProxyIdentity(async () => ['172.19.0.3']);
  const req = { socket: {}, ip: undefined, protocol: 'http', headers: {
    'x-real-ip': '172.19.0.3', 'x-forwarded-proto': 'https',
  } } as unknown as FastifyRequest;
  await expect(identify(req)).resolves.toBeUndefined();
  expect(clientIdentity(req)).toEqual({ ip: 'unknown', protocol: 'http' });
});

it('normalizes IPv4 mapped trusted peers and retains a valid request IP fallback', async () => {
  const identify = createProxyIdentity(async () => ['172.19.0.3']);
  for (const socket of [{ remoteAddress: '::ffff:172.19.0.3' }, {}]) {
    const req = { socket, ip: '172.19.0.3', protocol: 'http', headers: {
      'x-real-ip': '192.168.100.20', 'x-forwarded-proto': 'https',
    } } as unknown as FastifyRequest;
    await identify(req);
    expect(clientIdentity(req)).toEqual({ ip: '192.168.100.20', protocol: 'https' });
  }
});

it('retains the original peer when the socket closes during proxy lookup', async () => {
  let complete!: (ips: string[]) => void;
  const identify = createProxyIdentity(() => new Promise(resolve => { complete = resolve; }));
  const socket: { remoteAddress?: string } = { remoteAddress: '172.19.0.3' };
  const req = { socket, ip: undefined, protocol: 'http', headers: {
    'x-real-ip': '192.168.100.20',
  } } as unknown as FastifyRequest;
  const pending = identify(req);
  socket.remoteAddress = undefined;
  complete(['172.19.0.3']);
  await pending;
  expect(clientIdentity(req).ip).toBe('192.168.100.20');
});

it('HTTP errors log a redacted stack and request ID without logging request secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-error-stack-'));
  const app = await buildTestApp({ dataDir: dir, trustedProxyLookup: async () => [] });
  app.get('/stack-probe', async () => {
    const error = new Error('peer failure test');
    error.stack = 'Error: peer failure test\n    at peerFailureProbe (test.ts:7:1)\n    at Bearer hidden-stack-secret';
    throw error;
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const response = await app.inject({ url: '/stack-probe?token=hidden-query-secret',
      headers: { authorization: 'Bearer hidden-header-secret' } });
    expect(response.statusCode).toBe(500);
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    const event = events.find(e => e.module === 'http' && e.message.includes('peer failure test'));
    expect(event.message).toContain('peerFailureProbe (test.ts:7:1)');
    expect(event.requestId).toBeTruthy();
    expect(JSON.stringify(events)).not.toMatch(/hidden-(stack|query|header)-secret/);
    expect(response.body).not.toContain('peerFailureProbe');
  } finally {
    log.mockRestore();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
