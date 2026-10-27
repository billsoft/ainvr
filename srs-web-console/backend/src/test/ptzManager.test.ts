import { it, expect, vi } from 'vitest';
import { PtzManager, samePtzPosition } from '../services/ptzManager.js';
import type { PtzStore } from '../store/ptzStore.js';
import type { PtzAdapter } from '../services/ptzAdapter.js';
import type { Channel } from '../types/channel.js';
function fixture() {
  const root: Channel = {
    id: 'root',
    name: 'Gate',
    streamName: 'gate',
    upstreamProtocol: 'rtsp',
    downstreamProtocols: ['flv'],
    inputGeneration: 'g1',
    onvif: {
      deviceId: 'nvr',
      deviceVersion: 1,
      service: 'media1',
      profileToken: 'main',
      videoSource: 'sensor-a',
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const log: string[] = [];
  const store = {
    settings: vi.fn(async () => ({ settings: { enabled: true, capacity: 4, leaseMs: 1200 } })),
    camera: vi.fn(async () => ({
      revision: 0,
      settings: { enabled: true, panTilt: null, zoom: null, presets: null },
    })),
    guard: vi.fn(async () => null),
    block: vi.fn(async () => {
      log.push('persist-block');
    }),
    record: vi.fn(async () => undefined),
    guards: vi.fn(async () => []),
    watch: vi.fn(async () => undefined),
    stopped: vi.fn(async () => undefined),
    presets: vi.fn(async () => []),
    savePreset: vi.fn(async () => undefined),
    removePreset: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    observeBaseline: vi.fn(async () => undefined),
    pool: { query: vi.fn(async () => ({ rows: [] })) },
  } as unknown as PtzStore;
  const adapter: PtzAdapter = {
    resource: 'motor-1',
    protocol: 'onvif',
    identity: 'binding-1',
    caps: {
      panTilt: true,
      zoom: true,
      presets: true,
      presetWrite: true,
      position: false,
      moveStatus: false,
    },
    call: vi.fn(async (_action, body) => {
      const cmd = body?.command as any;
      log.push(cmd?.stop ? 'stop' : 'move');
      return { stopConfirmed: true };
    }),
  };
  const deps = {
    channels: vi.fn(async () => [root]),
    ai: vi.fn(async () => []),
    prepare: vi.fn(async () => adapter),
    synchronize: vi.fn(async () => {
      log.push('confirmed-pause');
      return { state: 'applied' };
    }),
    resetProcessors: vi.fn(async () => {
      log.push('tracking-reset');
    }),
  };
  return { manager: new PtzManager(store, deps), store, adapter, deps, root, log };
}
it('persists and confirms protection before any move and enforces ownership', async () => {
  const f = fixture();
  try {
    const inspected = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', inspected.identity!);
    expect(f.log).toEqual(['stop', 'persist-block', 'confirmed-pause', 'tracking-reset']);
    await expect(
      f.manager.command('root', lease.sessionId, 'other', 1, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_session_expired');
    await f.manager.command('root', lease.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    expect(f.log.at(-1)).toBe('move');
    await f.manager.stop('root', lease.sessionId, 'operator');
    await expect(
      f.manager.command('root', lease.sessionId, 'operator', 2, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_session_expired');
  } finally {
    await f.manager.close();
  }
});
it('refuses movement if rule pause is not confirmed', async () => {
  const f = fixture();
  f.deps.synchronize.mockResolvedValue({ state: 'pending' });
  try {
    const i = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow(
      'ptz_arming_pause_pending',
    );
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});
it('stops captured original target when the source changes', async () => {
  const f = fixture();
  try {
    const i = await f.manager.inspect('root');
    const l = await f.manager.acquire('root', 'operator', i.identity!);
    await f.manager.command('root', l.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    f.root.inputGeneration = 'rebound';
    await expect(
      f.manager.command('root', l.sessionId, 'operator', 2, { pan: 1, tilt: 0, zoom: 0 }),
    ).rejects.toThrow('ptz_source_changed');
    expect(f.log.at(-1)).toBe('stop');
  } finally {
    await f.manager.close();
  }
});
it('does not treat delivery acceptance or incomplete position as restored view', () => {
  expect(samePtzPosition({}, {})).toBe(false);
  const p = { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' };
  const before = { position: p };
  expect(samePtzPosition(before, { position: p, panTilt: 'IDLE', zoom: 'IDLE' })).toBe(true);
  expect(
    samePtzPosition(before, { position: { ...p, Zoom: 0.4 }, panTilt: 'IDLE', zoom: 'IDLE' }),
  ).toBe(false);
  expect(samePtzPosition(before, { position: p, panTilt: 'MOVING', zoom: 'IDLE' })).toBe(false);
});

it('shared-node video sources pause every processor but exclude another motor', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  const sub = {
    ...f.root,
    id: 'sub',
    streamName: 'sub',
    onvif: { ...f.root.onvif, profileToken: 'sub', videoSource: 'sensor-b' },
  };
  const other = {
    ...f.root,
    id: 'other',
    streamName: 'other',
    onvif: { ...f.root.onvif, profileToken: 'other', videoSource: 'sensor-c' },
  };
  f.adapter.videoSources = ['sensor-a', 'sensor-b'];
  f.deps.channels.mockResolvedValue([f.root, sub, other]);
  try {
    const i = await f.manager.inspect('root');
    await f.manager.acquire('root', 'operator', i.identity!);
    expect(f.store.block).toHaveBeenCalledWith('motor-1', ['root', 'sub'], 'operator', null);
    expect(f.store.camera).toHaveBeenCalledWith('onvif:nvr/sensor-b', 'onvif:nvr/sensor-b');
  } finally {
    await f.manager.close();
  }
});
it('another main/sub profile cannot bypass the shared camera disable', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  f.adapter.videoSources = ['sensor-a', 'sensor-b'];
  vi.mocked(f.store.camera).mockImplementation(async (key) => ({
    revision: 1,
    settings: { enabled: key !== 'onvif:nvr/sensor-b', panTilt: null, zoom: null, presets: null },
  }));
  try {
    const i = await f.manager.inspect('root');
    expect(i.enabled).toBe(false);
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow(
      'ptz_disabled',
    );
  } finally {
    await f.manager.close();
  }
});
it('preset administration cannot steal another operator control', async () => {
  const f = fixture();
  try {
    const i = await f.manager.inspect('root');
    const l = await f.manager.acquire('root', 'operator', i.identity!);
    await f.manager.command('root', l.sessionId, 'operator', 1, { pan: 1, tilt: 0, zoom: 0 });
    const calls = vi.mocked(f.adapter.call).mock.calls.length;
    await expect(
      f.manager.savePreset('root', 'other', { name: 'Gate', shortcut: 1 }),
    ).rejects.toThrow('ptz_busy');
    await expect(f.manager.removePreset('root', 'other', 'gate')).rejects.toThrow('ptz_busy');
    expect(vi.mocked(f.adapter.call).mock.calls).toHaveLength(calls);
  } finally {
    await f.manager.close();
  }
});
it('device-accepted preset with failed metadata is reported as partial success', async () => {
  const f = fixture();
  vi.mocked(f.adapter.call).mockResolvedValue({ id: 'native-gate' });
  vi.mocked(f.store.savePreset).mockRejectedValue(Error('database unavailable'));
  try {
    await expect(
      f.manager.savePreset('root', 'operator', { name: 'Gate', shortcut: 1 }),
    ).rejects.toThrow('ptz_preset_device_saved_metadata_failed');
  } finally {
    await f.manager.close();
  }
});
it('concurrent preset operations are serialized with control acquisition', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  vi.mocked(f.adapter.call).mockImplementation(async (action) =>
    action === 'preset-save'
      ? await new Promise((resolve) => {
          finish = resolve;
        })
      : { stopConfirmed: true },
  );
  try {
    const saving = f.manager.savePreset('root', 'operator', { name: 'Gate', shortcut: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const i = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', i.identity!)).rejects.toThrow('ptz_busy');
    finish({ id: 'gate' });
    await saving;
  } finally {
    await f.manager.close();
  }
});
it('restart recovery stops only a recorded local unfinished control', async () => {
  const f = fixture();
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      revision: 3,
    },
  ]);
  try {
    await f.manager.observe();
    expect(f.adapter.call).toHaveBeenCalledWith(
      'command',
      expect.objectContaining({
        command: expect.objectContaining({ stop: true, emergency: true }),
      }),
    );
    expect(f.store.stopped).toHaveBeenCalledWith('motor-1', 3);
    expect(f.store.block).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});
it('external motion suspends analytics without taking over external control', async () => {
  const f = fixture();
  f.root.onvif = {
    deviceId: 'nvr',
    deviceVersion: 1,
    service: 'media1',
    profileToken: 'main',
    videoSource: 'sensor-a',
  };
  f.adapter.caps.position = true;
  f.adapter.caps.moveStatus = true;
  const position = { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' };
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: false,
      stop_pending: false,
      source_ids: ['root'],
      revision: 1,
      baseline: { position },
    },
  ]);
  vi.mocked(f.adapter.call).mockResolvedValue({
    position: { ...position, Pan: 0.4 },
    panTilt: 'MOVING',
    zoom: 'IDLE',
  });
  try {
    await f.manager.observe();
    expect(f.store.block).toHaveBeenCalledWith(
      'motor-1',
      ['root'],
      'ptz-external-motion',
      { position },
      false,
    );
    expect(f.deps.resetProcessors).toHaveBeenCalled();
    expect(vi.mocked(f.adapter.call).mock.calls.map((c) => c[0])).toEqual(['status']);
  } finally {
    await f.manager.close();
  }
});
it('unknown feedback and a disconnected device never clear a persistent view guard', async () => {
  const f = fixture();
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      resource_key: 'motor-1',
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      revision: 3,
    },
  ]);
  vi.mocked(f.adapter.call).mockRejectedValue(Error('offline'));
  try {
    await f.manager.observe();
    expect(f.store.stopped).not.toHaveBeenCalled();
    expect(f.store.block).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});
it('zoom-only status can restore a view while incomplete or moving status cannot', () => {
  const position = { Zoom: 0.3, ZoomSpace: 'zoom' };
  expect(samePtzPosition({ position }, { position, zoom: 'IDLE' })).toBe(true);
  expect(samePtzPosition({ position }, { position, zoom: 'MOVING' })).toBe(false);
  expect(samePtzPosition({ position }, { position: {}, zoom: 'IDLE' })).toBe(false);
});

it('rearming stores the new view baseline instead of immediately invalidating it again', async () => {
  const f = fixture();
  f.adapter.caps.position = true;
  const old = {
    position: { Pan: 0.1, Tilt: 0.2, Zoom: 0.3, PanTiltSpace: 'pan', ZoomSpace: 'zoom' },
  };
  const current = { position: { ...old.position, Pan: 0.8 }, panTilt: 'IDLE', zoom: 'IDLE' };
  vi.mocked(f.store.guard).mockResolvedValue({
    revision: 1,
    blocked: true,
    baseline: old,
    source_ids: ['root'],
    changed_at: '2026-10-27T00:00:00Z',
  });
  vi.mocked(f.adapter.call).mockImplementation(async (action) =>
    action === 'status' ? current : { stopConfirmed: true },
  );
  try {
    await f.manager.restoreView('root', 'operator', 1, 'rearmed');
    expect(f.store.restore).toHaveBeenCalledWith('motor-1', 1, 'operator', current);
  } finally {
    await f.manager.close();
  }
});

it('emergency Stop cancels an acquisition waiting for analytics readiness', async () => {
  const f = fixture();
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.deps.resetProcessors.mockImplementation(() => ready);
  const info = await f.manager.inspect('root');
  const acquiring = f.manager.acquire('root', 'operator', info.identity!);
  const rejected = expect(acquiring).rejects.toThrow('ptz_session_expired');
  await vi.waitFor(() => expect(f.deps.resetProcessors).toHaveBeenCalled());
  await f.manager.emergencyStop('root', 'operator');
  finish();
  await rejected;
  expect((await f.manager.inspect('root')).busy).toBe(false);
  expect(f.log).not.toContain('move');
  await f.manager.close();
});

it('stopping a successful acquisition with no issued movement restores only its own new pause', async () => {
  const f = fixture();
  vi.mocked(f.store.block).mockResolvedValue(7);
  try {
    const info = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', info.identity!);
    await f.manager.stop('root', lease.sessionId, 'operator');
    expect(f.store.restore).toHaveBeenCalledWith('motor-1', 7, 'operator', null);
    expect(f.deps.synchronize).toHaveBeenCalledTimes(2);
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});
it('an unused control lease never restores a pause that existed before acquisition', async () => {
  const f = fixture();
  vi.mocked(f.store.guard).mockResolvedValue({ blocked: true, baseline: { old: true } } as never);
  vi.mocked(f.store.block).mockResolvedValue(8);
  try {
    const info = await f.manager.inspect('root');
    const lease = await f.manager.acquire('root', 'operator', info.identity!);
    await f.manager.stop('root', lease.sessionId, 'operator');
    expect(f.store.restore).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});

it('unsupported analytics reset is rejected before pausing any rules', async () => {
  const f = fixture();
  (f.deps as any).checkProcessors = vi.fn(async () => {
    throw Error('ptz_tracking_reset_unsupported');
  });
  try {
    const info = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', info.identity!)).rejects.toThrow(
      'ptz_tracking_reset_unsupported',
    );
    expect(f.store.block).not.toHaveBeenCalled();
    expect(f.deps.resetProcessors).not.toHaveBeenCalled();
  } finally {
    await f.manager.close();
  }
});

it('exposes persistent protection without depending on a live AI service', async () => {
  const f = fixture();
  f.deps.ai.mockRejectedValue(Error('AI offline'));
  vi.mocked(f.store.guards).mockResolvedValue([
    {
      blocked: true,
      stop_pending: true,
      source_ids: ['root'],
      actor: 'ptz-external-motion',
      changed_at: '2026-10-27T08:00:00Z',
    },
  ] as never);
  const result = await f.manager.protection();
  expect(result.items[0]).toMatchObject({
    source: { id: 'root', name: 'Gate' },
    reason: 'external_motion',
    blocked: true,
    stopPending: true,
  });
  expect(f.deps.ai).not.toHaveBeenCalled();
  await f.manager.close();
});

it('a failed reset keeps protection and reports its paused state instead of a generic acquisition failure', async () => {
  const f = fixture();
  f.deps.resetProcessors.mockRejectedValue(Error('transport failed'));
  try {
    const info = await f.manager.inspect('root');
    await expect(f.manager.acquire('root', 'operator', info.identity!)).rejects.toThrow(
      'ptz_tracking_reset_pending',
    );
    expect(f.store.block).toHaveBeenCalled();
    expect(f.store.restore).not.toHaveBeenCalled();
    expect(f.log).not.toContain('move');
  } finally {
    await f.manager.close();
  }
});

for (const feedback of ['IDLE', 'MOVING', 'UNKNOWN', 'missing', 'error']) {
  it(`preset releases early only after repeated explicit idle: ${feedback}`, async () => {
    const f = fixture();
    f.adapter.caps.moveStatus = true;
    const original = f.adapter.call;
    f.adapter.call = async (action, body) => {
      if (action === 'status') {
        if (feedback === 'error') throw Error('offline');
        return feedback === 'missing' ? {} : { panTilt: feedback, zoom: feedback };
      }
      return original(action, body);
    };
    let now = 100000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const info = await f.manager.inspect('root');
      const lease = await f.manager.acquire('root', 'operator', info.identity!);
      const zero = { pan: 0, tilt: 0, zoom: 0 };
      await f.manager.command('root', lease.sessionId, 'operator', 1, zero, 'gate');
      now += 1000;
      const first = await f.manager.command(
        'root',
        lease.sessionId,
        'operator',
        2,
        zero,
        undefined,
        true,
      );
      expect(first.motionFinished).not.toBe(true);
      now += 600;
      const second = await f.manager.command(
        'root',
        lease.sessionId,
        'operator',
        3,
        zero,
        undefined,
        true,
      );
      expect(second.motionFinished === true).toBe(feedback === 'IDLE');
      // Finishing a preset never automatically validates the old armed view.
      expect(f.store.restore).not.toHaveBeenCalled();
    } finally {
      await f.manager.close();
      clock.mockRestore();
    }
  });
}
