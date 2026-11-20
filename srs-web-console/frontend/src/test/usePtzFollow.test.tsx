import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AiDetection } from '@/types/aiChannel';
import { ptzService } from '@/api/ptzService';
import { usePtzFollow } from '@/components/player/usePtzFollow';

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const a = 'ai:g:1:7', b = 'ai:g:1:8', c = 'ai:g:1:9';
const ids = [a,b,c];
const choices = ids.map(id => ({ id, label:'chair', x:.5, y:.5, w:.2, h:.2 }));
function setup() {
  const open = vi.spyOn(ptzService, 'followSession').mockResolvedValue({sessionId:'lease'});
  const step = vi.spyOn(ptzService, 'followStep').mockResolvedValue({choices});
  const stop = vi.spyOn(ptzService, 'stop').mockResolvedValue({stopConfirmed:true});
  const displayedTracks = {current: () => ids.map(track_id => ({track_id, class_name:'chair'} as AiDetection))};
  const options = {enabled:true, camera:'output', processor:'ai', identity:'binding', displayedTracks};
  const mount = () => renderHook(usePtzFollow, {initialProps: options});
  return { mount, options, open, step, stop, displayedTracks };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

it('prepares without motion, accepts the first ready click and switches on one lease', async () => {
  const f = setup();
  const opening = deferred<{sessionId:string}>();
  f.open.mockReturnValueOnce(opening.promise);
  const ui = f.mount();
  await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
  expect(ui.result.current.ownsLease).toBe(true);
  expect(ui.result.current.pickReady).toBe(false);
  act(() => ui.result.current.pick(a));
  expect(ui.result.current.selectedId).toBeNull();
  await act(async () => opening.resolve({sessionId:'lease'}));
  await waitFor(() => expect(ui.result.current.pickReady).toBe(true));
  expect(f.step.mock.calls).toEqual([['output','lease',undefined]]);
  act(() => ui.result.current.pick(a));
  await waitFor(() => expect(f.step).toHaveBeenCalledWith('output','lease',a));
  expect(f.step.mock.calls[0]).toEqual(['output','lease',undefined]);
  act(() => ui.result.current.pick(b));
  await waitFor(() => expect(f.step).toHaveBeenLastCalledWith('output','lease',b));
  expect(f.open).toHaveBeenCalledTimes(1);
  ui.unmount();
  await waitFor(() => expect(f.stop.mock.calls).toEqual([['output','lease']]));
});

it('rejects stale, ambiguous and predicted clicks without motion', async () => {
  const f = setup();
  f.displayedTracks.current = () => [{track_id:a,predicted:true},{track_id:b,lowConfidence:true},
    {track_id:c},{track_id:c}] as AiDetection[];
  const ui = f.mount();
  await waitFor(() => expect(f.step).toHaveBeenCalled());
  expect(ui.result.current.pickReady).toBe(false);
  for (const id of [...ids,'7']) act(() => ui.result.current.pick(id));
  expect(ui.result.current.selectedId).toBeNull();
  expect(f.step.mock.calls.every(call => call[2] === undefined)).toBe(true);
});

it('enables picking only after the reset ID reaches the displayed frame and stops on mode exit', async () => {
  const f = setup();
  const fresh = 'ai:new:1:7';
  f.step.mockResolvedValue({choices:[{...choices[0]!,id:fresh}]});
  const ui = f.mount();
  await waitFor(() => expect(f.step).toHaveBeenCalled());
  expect(ui.result.current.pickReady).toBe(false);
  act(() => ui.result.current.pick(a));
  expect(ui.result.current.selectedId).toBeNull();
  f.displayedTracks.current = () => [{track_id:fresh} as AiDetection];
  await waitFor(() => expect(ui.result.current.pickReady).toBe(true));
  act(() => ui.result.current.pick(fresh));
  await waitFor(() => expect(ui.result.current.statusText).toContain('跟踪中'));
  ui.rerender({...f.options,enabled:false});
  await waitFor(() => expect(ui.result.current.ownsLease).toBe(false));
  expect(ui.result.current.pickReady).toBe(false);
  expect(ui.result.current.selectedId).toBeNull();
  expect(f.stop.mock.calls).toEqual([['output','lease']]);
});

it('releases after 20 idle seconds, rearms on click, and requires a fresh click for a recycled short ID', async () => {
  vi.useFakeTimers();
  const f = setup();
  const next = 'ai:new:1:7';
  const ui = f.mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(f.stop.mock.calls).toEqual([['output','lease']]);
  expect(ui.result.current.ownsLease).toBe(false);
  expect(ui.result.current.pickReady).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(f.open).toHaveBeenCalledTimes(1);
  f.step.mockResolvedValue({choices:[{...choices[0]!, id:next}]});
  await act(async () => ui.result.current.pick(a));
  expect(ui.result.current.statusText).toContain('再次点击');
  expect(ui.result.current.selectedId).toBeNull();
  expect(f.step.mock.calls.every(call => call[2] === undefined)).toBe(true);
  f.displayedTracks.current = () => [{track_id:next} as AiDetection];
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  act(() => ui.result.current.pick(next));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.step).toHaveBeenCalledWith('output','lease',next);
  expect(f.open).toHaveBeenCalledTimes(2);
});

