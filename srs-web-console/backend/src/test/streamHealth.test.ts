import { describe, it, expect, vi } from 'vitest';
import { createStreamHealthMonitor, type AiChannelRow, type RecorderRow } from '../services/streamHealth.js';

const hour = new Date(2026, 10, 17, 14, 0, 0).getTime();
function setup(ai: AiChannelRow[], rec: RecorderRow[]) {
  let now = hour;
  const log = vi.fn();
  const state = { ai, rec };
  const monitor = createStreamHealthMonitor({
    readAi: async () => state.ai, readRecorder: async () => state.rec,
    now: () => now, log, graceMs: 30000,
  });
  return { monitor, log, state, advance: (ms: number) => { now += ms; } };
}
const recording = (patch: Partial<RecorderRow> = {}): RecorderRow => ({ id: 'rec-1', name: '大门', scheduleEnabled: true, scheduleHours: [14], recordingState: 'recording', recordingDetail: '正在录制', ...patch });

describe('stream health: interruptions are visible, not silent', () => {
  it('an AI channel stuck reconnecting becomes an interruption after the grace period and is logged once', async () => {
    const { monitor, log, advance } = setup([{ id: 'ai-1', name: '过道', state: 'reconnecting' }], []);
    await monitor.poll();
    expect(monitor.snapshot().problems).toEqual([]);
    advance(31000); await monitor.poll(); advance(10000); await monitor.poll();
    const [problem] = monitor.snapshot().problems;
    expect(problem).toMatchObject({ kind: 'ai', id: 'ai-1', name: '过道', since: hour });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(['WARN', expect.stringContaining('过道')]);
  });

  it('a scheduled recording that is not writing is an interruption; recovery logs how long the gap lasted', async () => {
    const { monitor, log, state, advance } = setup([], [recording({ recordingState: 'waiting_source', recordingDetail: '等待源流或录制进程恢复' })]);
    await monitor.poll(); advance(65000); await monitor.poll();
    expect(monitor.snapshot().problems).toMatchObject([{ kind: 'recording', id: 'rec-1', name: '大门' }]);
    state.rec = [recording()];
    advance(5000); await monitor.poll();
    expect(monitor.snapshot().problems).toEqual([]);
    expect(log).toHaveBeenLastCalledWith('INFO', expect.stringMatching(/大门.*恢复.*1 分 10 秒/));
  });

  it('short blips under the grace period are neither shown nor logged', async () => {
    const { monitor, log, state, advance } = setup([{ id: 'ai-1', name: '过道', state: 'reconnecting' }], []);
    await monitor.poll(); advance(10000);
    state.ai = [{ id: 'ai-1', name: '过道', state: 'running' }];
    await monitor.poll();
    expect(monitor.snapshot().problems).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('channels the user turned off, or hours outside the recording plan, are not interruptions', async () => {
    const { monitor, advance } = setup(
      [{ id: 'ai-1', name: '停用', state: 'stopped' }, { id: 'ai-2', name: '空闲', state: 'idle' }],
      [recording({ id: 'r1', recordingState: 'disabled' }), recording({ id: 'r2', scheduleEnabled: false, recordingState: 'waiting_source' }),
        recording({ id: 'r3', scheduleHours: [3], recordingState: 'waiting_source' })]);
    await monitor.poll(); advance(60000); await monitor.poll();
    expect(monitor.snapshot().problems).toEqual([]);
  });

  it('when a service cannot be read the state is unknown, not healthy', async () => {
    const log = vi.fn();
    const monitor = createStreamHealthMonitor({ readAi: async () => { throw Error('down'); }, readRecorder: async () => [], log });
    await monitor.poll();
    expect(monitor.snapshot().known).toBe(false);
  });
});
