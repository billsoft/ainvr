import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import { usePtzControl } from '@/components/player/usePtzControl';
const api = vi.hoisted(() => ({
  acquire: vi.fn(),
  center: vi.fn(),
  command: vi.fn(),
  stop: vi.fn(),
  goto: vi.fn(),
}));
vi.mock('@/api/ptzService', () => ({ ptzService: api, ptzError: (e: Error) => e.message }));
vi.mock('@/store/toast', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  api.acquire.mockResolvedValue({ sessionId: 'lease', leaseMs: 1200 });
  api.command.mockResolvedValue({});
  api.stop.mockResolvedValue({ stopConfirmed: true });
  api.goto.mockResolvedValue({});
});
it('a release during preparation never sends a late Move and coalesces Stop', async () => {
  let accept!: (v: any) => void;
  api.acquire.mockReturnValue(
    new Promise((r) => {
      accept = r;
    }),
  );
  const { result, unmount } = renderHook(() => usePtzControl('camera', 'identity', () => {}));
  act(() => result.current.begin({ pan: 1, tilt: 0, zoom: 0 }));
  let stopped!: Promise<void>;
  act(() => {
    stopped = result.current.stop();
    void result.current.stop();
  });
  await act(async () => {
    accept({ sessionId: 'lease', leaseMs: 1200 });
    await stopped;
  });
  expect(api.command).not.toHaveBeenCalled();
  expect(api.stop).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBe('idle');
  unmount();
});
it('stops on blur without retrying a failed movement', async () => {
  api.command.mockRejectedValueOnce(Error('ptz_unavailable'));
  const { result, unmount } = renderHook(() => usePtzControl('camera', 'identity', () => {}));
  act(() => result.current.begin({ pan: 0, tilt: 0, zoom: 1 }));
  await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(1));
  expect(api.command).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event('blur'));
  });
  expect(api.command).toHaveBeenCalledTimes(1);
  unmount();
});
it('unmount stops an active physical camera and cancels renewals', async () => {
  const { result, unmount } = renderHook(() => usePtzControl('camera', 'identity', () => {}));
  act(() => result.current.begin({ pan: -0.3, tilt: 0, zoom: 0 }));
  await waitFor(() => expect(result.current.state).toBe('moving'));
  unmount();
  expect(api.stop).toHaveBeenCalledWith('camera', 'lease');
});
it('preset invokes Goto once and a later update renews rather than replays Goto', async () => {
  vi.useFakeTimers();
  try {
    const { result, unmount } = renderHook(() => usePtzControl('camera', 'identity', () => {}));
    await act(async () => {
      result.current.begin({ pan: 0, tilt: 0, zoom: 0 }, 'gate');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(api.goto).toHaveBeenCalledTimes(1);
    expect(api.command).toHaveBeenCalledWith(
      'camera',
      'lease',
      2,
      { pan: 0, tilt: 0, zoom: 0 },
      true,
    );
    unmount();
  } finally {
    vi.useRealTimers();
  }
});

it('pins the expected definition on the actual goto request for protected returns',async()=>{
 const {result}=renderHook(()=>usePtzControl('camera','identity',()=>{}))
 act(()=>result.current.begin({pan:0,tilt:0,zoom:0},{id:'gate',fingerprint:'expected'}))
 await waitFor(()=>expect(api.goto).toHaveBeenCalledWith('camera','gate','lease',1,'expected'))
})
it('reports preset timeout only after confirmed Stop even with a renewal in flight', async () => {
  vi.useFakeTimers();
  try {
    let ackStop!: (v:unknown) => void, ackRenewal!: (v:unknown) => void;
    api.stop.mockReturnValueOnce(new Promise(resolve => { ackStop=resolve; }));
    const completed=vi.fn();
    const {result,unmount}=renderHook(() => usePtzControl('camera','identity',()=>{}));
    await act(async () => { result.current.begin({pan:0,tilt:0,zoom:0},'gate',completed); });
    await act(async () => { await vi.advanceTimersByTimeAsync(29000); });
    api.command.mockReturnValueOnce(new Promise(resolve => { ackRenewal=resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('camera','lease');
    expect(result.current.state).toBe('stopping');
    expect(result.current.notice).toBe('');
    expect(completed).not.toHaveBeenCalled();
    const renewals=api.command.mock.calls.length;
    await act(async () => { ackStop({stopConfirmed:true}); });
    expect(result.current.state).toBe('idle');
    expect(completed).toHaveBeenCalledExactlyOnceWith(false);
    expect(result.current.notice).toBe('已停止等待，设备未确认到位；请核对画面');
    await act(async () => { ackRenewal({motionFinished:true}); await vi.advanceTimersByTimeAsync(1000); });
    expect(api.command).toHaveBeenCalledTimes(renewals);
    expect(completed).toHaveBeenCalledExactlyOnceWith(false);
    unmount();
  } finally { vi.useRealTimers(); }
});

it('a late acquisition for a previous channel stops the original camera only', async () => {
  let accept!: (v: any) => void;
  api.acquire.mockReturnValue(
    new Promise((r) => {
      accept = r;
    }),
  );
  const { result, rerender, unmount } = renderHook(
    ({ id }) => usePtzControl(id, 'identity', () => {}),
    { initialProps: { id: 'original-camera' } },
  );
  act(() => result.current.begin({ pan: 1, tilt: 0, zoom: 0 }));
  rerender({ id: 'replacement-camera' });
  await act(async () => {
    accept({ sessionId: 'old-lease', leaseMs: 1200 });
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(api.stop).toHaveBeenCalledWith('original-camera', 'old-lease'));
  expect(api.command).not.toHaveBeenCalled();
  unmount();
});

it('sends a clicked point once, then only renews the lease', async () => {
  vi.useFakeTimers();
  try {
    api.center.mockResolvedValue({});
    api.command.mockResolvedValue({ motionFinished:true });
    const { result, unmount } = renderHook(() => usePtzControl('camera','identity',()=>{}));
    const finished=vi.fn();
    await act(async () => { result.current.begin({pan:0,tilt:0,zoom:0},undefined,finished,{x:.25,y:-.5}); });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(api.center).toHaveBeenCalledExactlyOnceWith('camera','lease',1,.25,-.5);
    expect(api.command).toHaveBeenCalledExactlyOnceWith('camera','lease',2,{pan:0,tilt:0,zoom:0},true);
    expect(finished).toHaveBeenCalledExactlyOnceWith(true);
    unmount();
  } finally {vi.useRealTimers();}
});

it('switches from click-to-center to the latest wheel direction after stop acknowledgement',async()=>{
  let done!: (r:unknown)=>void;
  api.stop.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve}));
  const {result,unmount}=renderHook(()=>usePtzControl('camera','identity',()=>{}));
  await act(async()=>result.current.begin({pan:0,tilt:0,zoom:0},undefined,undefined,{x:.5,y:0}));
  act(()=>{void result.current.zoomStep(.4); void result.current.zoomStep(-.4)});
  expect(api.acquire).toHaveBeenCalledTimes(1);
  await act(async()=>done({stopConfirmed:true}));
  expect(api.acquire).toHaveBeenCalledTimes(2);
  expect(api.command).toHaveBeenCalledWith('camera','lease',1,{pan:0,tilt:0,zoom:-.4},false);
  unmount();
});
