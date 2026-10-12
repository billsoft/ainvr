import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigApply } from '../services/configApply.js';
import { triggerRestart } from '../services/restartHelperClient.js';
vi.mock('../services/restartHelperClient.js', () => ({
  isRestartableService: (s: string) => ['ai-service', 'recorder'].includes(s),
  restartHelperConfigFromEnv: () => ({ url: 'http://helper' }),
  triggerRestart: vi.fn(async () => ({ ok: true })),
}));
const published = () => Promise.resolve({ version: { version: 7 }, results: [{ ok: true }] } as any);
function setup(states: any[], timeout = 5000) {
  const store = { listServiceStates: vi.fn(async () => states), updateServiceState: vi.fn(async () => undefined), addAuditLog: vi.fn(async () => undefined) };
  return { manager: new ConfigApply(store as any, timeout), store };
}
describe('server-owned automatic apply', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() });
  afterEach(() => vi.useRealTimers());
  it('waits for exact desired/applied version, not publish acknowledgment', async () => {
    const states = [{ serviceName: 'recorder', desiredVersion: 7, appliedVersion: 6, status: 'pending' }];
    const { manager } = setup(states);
    const job = manager.start(['recorder'], published);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe('running');
    Object.assign(states[0], { appliedVersion: 7, status: 'applied', restartRequired: false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(job.status).toBe('succeeded');
  });
  it('automatically restarts once and requires fresh report without restart flag', async () => {
    const states = [{ serviceName: 'ai-service', desiredVersion: 7, appliedVersion: 7, status: 'applied', restartRequired: true, appliedAt: 'old' }];
    const { manager, store } = setup(states);
    const job = manager.start(['ai-service'], published);
    await vi.advanceTimersByTimeAsync(1600);
    expect(triggerRestart).toHaveBeenCalledTimes(1);
    expect(store.updateServiceState).toHaveBeenCalledWith(expect.objectContaining({ status: 'restarting' }));
    expect(job.status).toBe('running');
    Object.assign(states[0], { restartRequired: false, appliedAt: 'new' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(job.status).toBe('succeeded');
  });
  it('never locks forever on absent service report', async () => {
    const { manager } = setup([{ serviceName: 'recorder', desiredVersion: 7, status: 'pending' }]);
    const job = manager.start(['recorder'], published);
    await vi.advanceTimersByTimeAsync(6100);
    expect(job.status).toBe('timeout'); expect(manager.busy).toBe(false);
  });
  it('rejects overlapping operations and reports publish failure', async () => {
    const { manager } = setup([]);
    const job = manager.start(['backend'], () => Promise.reject(new Error('参数校验失败')));
    expect(() => manager.start(['backend'], published)).toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe('failed'); expect(manager.busy).toBe(false);
  });
  it('does not call a service applied when it reports failure', async () => {
    const { manager } = setup([{ serviceName: 'recorder', desiredVersion: 7, status: 'failed' }]);
    const job = manager.start(['recorder'], published);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe('failed');
  });
  it('keeps the previous result when a later save begins before browser polling', async () => {
    const { manager } = setup([{ serviceName: 'backend', desiredVersion: 7, appliedVersion: 7, status: 'applied' }]);
    const first = manager.start(['backend'], published);
    await vi.advanceTimersByTimeAsync(1);
    const second = manager.start(['backend'], published);
    expect(manager.get(first.id)?.status).toBe('succeeded');
    expect(manager.current?.id).toBe(second.id);
    await vi.advanceTimersByTimeAsync(1);
  });
  it('watchdog aborts stalled publish and releases the operation lock', async () => {
    const { manager } = setup([]);
    let signal: AbortSignal | undefined;
    const job = manager.start(['backend'], value => { signal = value; return new Promise(() => {}); });
    await vi.advanceTimersByTimeAsync(5100);
    expect(job.status).toBe('timeout'); expect(manager.busy).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});
