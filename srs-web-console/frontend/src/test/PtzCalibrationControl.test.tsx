import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePtzControl } from '@/components/player/usePtzControl';

const api = vi.hoisted(() => ({visualCalibration: vi.fn(), saveVisualCalibration: vi.fn(),
  measureFlow: vi.fn(), acquire: vi.fn(), command: vi.fn(), stop: vi.fn()}));
vi.mock('@/api/ptzService', () => ({ptzService: api, ptzError: (e: Error) => e.message}));
vi.mock('@/store/toast', () => ({toast: {error: vi.fn()}}));
const video = {videoWidth: 1920, videoHeight: 1080} as HTMLVideoElement;
const caps = {pointCenter: false, panTilt: true};
function history() {
  const records = (['pan','tilt'] as const).flatMap(axis => ([-1,1] as const).flatMap(sign =>
    [250,600,1000].flatMap(durationMs => [1,2].map(age => ({
      axis, sign, durationMs, speed: .36, displacement: durationMs / 1000, at: Date.now() - age,
    })))));
  return {scope:'geometry-and-zoom', epoch:7, revision:24, estimator:'neuflow-v1',
    zoomEvidence:'unknown', snapshot:{version:1,records}};
}
function mount() {
  return renderHook(() => usePtzControl('camera','identity',()=>{}));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.visualCalibration.mockResolvedValue(history());
  api.acquire.mockResolvedValue({sessionId:'lease',leaseMs:1200});
  api.command.mockResolvedValue({});
  api.stop.mockResolvedValue({stopConfirmed:true});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('reuses current unknown zoom after a remount without sampling, measuring or saving', async () => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype,'getContext');
  for (let page = 0; page < 2; page++) {
    const {result,unmount} = mount();
    await act(async () => result.current.centerPoint(.6,.24,video,caps));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.notice).toContain('历史标定');
    unmount();
  }
  expect(api.visualCalibration).toHaveBeenCalledWith('camera','identity',1920,1080,expect.any(AbortSignal),'neuflow-v1');
  expect(api.acquire.mock.calls).toEqual(Array(2).fill(['camera','identity',7]));
  expect(api.command.mock.calls).toEqual(Array(2).fill([
    ['camera','lease',1,{pan:.36,tilt:.36,zoom:0}],
    ['camera','lease',2,{pan:.36,tilt:0,zoom:0}],
  ]).flat());
  expect(api.stop).toHaveBeenCalledTimes(2);
  expect(canvas).not.toHaveBeenCalled();
  expect(api.measureFlow).not.toHaveBeenCalled();
  expect(api.saveVisualCalibration).not.toHaveBeenCalled();
});

it.each(['empty','wrong estimator','unavailable'])('requires calibration for %s history and never acquires', async kind => {
  if (kind === 'empty') api.visualCalibration.mockResolvedValue({...history(),snapshot:{version:1,records:[]}});
  if (kind === 'wrong estimator') api.visualCalibration.mockResolvedValue({...history(),estimator:undefined});
  if (kind === 'unavailable') api.visualCalibration.mockRejectedValue(Error('offline'));
  const {result} = mount();
  await act(async () => result.current.centerPoint(.5,0,video,caps));
  if (kind === 'unavailable') {
    expect(result.current.error).toBe('offline');
    expect(result.current.notice).toBe('');
  } else expect(result.current.notice).toContain('先完成当前倍率标定');
  expect(api.acquire).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
  expect(api.measureFlow).not.toHaveBeenCalled();
  expect(api.saveVisualCalibration).not.toHaveBeenCalled();
});

it('does not fall back when zoom changes between read and acquire', async () => {
  api.acquire.mockRejectedValue(Error('ptz_calibration_stale'));
  const {result} = mount();
  await act(async () => result.current.centerPoint(.5,0,video,caps));
  expect(result.current.notice).toContain('先完成当前倍率标定');
  expect(api.acquire).toHaveBeenCalledExactlyOnceWith('camera','identity',7);
  expect(api.command).not.toHaveBeenCalled();
});

it('ignores a late read after loss of focus', async () => {
  let deliver!: (value: ReturnType<typeof history>) => void;
  api.visualCalibration.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  const {result} = mount();
  act(() => result.current.centerPoint(.5,0,video,caps));
  await act(async () => window.dispatchEvent(new Event('blur')));
  await act(async () => deliver(history()));
  expect(api.acquire).not.toHaveBeenCalled();
  expect(api.command).not.toHaveBeenCalled();
});
