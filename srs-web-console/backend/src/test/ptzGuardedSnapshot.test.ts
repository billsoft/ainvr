import { it, expect, vi } from 'vitest';
import { PtzGuardedSnapshot } from '../services/ptzGuardedSnapshot.js';
import type { Pool } from 'pg';
it('pauses all rules on a physical input and retains its epoch after resume', async () => {
  const rules = [
    { id: 'alarm', channel_id: 'processor-a', input_stream_id: 'camera', state: 'enabled' },
    { id: 'counter', channel_id: 'processor-b', input_stream_id: 'camera', state: 'enabled' },
    { id: 'other', input_stream_id: 'another', state: 'enabled' },
  ];
  const g = { resource: 'motor', epoch: '1', blocked: true, sources: ['camera'], restored: null };
  const pool = {
    query: vi.fn(async () => ({ rows: [{ revision: '10', guards: [g] }] })),
  } as unknown as Pool;
  const source = { snapshot: async () => ({ schema_version: '1.0', revision: '10', rules }) };
  const guarded = new PtzGuardedSnapshot(source, pool);
  const a = await guarded.snapshot();
  expect((a.rules as any[]).map((r) => r.state)).toEqual(['paused', 'paused', 'enabled']);
  expect((a.rules[0] as any).view_epoch).toMatch(/^[a-f0-9]{64}$/);
  const epoch = (a.rules[0] as any).view_epoch;
  g.epoch = '2';
  g.blocked = false;
  const b = await guarded.snapshot();
  expect((b.rules[0] as any).state).toBe('enabled');
  expect((b.rules[0] as any).view_epoch).not.toBe(epoch);
  expect(rules[0]!.state).toBe('enabled');
});
it('never publishes rules from a different guard revision', async () => {
  const pool = {
    query: vi.fn(async () => ({ rows: [{ revision: '11', guards: [] }] })),
  } as unknown as Pool;
  const guarded = new PtzGuardedSnapshot(
    { snapshot: async () => ({ schema_version: '1.0', revision: '10', rules: [] }) },
    pool,
  );
  await expect(guarded.snapshot()).rejects.toThrow('View configuration changed');
});

it('legacy rules without input IDs use the trusted AI-to-source graph', async () => {
  const rules = [
    { id: 'legacy', channel_id: 'processor', state: 'enabled' },
    { id: 'unrelated', channel_id: 'another-processor', state: 'enabled' },
  ];
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        {
          revision: '9',
          guards: [{ resource: 'motor', epoch: '2', blocked: true, sources: ['input'] }],
        },
      ],
    })),
  } as unknown as Pool;
  const links = async () =>
    ({
      channels: [{ id: 'input', app: 'live', streamName: 'camera' }],
      ai: [
        {
          id: 'processor',
          config: {
            stream: { url: 'rtmp://127.0.0.1:1935/live/camera' },
            publish: { enabled: false },
          },
        },
      ],
    }) as any;
  const result = await new PtzGuardedSnapshot(
    { snapshot: async () => ({ schema_version: '1.0', revision: '9', rules }) },
    pool,
    links,
  ).snapshot();
  expect((result.rules[0] as any).state).toBe('paused');
  expect((result.rules[1] as any).state).toBe('enabled');
});