it('coalesces rapid clicks during an A step and never sends the superseded B', async () => {
  const f = setup();
  const pending = deferred<{choices: typeof choices}>();
  f.step.mockImplementation(async (_camera, _lease, track) => track === a ? pending.promise : {choices});
  const ui = f.mount();
  await waitFor(() => expect(ui.result.current.pickReady).toBe(true));
  act(() => ui.result.current.pick(a));
  await waitFor(() => expect(f.step).toHaveBeenCalledWith('output','lease',a));
  act(() => { ui.result.current.pick(b); ui.result.current.pick(c); });
  expect(f.step).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({choices}));
  await waitFor(() => expect(f.step).toHaveBeenLastCalledWith('output','lease',c));
  expect(ui.result.current.selectedId).toBe(c);
  expect(f.step.mock.calls.map(call => call[2])).not.toContain(b);
  expect(f.open).toHaveBeenCalledTimes(1);
});

it.each(['display','server','low-confidence'])('retains selection for four confirmed seconds on %s loss, then waits for a new click', async source => {
  const f = await tracking();
  f.step.mockImplementation(async (_c,_s,track,brake,epoch) => {
    if (brake && !track) return {choices:[],reselect:true,displayEpoch:epoch!+1};
    if (track) return {choices:choices.slice(1),moving:false,waiting:true,holdMs:4000};
    return {choices};
  });
  if (source!=='server') f.displayedTracks.current=() => ids.filter(id => id!==a || source==='low-confidence')
    .map(track_id => ({track_id,lowConfidence:track_id===a} as AiDetection));
  await f.advance(3200);
  expect(f.ui.result.current.selectedId).toBe(a);
  await f.advance(1100);
  expect(f.ui.result.current.selectedId).toBeNull();
  expect(f.ui.result.current.ownsLease).toBe(true);
  expect(f.stop).not.toHaveBeenCalled();
  await f.advance(20_000);
  expect(f.stop.mock.calls).toEqual([['output','lease']]);
});

it('waits for late acquisition and stop confirmation before manual handoff', async () => {
  const f = setup();
  const opening = deferred<{sessionId:string}>();
  const braking = deferred<{stopConfirmed:boolean}>();
  f.open.mockReturnValueOnce(opening.promise);
  f.stop.mockReturnValueOnce(braking.promise);
  const ui = f.mount();
  await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
  let handoff!: Promise<boolean>;
  const manual = vi.fn();
  act(() => { handoff = ui.result.current.stop().then(ok => { if (ok) manual(); return ok; }); });
  ui.rerender({...f.options, enabled:false});
  await act(async () => opening.resolve({sessionId:'late'}));
  expect(f.stop.mock.calls).toEqual([['output','late']]);
  expect(manual).not.toHaveBeenCalled();
  await act(async () => { braking.resolve({stopConfirmed:true}); expect(await handoff).toBe(true); });
  expect(manual).toHaveBeenCalledTimes(1);
  expect(f.step).not.toHaveBeenCalled();
  act(() => ui.result.current.pick(a));
  expect(f.open).toHaveBeenCalledTimes(1);
});

