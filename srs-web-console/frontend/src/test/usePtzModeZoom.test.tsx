import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ptzService } from '@/api/ptzService';
import { usePtzModeZoom } from '@/components/player/usePtzModeZoom';
import { usePtzFollow } from '@/components/player/usePtzFollow';
import type { AiDetection } from '@/types/aiChannel';

type Options = Parameters<typeof usePtzModeZoom>[0];
const original = 'ai:old-stream:2:7';
const other = 'ai:new-stream:2:7';
const lease = {sessionId:'zoom-lease', identity:'binding', leaseMs:750};

function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function setup(mode: Options['mode'] = 'follow') {
  const acquire = vi.spyOn(ptzService,'acquire').mockResolvedValue(lease);
  const command = vi.spyOn(ptzService,'command').mockResolvedValue({});
  const stop = vi.spyOn(ptzService,'stop').mockResolvedValue({stopConfirmed:true});
  const follow = {selectedId:original, pick:vi.fn(), stop:vi.fn(async () => true)};
  const control = {state:'idle' as const, zoomStep:vi.fn(async (_speed:number) => {}), stopConfirmed:vi.fn(async () => true)};
  const options: Options = {mode,channelId:'cam',identity:'binding',speed:.35,follow,control,disabled:false};
  return {acquire, command, stop, follow, control, options, mount:() => renderHook(usePtzModeZoom,{initialProps:options})};
}
async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('sends one zoom-only command per accepted tap and offers only the original full ID after confirmed stop', async () => {
  const f = setup();
  const ui = f.mount();
  const released = deferred<boolean>();
  const braked = deferred<{stopConfirmed:boolean}>();
  f.follow.stop.mockReturnValueOnce(released.promise);
  f.stop.mockReturnValueOnce(braked.promise);
  expect(f.acquire).not.toHaveBeenCalled();
  act(() => { void ui.result.current.step(-1); void ui.result.current.step(1); });
  expect(ui.result.current.busy).toBe(true);
  expect(f.follow.stop).toHaveBeenCalledTimes(1);
  expect(f.acquire).not.toHaveBeenCalled();
  await act(async () => released.resolve(true));
  expect(f.acquire).toHaveBeenCalledWith('cam','binding');
  expect(f.command.mock.calls).toEqual([['cam','zoom-lease',1,{pan:0,tilt:0,zoom:-.35},false]]);
  await advance(180);
  expect(f.stop.mock.calls).toEqual([['cam','zoom-lease']]);
  expect(f.follow.pick).not.toHaveBeenCalled();
  await act(async () => braked.resolve({stopConfirmed:true}));
  expect(f.follow.pick.mock.calls).toEqual([[original]]);
  expect(ui.result.current.busy).toBe(false);
});

it.each([
  {mode:'aim', direction:1}, {mode:'follow', direction:1}, {mode:'follow', direction:-1},
] as const)('gives a GB $mode button ($direction) one 900ms optical pulse at gear 8', async ({mode,direction}) => {
  const f = setup(mode);
  f.acquire.mockResolvedValue({...lease,leaseMs:1200});
  const options: Options = {...f.options,protocol:'gb28181'};
  const ui = renderHook(usePtzModeZoom,{initialProps:options});
  await act(async () => { void ui.result.current.step(direction); });
  expect(f.control.zoomStep).not.toHaveBeenCalled();
  expect(mode === 'aim' ? f.control.stopConfirmed : f.follow.stop).toHaveBeenCalledOnce();
  expect(f.command.mock.calls).toEqual([['cam','zoom-lease',1,{pan:0,tilt:0,zoom:direction*8/15},false]]);
  await advance(899);
  expect(f.stop).not.toHaveBeenCalled();
  await advance(1);
  expect(f.stop.mock.calls).toEqual([['cam','zoom-lease']]);
  expect(f.command).toHaveBeenCalledOnce();
  expect(f.follow.pick.mock.calls).toEqual(mode === 'follow' ? [[original]] : []);
  expect(ui.result.current.busy).toBe(false);
});

it('renews a short GB lease with zero-vector heartbeats until the original deadline', async () => {
  const f = setup('follow');
  f.acquire.mockResolvedValue({...lease,leaseMs:500});
  const ui = renderHook(usePtzModeZoom,{initialProps:{...f.options,protocol:'gb28181',speed:1} as Options});
  await act(async () => { void ui.result.current.step(-1); });
  await advance(899);
  const zero = {pan:0,tilt:0,zoom:0};
  expect(f.command.mock.calls).toEqual([
    ['cam','zoom-lease',1,{...zero,zoom:-1},false],
    ['cam','zoom-lease',2,zero,true],
    ['cam','zoom-lease',3,zero,true],
  ]);
  expect(f.stop).not.toHaveBeenCalled();
  await advance(1);
  expect(f.stop).toHaveBeenCalledOnce();
  await advance(1000);
  expect(f.command).toHaveBeenCalledTimes(3);
});

