import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePtzControl } from '@/components/player/usePtzControl';
const api = vi.hoisted(() => ({ acquire: vi.fn(), center: vi.fn(), command: vi.fn(), stop: vi.fn(),
  visualCalibration: vi.fn(), saveVisualCalibration: vi.fn() }));
vi.mock('@/api/ptzService', () => ({ ptzService: api, ptzError: (e: Error) => e.message }));
vi.mock('@/store/toast', () => ({ toast: { error: vi.fn() } }));

const caps = { panTilt: true };
const manual = { pan: -1, tilt: 0, zoom: 0 };
function setup() {
  const video = document.createElement('video');
  Object.defineProperties(video, {videoWidth: {value: 1920}, videoHeight: {value: 1080}});
  const hook = renderHook(({ id }) => usePtzControl('camera', id, vi.fn()), { initialProps: { id: 'identity' } });
  const start = async (x = 0.32, y = 0) => {
    await act(async () => hook.result.current.centerPoint(x, y, video, caps));
  };
  return { video, ...hook, start };
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.acquire.mockImplementation(async () => ({ sessionId: 'lease-' + api.acquire.mock.calls.length, leaseMs: 1200 }));
  const records = (['pan','tilt'] as const).flatMap(axis => ([-1,1] as const).flatMap(sign =>
    [250,600,1000].flatMap(durationMs => [1,2].map(age => ({
      axis, sign, speed: .36, durationMs, displacement: durationMs / 1000, at: Date.now() - age,
    })))));
  api.visualCalibration.mockResolvedValue({scope: 'camera', estimator: 'neuflow-v1', epoch: 1,
    revision: 1, zoomEvidence: 'unknown', snapshot: {version: 1, records}});
  api.command.mockResolvedValue({});
  api.stop.mockResolvedValue({ stopConfirmed: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('prefers the native command even without readable video, and rejects invalid input', async () => {
  const { result, video } = setup();
  await act(async () => {
    result.current.centerPoint(NaN, 0, video, caps);
    result.current.centerPoint(1.1, 0, video, caps);
    result.current.centerPoint(0.3, 0, video, { panTilt: false });
    result.current.centerPoint(-0.3, 0.4, null, { panTilt: true, pointCenter: true });
  });
  expect(api.acquire).toHaveBeenCalledTimes(1);
  expect(api.center).toHaveBeenCalledExactlyOnceWith('camera', 'lease-1', 1, -0.3, 0.4);
  expect(api.command).not.toHaveBeenCalled();
});

it('arms Stop independently of slow Move acknowledgement', async () => {
  const { start } = setup();
  api.command.mockReturnValue(new Promise(() => {}));
  await start();
  await advance(330);
  expect(api.stop).toHaveBeenCalledExactlyOnceWith('camera', 'lease-1');
  await advance(9000);
  expect(api.command).toHaveBeenCalledTimes(1);
  expect(api.stop).toHaveBeenCalledTimes(1);
});

it.each(['exit', 'manual release', 'blur', 'switch identity', 'unmount'])(
  '%s during acquisition releases the late lease without sending a command', async action => {
    const { result, start, rerender, unmount } = setup();
    let accept!: (value: unknown) => void;
    api.acquire.mockReturnValue(new Promise(r => { accept = r; }));
    await start();
    act(() => {
      if (action === 'exit') result.current.stopScreenGesture();
      if (action === 'manual release') { result.current.begin(manual); void result.current.stop(); }
      if (action === 'blur') window.dispatchEvent(new Event('blur'));
      if (action === 'switch identity') rerender({ id: 'other' });
      if (action === 'unmount') unmount();
    });
    await act(async () => { accept({ sessionId: 'late', leaseMs: 1200 }); });
    await advance(9000);
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('camera', 'late');
    expect(api.command).not.toHaveBeenCalled();
    expect(api.acquire).toHaveBeenCalledTimes(1);
  });

it.each([false, true])('manual takeover requires acknowledged Stop (%s)', async confirmed => {
  const { result, start } = setup();
  let ack!: (v: unknown) => void;
  api.stop.mockReturnValueOnce(new Promise(r => { ack = r; }));
  await start();
  await advance(20);
  act(() => result.current.begin(manual));
  expect(api.acquire).toHaveBeenCalledTimes(1);
  await act(async () => { ack({ stopConfirmed: confirmed }); });
  expect(api.acquire).toHaveBeenCalledTimes(confirmed ? 2 : 1);
  if (confirmed) expect(api.command).toHaveBeenLastCalledWith('camera', 'lease-2', 1, manual, false);
  await act(async () => { expect(await result.current.stopConfirmed()).toBe(confirmed); });
});

it('returns false after a pulse Stop fails and never sends another pulse', async () => {
  const { start, result } = setup();
  api.stop.mockResolvedValue({ stopConfirmed: false });
  await start();
  await advance(2000);
  expect(api.command).toHaveBeenCalledTimes(1);
  expect(api.stop).toHaveBeenCalledTimes(1);
  expect(result.current.error).toBe('ptz_stop_unconfirmed');
  expect(await result.current.stopConfirmed()).toBe(false);
  act(() => result.current.begin(manual));
  expect(api.acquire).toHaveBeenCalledTimes(1);
  await act(async () => { await expect(result.current.priorityStop()).rejects.toThrow('ptz_stop_unconfirmed'); });
  expect(await result.current.stopConfirmed()).toBe(false);
  api.stop.mockResolvedValue({stopConfirmed:true});
  await act(async () => { await result.current.priorityStop(); });
  expect(api.stop).toHaveBeenLastCalledWith('camera', null);
  expect(result.current.error).toBe('');
  await start();
  expect(api.acquire).toHaveBeenCalledTimes(2);
});

it('refuses to move when the lease is denied', async () => {
  const { result, start } = setup();
  api.acquire.mockRejectedValue(Error('ptz_disabled'));
  await start();
  await advance(1000);
  expect(api.command).not.toHaveBeenCalled();
  expect(result.current.error).toBe('ptz_disabled');
  expect(result.current.notice).toBe('');
});

it('deduplicates the same point during a slow lease and during motion', async () => {
  const { start } = setup();
  let grant!: (value: unknown) => void;
  api.acquire.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  await start();
  await start();
  expect(api.acquire).toHaveBeenCalledTimes(1);
  expect(api.stop).not.toHaveBeenCalled();
  await act(async () => grant({ sessionId: 'original', leaseMs: 1200 }));
  await advance(20);
  await start();
  expect(api.command).toHaveBeenCalledTimes(1);
  expect(api.stop).not.toHaveBeenCalled();
});

it.each(['confirmed', 'unconfirmed', 'cancelled'])('keeps only the newest distinct click after Stop is %s', async status => {
  const { result, start } = setup();
  let ack!: (value: unknown) => void;
  api.stop.mockReturnValueOnce(new Promise(resolve => { ack = resolve; }));
  await start(0.7, 0);
  await advance(20);
  await start(0, 0.8);
  await start(-0.8, 0);
  await start(-0.8, 0);
  expect(api.acquire).toHaveBeenCalledTimes(1);
  expect(api.stop).toHaveBeenCalledTimes(1);
  if (status === 'cancelled') act(() => result.current.stopScreenGesture());
  await act(async () => ack({ stopConfirmed: status !== 'unconfirmed' }));
  await advance(1500);
  expect(api.command).toHaveBeenCalledTimes(status === 'confirmed' ? 2 : 1);
  if (status === 'confirmed') {
    expect(api.command).toHaveBeenLastCalledWith('camera', 'lease-2', 1, {
      pan: expect.closeTo(-0.36), tilt: 0, zoom: 0,
    });
    expect(result.current.notice).toContain('历史标定');
  } else {
    expect(result.current.notice).toBe('');
  }
});

it('coalesces native retargets during acquisition and grants only the latest click', async () => {
  const { result } = setup();
  let grant!: (v: unknown) => void;
  api.acquire.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  const click = (x: number) => result.current.centerPoint(x, 0, null, { panTilt: true, pointCenter: true });
  act(() => { click(0.7); click(0.7); click(-0.4); click(0.2); click(0.2); });
  expect(api.acquire).toHaveBeenCalledTimes(1);
  await act(async () => grant({ sessionId: 'old', leaseMs: 1200 }));
  expect(api.stop).toHaveBeenCalledExactlyOnceWith('camera', 'old');
  expect(api.acquire).toHaveBeenCalledTimes(2);
  expect(api.center).toHaveBeenCalledExactlyOnceWith('camera', 'lease-2', 1, 0.2, 0);
  expect(api.command).not.toHaveBeenCalled();
});

it('a late failure from the superseded pulse cannot stop or report over its replacement', async () => {
  const { start, result } = setup();
  let reject!: (e: Error) => void;
  api.command.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  await start(0.8);
  await advance(20);
  await start(-0.8);
  await advance(20);
  expect(api.command).toHaveBeenCalledTimes(2);
  await act(async () => reject(Error('old command')));
  expect(result.current.state).toBe('moving');
  expect(result.current.error).toBe('');
  expect(api.stop).toHaveBeenCalledTimes(1);
  await advance(1000);
  expect(result.current.notice).toContain('历史标定');
});

it.each([true, false])('reports the first background cancellation only after Stop (%s)', async ok => {
  const {result, start} = setup();
  let ack!: (v: unknown) => void;
  api.stop.mockReturnValueOnce(new Promise(r => { ack=r; }));
  await start();
  await advance(50);
  act(() => window.dispatchEvent(new Event('blur')));
  act(() => result.current.stopScreenGesture(true));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.notice).toBe('');
  await act(async () => ack({stopConfirmed:ok}));
  expect(result.current.notice).toBe(ok ? '窗口已失去焦点，已取消点击居中并确认停转。' : '');
  expect(result.current.error).toBe(ok ? '' : 'ptz_stop_unconfirmed');
});

it('same-identity refresh keeps moving and a new point supersedes a hidden-page notice', async () => {
  const {start, rerender, result} = setup();
  await start();
  await advance(45);
  rerender({id:'identity'});
  expect(api.stop).not.toHaveBeenCalled();
  let ack!: (v: unknown) => void;
  api.stop.mockReturnValueOnce(new Promise(r => { ack=r; }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await start(-0.4);
  await act(async () => ack({stopConfirmed:true}));
  await advance(40);
  expect(result.current.notice).toBe('');
  expect(api.command.mock.calls.at(-1)![3].pan).toBeLessThan(0);
});