async function tracking() {
  vi.useFakeTimers();
  const f = setup();
  const ui = f.mount();
  const advance = (ms:number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await advance(0);
  act(() => ui.result.current.pick(a));
  await advance(1);
  expect(ui.result.current.statusText).toContain('跟踪中');
  return {...f,ui,advance};
}

it('targets a 125ms start interval and skips missed slots during a slow request', async () => {
  const f=await tracking();
  const starts:number[]=[];
  let inFlight=0, peak=0;
  f.step.mockImplementation(async () => {
    starts.push(performance.now());
    peak=Math.max(peak,++inFlight);
    await new Promise(resolve => setTimeout(resolve,starts.length===2 ? 205 : 70));
    --inFlight;
    return {choices};
  });
  await f.advance(585);
  expect(peak).toBe(1);
  expect(starts.length).toBe(4);
  expect(starts[1]!-starts[0]!).toBe(125);
  expect(starts[2]!-starts[1]!).toBeGreaterThanOrEqual(205);
  expect(starts[2]!-starts[1]!).toBeLessThanOrEqual(206);
  expect(starts[3]!-starts[2]!).toBe(125);
});

it('brakes while a moving step is pending, ignores its late choices and resumes only A after confirmation', async () => {
  const f = await tracking();
  const old = deferred<{choices:typeof choices}>();
  const brake = deferred<{choices:typeof choices;moving:false;holdMs:number}>();
  f.step.mockReturnValueOnce(old.promise).mockReturnValueOnce(brake.promise);
  await f.advance(200);
  const displayed = f.displayedTracks.current;
  f.displayedTracks.current = () => displayed().filter(d => d.track_id !== a);
  await f.advance(17);
  expect(f.step).toHaveBeenLastCalledWith('output','lease',a,true,1);
  expect(f.ui.result.current.pickReady).toBe(false);
  act(() => f.ui.result.current.pick(b));
  f.displayedTracks.current = displayed;
  await act(async () => old.resolve({choices}));
  await f.advance(900);
  expect(f.step).toHaveBeenCalledTimes(4);
  await act(async () => brake.resolve({choices:[],moving:false,holdMs:4000}));
  await f.advance(1);
  expect(f.step).toHaveBeenLastCalledWith('output','lease',a,false,1);
  expect(f.ui.result.current.statusText).toContain('跟踪中');
  expect(f.stop).not.toHaveBeenCalled();
});

it('continues on the same lease after a server-only miss', async () => {
  const f = await tracking();
  f.step.mockResolvedValueOnce({choices:choices.slice(1)});
  await f.advance(200);
  expect(f.ui.result.current.pickReady).toBe(false);
  f.step.mockResolvedValueOnce({choices,waiting:true});
  await f.advance(100);
  expect(f.ui.result.current.pickReady).toBe(false);
  await f.advance(100);
  expect(f.ui.result.current.selectedId).toBe(a);
  expect(f.ui.result.current.statusText).toContain('跟踪中');
  expect(f.stop).not.toHaveBeenCalled();
});

it.each(['hidden','error','expired'])('ends the held lease on %s and ignores late replies', async reason => {
  const f = await tracking();
  const brake = deferred<{choices:typeof choices}>();
  if (reason === 'error') f.step.mockRejectedValueOnce(Error('ptz_stop_unconfirmed'));
  else if (reason === 'expired') f.step.mockRejectedValueOnce(Error('ptz_session_expired'));
  else f.step.mockReturnValueOnce(brake.promise);
  f.displayedTracks.current = () => [];
  await f.advance(17);
  const count = f.step.mock.calls.length;
  if (reason === 'hidden') {
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
  }
  await f.advance(17);
  await act(async () => brake.resolve({choices}));
  expect(f.stop.mock.calls).toEqual([['output','lease']]);
  expect(f.ui.result.current.ownsLease).toBe(false);
  expect(f.step).toHaveBeenCalledTimes(count);
});

it('retries a busy brake with the same epoch, preserves the four-second bound and refuses a recycled ID', async () => {
  const f=await tracking();
  f.displayedTracks.current=() => [];
  f.step.mockRejectedValueOnce(Error('ptz_busy')).mockResolvedValueOnce({choices:[],moving:false,holdMs:4000});
  await f.advance(3000);
  expect(f.step.mock.calls.filter(call => call[3])).toEqual([
    ['output','lease',a,true,1],['output','lease',a,true,1],
  ]);
  expect(f.ui.result.current.selectedId).toBe(a);
  f.step.mockResolvedValueOnce({choices:[],reselect:true,displayEpoch:3});
  f.displayedTracks.current=() => [{track_id:'ai:other:1:7'} as AiDetection];
  await f.advance(25);
  expect(f.ui.result.current.selectedId).toBeNull();
  expect(f.ui.result.current.ownsLease).toBe(true);
  expect(f.step.mock.calls.some(call => call[2]==='ai:other:1:7')).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
});

it('discards an idle rearm click when even the first server choice list is empty', async () => {
  vi.useFakeTimers();
  const f = setup();
  const ui = f.mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  f.step.mockResolvedValueOnce({choices:[]});
  await act(async () => ui.result.current.pick(a));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(ui.result.current.selectedId).toBeNull();
  expect(ui.result.current.pickReady).toBe(true);
  expect(f.step.mock.calls.every(call => call[2] === undefined)).toBe(true);
});

it('keeps A across a three-second displayed gap, an obsolete expiry and a busy recovery', async () => {
  const f=await tracking();
  let rejectOld!: (e:Error) => void;
  f.step.mockImplementationOnce(() => new Promise((_resolve,reject) => { rejectOld=reject; }));
  await f.advance(200);
  const visible=f.displayedTracks.current;
  f.displayedTracks.current=() => [];
  f.step.mockResolvedValueOnce({choices:[],moving:false,holdMs:4000});
  await f.advance(17);
  await act(async () => rejectOld(Error('ptz_session_expired')));
  await f.advance(3000);
  expect(f.ui.result.current.selectedId).toBe(a);
  expect(f.step.mock.calls.at(-1)).toEqual(['output','lease',a,true,1]);
  f.displayedTracks.current=visible;
  f.step.mockRejectedValueOnce(Error('ptz_busy'));
  await f.advance(150);
  expect(f.ui.result.current.statusText).toContain('跟踪中');
  expect(f.step.mock.calls.at(-1)).toEqual(['output','lease',a,false,1]);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.open).toHaveBeenCalledTimes(1);
});

it('ignores late step results and retains the exact lease for retry after unconfirmed stop', async () => {
  const f = setup();
  const ui = f.mount();
  const pending = deferred<{choices: typeof choices}>();
  f.step.mockReturnValueOnce(pending.promise);
  act(() => ui.result.current.pick(a));
  await waitFor(() => expect(f.step).toHaveBeenCalled());
  f.stop.mockResolvedValueOnce({stopConfirmed:false});
  await act(async () => expect(await ui.result.current.stop()).toBe(false));
  await act(async () => pending.resolve({choices}));
  expect(ui.result.current.statusText).toContain('停止尚未确认');
  expect(ui.result.current.ownsLease).toBe(true);
  act(() => ui.result.current.pick(b));
  await act(async () => expect(await ui.result.current.stop()).toBe(true));
  expect(f.stop.mock.calls).toEqual([['output','lease'],['output','lease']]);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.step).toHaveBeenCalledTimes(1);
});