it('stops immediately during a pending GB renewal and fences late replies', async () => {
  const f = setup('aim');
  f.acquire.mockResolvedValue({...lease,leaseMs:500});
  const renewal = deferred<{}>();
  f.command.mockResolvedValueOnce({}).mockReturnValueOnce(renewal.promise);
  const ui = renderHook(usePtzModeZoom,{initialProps:{...f.options,protocol:'gb28181'} as Options});
  await act(async () => { void ui.result.current.step(1); });
  await advance(250);
  expect(f.command).toHaveBeenCalledTimes(2);
  await act(async () => expect(await ui.result.current.cancel()).toBe(true));
  expect(f.stop).toHaveBeenCalledOnce();
  await act(async () => renewal.resolve({}));
  await advance(1500);
  expect(f.command).toHaveBeenCalledTimes(2);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.follow.pick).not.toHaveBeenCalled();
});

it.each(['permission','prepare timeout'])('a GB button cannot send a late movement after %s', async cause => {
  const f = setup('aim');
  const pending = deferred<typeof lease>();
  f.acquire.mockReturnValueOnce(pending.promise);
  const options: Options = {...f.options,protocol:'gb28181',permitted:true};
  const ui = renderHook(usePtzModeZoom,{initialProps:options});
  await act(async () => { void ui.result.current.step(1); });
  if (cause === 'permission') ui.rerender({...options,permitted:false});
  else await advance(3000);
  await act(async () => pending.resolve(lease));
  expect(f.stop.mock.calls).toEqual([['cam','zoom-lease']]);
  expect(f.command).not.toHaveBeenCalled();
});

it('delegates aim buttons and fences the delegated gesture even after zoomStep returns', async () => {
  const f = setup('aim');
  const ui = f.mount();
  await act(async () => ui.result.current.step(1));
  expect(f.control.zoomStep).toHaveBeenCalledWith(.35);
  expect(f.follow.stop).not.toHaveBeenCalled();
  expect(f.acquire).not.toHaveBeenCalled();
  await act(async () => expect(await ui.result.current.cancel()).toBe(true));
  expect(f.control.stopConfirmed).toHaveBeenCalledTimes(1);
});

it('cancels synchronously while waiting for the follow lease to stop', async () => {
  const f = setup();
  const ui = f.mount();
  const released = deferred<boolean>();
  f.follow.stop.mockReturnValueOnce(released.promise);
  let cancelled!: Promise<boolean>;
  act(() => { void ui.result.current.step(1); cancelled = ui.result.current.cancel(); });
  await act(async () => { released.resolve(true); expect(await cancelled).toBe(true); });
  expect(f.acquire).not.toHaveBeenCalled();
  expect(f.follow.pick).not.toHaveBeenCalled();
});

it.each(['channel','identity','mode','unmount','timeout','pagehide'] as const)(
  'stops a late acquire on its original channel without sending zoom after %s', async reason => {
    const f = setup();
    const ui = f.mount();
    const pending = deferred<typeof lease>();
    f.acquire.mockReturnValueOnce(pending.promise);
    await act(async () => { void ui.result.current.step(1); });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    const oldStep = ui.result.current.step;
    if (reason === 'unmount') ui.unmount();
    else if (reason === 'timeout') await advance(3100);
    else if (reason === 'pagehide') act(() => { window.dispatchEvent(new Event('pagehide')); });
    else ui.rerender({...f.options,...{
      channel:{channelId:'next-cam'}, identity:{identity:'new-binding'}, mode:{mode:'manual' as const},
    }[reason]});
    await act(async () => pending.resolve(lease));
    if (['channel','identity','mode','unmount'].includes(reason)) await act(async () => oldStep(1));
    expect(f.stop.mock.calls).toEqual([['cam','zoom-lease']]);
    expect(f.command).not.toHaveBeenCalled();
    expect(f.follow.pick).not.toHaveBeenCalled();
  });

