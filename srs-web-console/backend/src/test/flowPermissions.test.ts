import {afterEach, expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {flowRoutes} from '../routes/flowRoutes.js';
import {AlarmRuleSync} from '../services/alarmRuleSync.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const window = {from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z'};
const config = {baseUrl: 'http://127.0.0.1:8099', apiToken: 'flow-permission-token-'.repeat(3), timeoutMs: 1000};
const counter = {counter_id: 'people', name: 'People', labels: [{label_id: 'person', name: 'Person'}], method: 'line', outputs: 'in',
  names: {in: 'In', out: 'Out'}, occupancy: false, max_gap_ms: 1000, state: 'enabled', version: 1};
const binding = {counter_id: 'people', binding_id: 'binding', active: true, counting: true, source_id: 'camera', zone_name: 'Gate',
  created_at: new Date(window.from), updated_at: new Date(window.from), versions: [],
  document: {processor_id: 'ai', zone_id: 'zone', direction: {kind: 'line', edge: 'edge', in_side: 'inward'}}};

it('flow totals, live, record/export source, clear and purge all use validated server actor', async () => {
  vi.spyOn(AlarmRuleSync.prototype, 'synchronize').mockResolvedValue({state: 'applied'});
  for (const principal of ['console-local', 'console-administrator']) {
    const fetcher = vi.fn(async (input: URL | string, options?: RequestInit) => {
      const target = new URL(input), sent = new Headers(options?.headers);
      expect(sent.get('authorization')).toBe(`Bearer ${config.apiToken}`);
      expect(sent.get('x-ainvr-actor')).toBe(principal);
      expect(sent.has('x-console-token')).toBe(false);
      const body = JSON.parse(options?.body as string);
      if (target.pathname === '/v1/flow/clear') return new Response('{"cleared":true}');
      if (target.pathname === '/v1/flow/purge') return new Response('{"facts":1,"coverage":1}');
      if (body.detail) return new Response(JSON.stringify({items: principal === 'console-administrator' ? [{event_id: 'face', member_name: 'SECRET'}] : [], next_cursor: null}));
      return new Response(JSON.stringify({items: body.series.map((s: {key: string}) => ({key: s.key, occurrences: 2, tracked_targets: 1, coverage: {state: 'unknown', gaps: []}, buckets: []}))}));
    });
    vi.stubGlobal('fetch', fetcher);
    const store = {listCounters: async () => [counter], counterBindings: async () => [binding], definitionHistory: async () => [],
      beginDeleteCounter: vi.fn(async () => ({binding_ids: ['binding']})), finishDeleteCounter: vi.fn(async () => {})};
    const app = Fastify();
    await app.register(flowRoutes, {store: store as never, principal: async () => principal,
      catalog: async () => null, synchronization: null, connection: async () => config});
    const headers = {'x-ainvr-actor': 'console-administrator', 'x-console-token': 'untrusted', 'idempotency-key': 'permission-op'};
    try {
      const totals = await app.inject({method: 'POST', url: '/flow/query', headers, payload: {...window, totals_only: true}});
      expect(totals.statusCode).toBe(200);
      const records = await app.inject({method: 'POST', url: '/flow/records', headers, payload: {...window, counter_id: 'people', binding_id: 'binding', output: 'in'}});
      expect(records.statusCode).toBe(200);
      expect(records.body.includes('SECRET')).toBe(principal === 'console-administrator');
      const live = await app.inject({url: '/flow/live?source_id=camera&from=' + encodeURIComponent(new Date(Date.now() - 10000).toISOString()), headers});
      expect(live.statusCode).toBe(200);
      expect((await app.inject({method: 'POST', url: '/flow/counters/people/clear', headers, payload: {...window, binding_ids: ['binding']}})).statusCode).toBe(200);
      expect((await app.inject({method: 'POST', url: '/flow/counters/people/delete', headers, payload: {expected_version: 1}})).statusCode).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(store.beginDeleteCounter).toHaveBeenCalledWith('people', 1, principal, 'permission-op');
    } finally { await app.close(); }
  }
});

it('flow cannot acquire a principal from a forged actor header', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const app = Fastify();
  await app.register(flowRoutes, {store: {} as never, principal: async () => null,
    catalog: async () => null, synchronization: null, connection: async () => config});
  try {
    for (const url of ['/flow/query', '/flow/records', '/flow/counters/people/clear', '/flow/counters/people/delete']) {
      expect((await app.inject({method: 'POST', url, headers: {'x-ainvr-actor': 'console-administrator'}, payload: {}})).statusCode).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
