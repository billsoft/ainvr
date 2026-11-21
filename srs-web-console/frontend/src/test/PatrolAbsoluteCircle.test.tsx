import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ptzService } from '@/api/ptzService';
import { usePtzControl } from '@/components/player/usePtzControl';
import { usePtzPatrol } from '@/components/player/usePtzPatrol';
import { preferredPatrolSpeed, rememberPatrolSpeed, readRoute, storeRoute, validPatrolSpeed } from '@/components/player/horizontalPatrol';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });

function camera(continuous: boolean) {
  vi.useFakeTimers();
  const video = document.createElement('video');
  Object.defineProperties(video, {paused: {value:false}, readyState:{value:4},
    currentTime:{get:()=>performance.now()/1000}});
  let travel=0, at=performance.now(), speed=0;
  function update() {
    const t=performance.now();
    travel+=speed*(t-at)/1800;
    at=t;
    return continuous ? ((travel+1)%2+2)%2-1 : Math.min(travel, .25);
  }
  vi.spyOn(ptzService,'patrolPosition').mockImplementation(async()=>({pan:update(),tilt:.7,zoom:.2,wrap:false}));
  vi.spyOn(ptzService,'acquire').mockResolvedValue({sessionId:'circle',identity:'sphere',leaseMs:750});
  const moves=vi.spyOn(ptzService,'command').mockImplementation(async(_camera,_lease,_seq,v)=>{
    update();speed=v.pan;return {};
  });
  vi.spyOn(ptzService,'stop').mockImplementation(async()=>{update();speed=0;return {stopConfirmed:true};});
  const hook=renderHook(()=>{
    const control=usePtzControl('cam','sphere',()=>{});
    return usePtzPatrol({camera:'cam',identity:'sphere',video,enabled:true,positionAvailable:true,control});
  });
  return {hook,moves};
}

it('learns an actual encoder seam and stops after one measured horizontal revolution',async()=>{
  const {hook,moves}=camera(true);
  await act(async()=>hook.result.current.teach(.2,true));
  await act(async()=>{await vi.advanceTimersByTimeAsync(22000)});
  expect(readRoute('sphere')).toMatchObject({kind:'position',wrap:true,circle:true});
  expect(hook.result.current.active).toBe(false);
  expect(moves.mock.calls.every(call=>call[3].tilt===0 && call[3].zoom===0)).toBe(true);
});
it('accepts the full speed range, preserves old routes, and ignores invalid preferences',()=>{
  storeRoute('sphere',{kind:'position',circle:true,left:0,right:0,wrap:true,speed:.35,seconds:18});
  expect(preferredPatrolSpeed('sphere')).toBe(.35);
  rememberPatrolSpeed('sphere',1);
  expect(preferredPatrolSpeed('sphere')).toBe(1);
  expect(readRoute('sphere')?.seconds).toBe(18);
  for (const value of [NaN,Infinity,1.01,0,-1]) expect(validPatrolSpeed(value)).toBe(false);
});

it('teaches slowly and commands full cruise speed in both directions with endpoint braking',async()=>{
  const {hook,moves}=camera(true);
  await act(async()=>hook.result.current.teach(1,true));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});
  expect(readRoute('sphere')).toMatchObject({speed:.35,circle:true});
  expect(moves.mock.calls.every(call=>Math.abs(call[3].pan)<=.35)).toBe(true);
  moves.mockClear();
  await act(async()=>hook.result.current.start(1,null));
  await act(async()=>{await vi.advanceTimersByTimeAsync(16000)});
  const vectors=moves.mock.calls.map(call=>call[3]);
  for (const direction of [1,-1]) {
    const leg=vectors.filter(vector=>Math.sign(vector.pan)===direction);
    expect(leg.some(vector=>Math.abs(vector.pan)===1)).toBe(true);
    expect(leg.some(vector=>Math.abs(vector.pan)<=.25)).toBe(true);
  }
  expect(vectors.every(v=>v.zoom===0 && v.tilt===0)).toBe(true);
  await act(async()=>{await hook.result.current.stop();});
  expect(hook.result.current.active).toBe(false);
});

it('stops at a stationary physical limit without recording a full revolution',async()=>{
  const {hook}=camera(false);
  await act(async()=>hook.result.current.teach(.2,true));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000)});
  expect(hook.result.current.active).toBe(false);
  expect(readRoute('sphere')).toBeNull();
  expect(hook.result.current.status).toContain('未继续转动');
});