it('treats a busy poll as an admission check and preserves the pulse deadline and notice', async () => {
  const f = setup();
  const options = {...f.options, follow:{...f.follow,selectedId:null}};
  const ui = renderHook(usePtzModeZoom,{initialProps:options});
  const start = ui.result.current.step;
  await act(async () => { void start(1); });
  await advance(90);
  ui.rerender({...options,disabled:true});
  await advance(89);
  expect(f.stop).not.toHaveBeenCalled();
  await advance(1);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(ui.result.current.busy).toBe(false);
  const message = ui.result.current.notice;
  expect(message).toContain('点选目标');
  await act(async () => start(-1));
  expect(f.command).toHaveBeenCalledOnce();
  ui.rerender(options);
  expect(ui.result.current.notice).toBe(message);
});

it('stops a mismatched lease without issuing a zoom command', async () => {
  const f = setup();
  f.acquire.mockResolvedValue({...lease,identity:'different'});
  const ui = f.mount();
  await act(async () => ui.result.current.step(1));
  expect(f.stop.mock.calls).toEqual([['cam','zoom-lease']]);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.follow.pick).not.toHaveBeenCalled();
  expect(ui.result.current.notice).toContain('摄像头关联已改变');
});

it('brakes on deadline despite a pending command and never restores after emergency cancel', async () => {
  const f = setup();
  const ui = f.mount();
  const pending = deferred<{}>();
  const stopped = deferred<{stopConfirmed:boolean}>();
  f.command.mockReturnValueOnce(pending.promise);
  f.stop.mockReturnValueOnce(stopped.promise);
  await act(async () => { void ui.result.current.step(1); });
  await advance(180);
  expect(f.stop).toHaveBeenCalledOnce();
  let cancelled!: Promise<boolean>;
  act(() => { cancelled = ui.result.current.cancel(); });
  await act(async () => { stopped.resolve({stopConfirmed:true}); expect(await cancelled).toBe(true); });
  await act(async () => pending.resolve({}));
  expect(f.follow.pick).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(ui.result.current.busy).toBe(false);
});

it.each(['follow','zoom'])('requires confirmation of the %s stop and retries only its owner', async owner => {
  const f = setup();
  const ui = f.mount();
  if (owner === 'follow') f.follow.stop.mockResolvedValueOnce(false);
  else f.stop.mockResolvedValueOnce({stopConfirmed:false});
  await act(async () => { void ui.result.current.step(1); });
  await advance(180);
  expect(ui.result.current.notice).toContain('停止尚未确认');
  await act(async () => ui.result.current.step(-1));
  expect(f.command).toHaveBeenCalledTimes(owner === 'follow' ? 0 : 1);
  expect(f.follow.pick).not.toHaveBeenCalled();
  await act(async () => expect(await ui.result.current.cancel()).toBe(true));
  if (owner === 'zoom') expect(f.stop.mock.calls).toEqual([['cam','zoom-lease'],['cam','zoom-lease']]);
  else expect(f.follow.stop).toHaveBeenCalledTimes(2);
});

it.each([original,other])('restores through the real follow hook only when the full ID is still valid (%s)', async afterZoom => {
  const f = setup();
  const session = vi.spyOn(ptzService,'followSession').mockResolvedValue({sessionId:'follow'});
  const choice = {id:original,label:'chair',x:.5,y:.5,w:.2,h:.2};
  const tick = vi.spyOn(ptzService,'followStep').mockResolvedValue({choices:[choice]});
  let visible = original;
  const displayedTracks = {current:() => [{track_id:visible} as AiDetection]};
  const ui = renderHook(() => {
    const follow = usePtzFollow({enabled:true,camera:'cam',processor:'ai',identity:'binding',displayedTracks});
    return {follow,zoom:usePtzModeZoom({...f.options,follow})};
  });
  await advance();
  act(() => ui.result.current.follow.pick(original));
  await advance(2);
  expect(tick.mock.calls.some(([cam,id,track]) => cam === 'cam' && id === 'follow' && track === original)).toBe(true);
  tick.mockClear();
  await act(async () => { void ui.result.current.zoom.step(1); });
  visible = afterZoom;
  tick.mockResolvedValue({choices:[{...choice,id:afterZoom}]});
  await advance(400);
  const resumed = afterZoom === original;
  expect(ui.result.current.follow.selectedId).toBe(resumed ? original : null);
  expect(session).toHaveBeenCalledTimes(resumed ? 2 : 1);
  expect(tick.mock.calls.some(([, ,track]) => track === original)).toBe(resumed);
  expect(tick.mock.calls.some(([, ,track]) => track === other)).toBe(false);
  if (!resumed) expect(ui.result.current.zoom.notice).toContain('点选目标');
});
