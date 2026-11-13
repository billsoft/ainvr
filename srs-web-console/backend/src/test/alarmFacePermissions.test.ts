import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {alarmProxyRoutes} from '../routes/alarmProxy.js';

const config = {baseUrl: 'http://127.0.0.1:29999', apiToken: 'server-only-permission-test-'.repeat(3), timeoutMs: 1000};
afterEach(() => vi.unstubAllGlobals());

it('sets trusted principal on every alarm read/write and never forwards forged permission headers', async () => {
  const fetcher = vi.fn(async () => new Response('{"items":[]}', {status: 200}));
  vi.stubGlobal('fetch', fetcher);
  for (const principal of ['console-local', 'console-administrator']) {
    const app = Fastify();
    await app.register(alarmProxyRoutes, {connection: async () => config, principal: async () => principal});
    try {
      for (const [method, url, payload] of [
        ['GET', '/alarms/events?status=all'], ['GET', '/alarms/events/id'], ['GET', '/alarms/events/id/logs'],
        ['GET', '/alarms/events/summary'], ['GET', '/alarms/behavior-events?from=a&to=b'],
        ['GET', '/alarms/behavior-events/id'], ['GET', '/alarms/behavior-statistics?from=a&to=b'],
        ['GET', '/alarms/rules'], ['POST', '/alarms/events/analytics', {}],
        ['POST', '/alarms/events/statistics', {}],
        ['POST', '/alarms/events/id/acknowledgements', {expected_handling_revision: 0}],
        ['POST', '/alarms/bulk-acknowledgements', {items: [{alarm_id: 'id', expected_handling_revision: 0}]}],
      ] as const) {
        const response = await app.inject({method, url, ...(payload ? {payload} : {}), headers: {
          authorization: 'Bearer forged', 'x-ainvr-actor': 'console-administrator',
          'x-ainvr-face-access': 'all', 'x-role': 'admin', 'x-console-token': 'forged', 'idempotency-key': 'op',
        }});
        expect(response.statusCode).toBe(200);
        const [, request] = fetcher.mock.calls.at(-1)! as unknown as [URL, RequestInit];
        const sent = new Headers(request.headers);
        expect(sent.get('x-ainvr-actor')).toBe(principal);
        expect(sent.get('authorization')).toBe(`Bearer ${config.apiToken}`);
        for (const key of ['x-ainvr-face-access', 'x-role', 'x-console-token']) expect(sent.has(key)).toBe(false);
      }
    } finally { await app.close(); }
  }
});

it('requires authenticated principal even with forged client claims; local cannot purge all', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const principal of [null, 'console-local']) {
    const app = Fastify();
    await app.register(alarmProxyRoutes, {connection: async () => config, principal: async () => principal});
    try {
      const response = await app.inject({method: 'POST', url: '/alarms/purge', payload: {scope: 'all', password: 'guess'},
        headers: {'x-ainvr-actor': 'console-administrator', 'idempotency-key': 'op'}});
      expect(response.statusCode).toBe(principal ? 403 : 401);
      if (!principal) {
        for (const url of ['/alarms/events', '/alarms/events/id/logs', '/alarms/events/summary', '/alarms/behavior-events/id'])
          expect((await app.inject({url, headers: {'x-ainvr-actor': 'console-administrator'}})).statusCode).toBe(401);
      }
    } finally { await app.close(); }
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves the known face permission 403 while hiding service authentication failures', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const app = Fastify();
  await app.register(alarmProxyRoutes, {connection: async () => config, principal: async () => 'console-local'});
  try {
    for (const [status, code, expected] of [
      [403, 'faces_management_required', 403], [403, 'unauthorized', 502],
      [401, 'faces_management_required', 502], [403, 'unknown_internal_policy', 502],
    ] as const) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error: {code, message: 'denied'}}), {status}));
      const response = await app.inject('/alarms/events/id');
      expect(response.statusCode).toBe(expected);
      expect(response.json().error.code).toBe(expected === 403 ? code : 'alarm_unavailable');
    }
  } finally { await app.close(); }
});
