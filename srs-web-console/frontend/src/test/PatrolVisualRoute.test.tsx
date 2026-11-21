import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ptzService } from '@/api/ptzService';
import { usePtzControl } from '@/components/player/usePtzControl';
import { usePtzPatrol } from '@/components/player/usePtzPatrol';
import { readRoute, storeRoute, type Route } from '@/components/player/horizontalPatrol';
import { captureLandmark } from '@/components/player/patrolLandmark';
import type { AiDetection } from '@/types/aiChannel';

// Only the browser image boundary and HTTP transport are substituted. Actual
// patrol, route persistence, follow gate, motor lease/heartbeat/stop all run.
// Tokens describe distinct test scenes, not production landmark signatures.
vi.mock('@/components/player/patrolLandmark', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/player/patrolLandmark')>(),
  captureLandmark: vi.fn(),
  matchLandmark: (a: string, b: string) => ['left', 'middle', 'right'].includes(a) && a === b,
  nearLandmark: (a: string, b: string) => a==='ambiguous' || b==='ambiguous' ||
    (['left','middle','right'].includes(a.replace('-near','')) && a.replace('-near','')===b.replace('-near','')),
}));
const person = {class_id:0, label_id:'class:0', name:'person'};
const saved: Route = {kind:'visual', circle:false, left:'left', right:'right', via:'', speed:.2, seconds:3};

function fixture(route: Route | null = saved, circle = false, positionAvailable=false, visualTrial=true) {
  vi.useFakeTimers(); localStorage.clear();
  if (route) storeRoute('visual-binding', route);
  let pan = 0, velocity = 0, updated = performance.now(), lease = 0;
  let movingVideo = true;
  const update = () => {
    const at = performance.now();
    pan += velocity * (at - updated) / 600;
    if (!circle) pan = Math.max(0, Math.min(1, pan));
    updated = at;
  };
  const acquired = vi.spyOn(ptzService, 'acquire').mockImplementation(async () =>
    ({sessionId:`visual-${++lease}`, identity:'visual-binding', leaseMs:750}));
  const commands: {pan:number; time:number}[] = [];
  const command = vi.spyOn(ptzService, 'command').mockImplementation(async (_camera, _session, _seq, vector) => {
    update(); velocity = vector.pan; commands.push({pan:velocity, time:performance.now()}); return {};
  });
  const stops: number[] = [];
  const stop = vi.spyOn(ptzService, 'stop').mockImplementation(async () => {
    update(); velocity = 0; stops.push(performance.now()); return {stopConfirmed:true};
  });
  const position = vi.spyOn(ptzService, 'patrolPosition').mockRejectedValue(new Error('test: no native position'));
  const follow = vi.spyOn(ptzService, 'followSession').mockResolvedValue({sessionId:'forbidden-follow'});
  const step = vi.spyOn(ptzService, 'followStep').mockResolvedValue({choices:[]});
  const video = document.createElement('video');
  Object.defineProperties(video, {
    paused:{value:false}, readyState:{value:4},
    currentTime:{get:() => movingVideo ? performance.now() / 1000 : 0},
  });
  const tracks = {current:():AiDetection[] => [{track_id:'visible-person', class_id:0,
    class_name:'person', label_id:'class:0', confidence:.99, bbox:{x:0,y:0,w:100,h:100}}]};
  const capture = vi.mocked(captureLandmark);
  capture.mockReset();
  capture.mockImplementation(async () => {
    update(); const x = circle ? ((pan % 1) + 1) % 1 : pan;
    return x < .08 || (circle && x > .92) ? 'left' : x > .92 ? 'right' : 'middle';
  });
  const ui = renderHook(() => {
    const control = usePtzControl('visual-camera', 'visual-binding', () => {});
    return usePtzPatrol({camera:'visual-camera', identity:'visual-binding', processor:'ai',
      enabled:true, visualTrial, positionAvailable, video, displayedTracks:tracks, control});
  });
  return {ui, video, capture, acquired, command, commands, stop, stops, position, follow, step,
    freezeVideo:() => { movingVideo = false; }, moving:() => velocity};
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
afterEach(async () => {
  cleanup(); await act(async () => { await Promise.resolve(); });
  vi.clearAllTimers(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers();
});
it('uses visual teaching only for a definitive unsupported native position',async()=>{
  const f=fixture(null,false,true);
  for(const error of [Object.assign(Error('ptz_position_stale'),{status:503}),
    Object.assign(Error('ptz_source_changed'),{status:409})]){
    f.position.mockRejectedValueOnce(error);
    await act(async()=>f.ui.result.current.teach(.2,false));
    expect(f.capture).not.toHaveBeenCalled();expect(f.acquired).not.toHaveBeenCalled();
  }
  f.position.mockRejectedValueOnce(Object.assign(Error('ptz_position_unavailable'),{status:422}));
  await act(async()=>f.ui.result.current.teach(.2,false));
  await advance(300);
  expect(f.command).toHaveBeenCalled();
});
it('rejects an ambiguous starting frame before acquiring a lease',async()=>{
  const f=fixture();f.capture.mockResolvedValue('ambiguous');
  await act(async()=>f.ui.result.current.start(.2,null));
  expect(f.ui.result.current.status).toContain('歧义');
  expect(f.acquired).not.toHaveBeenCalled();
});
it('brakes on the first near endpoint and requires two stopped observations before reversal',async()=>{
  const f=fixture();let hits=0, stoppedReads=0;
  Object.defineProperty(f.video,'buffered',{value:{length:1,start:()=>0,end:()=>1.5}});
  f.capture.mockImplementation(async()=>{
    if(f.stops.length) return ++stoppedReads===1 ? 'right-near' : 'middle';
    if(f.commands.length) {hits++;return 'right-near';}
    return 'left-near';
  });
  await act(async()=>f.ui.result.current.start(.2,null));
  await advance(1000);
  expect(f.stops).toHaveLength(1);expect(stoppedReads).toBe(0);
  await advance(1500);
  expect(hits).toBe(1);expect(stoppedReads).toBe(5); // Discard the moving frame, establish stability, then independently recheck.
  expect(f.stops).toHaveLength(1);expect(f.commands.every(v=>v.pan>0)).toBe(true);
  expect(f.ui.result.current.status).toContain('停转后端点未确认');
  expect(readRoute('visual-binding')).toEqual(saved);
});
it('rejects nearby teaching endpoints instead of extending the taught range',async()=>{
  const f=fixture(null);
  f.capture.mockImplementation(async()=>f.stops.length ? 'left-near' : f.commands.length ? 'middle' : 'left');
  await act(async()=>f.ui.result.current.teach(.2,false));await advance(3200);
  await act(async()=>f.ui.result.current.confirmEnd());await advance(1000);
  expect(readRoute('visual-binding')).toBeNull();
  expect(f.stops).toHaveLength(1);
});
it('brakes at an early circle return without extending travel to search for the via landmark',async()=>{
  const f=fixture({...saved,circle:true,right:'left',via:'middle'},true);
  let movingReads=0;
  f.capture.mockImplementation(async()=>!f.commands.length ? 'left' : ++movingReads===1 ? 'right' : 'left-near');
  await act(async()=>f.ui.result.current.start(.2,null));await advance(2500);
  expect(movingReads).toBe(2);expect(f.stops).toHaveLength(1);
  expect(f.ui.result.current.status).toContain('中途参照');
  expect(f.commands.every(v=>v.pan>0)).toBe(true);
});

it('teaches visual endpoints and persists only after a stopped return verification', async () => {
  const f = fixture(null);
  await act(async () => f.ui.result.current.teach(.2, false));
  expect(f.ui.result.current.canFinish).toBe(false);
  await advance(3200); expect(f.ui.result.current.canFinish).toBe(true);
  expect(readRoute('visual-binding')).toBeNull();
  await act(async () => f.ui.result.current.confirmEnd());
  await advance(1000);
  expect(f.ui.result.current.status).toBe('向左复核起点…');
  expect(readRoute('visual-binding')).toBeNull();
  await advance(4000);
  expect(f.ui.result.current.status).toBe('范围已保存');
  expect(f.ui.result.current.active).toBe(false);
  expect(readRoute('visual-binding')).toMatchObject({kind:'visual', circle:false, left:'left', right:'right', speed:.2});
  expect(f.stops).toHaveLength(2); expect(f.moving()).toBe(0);
  expect(f.position).not.toHaveBeenCalled(); expect(f.follow).not.toHaveBeenCalled();
});

it('makes confirmed right-left-right legs at the learned speed, braking before each reversal', async () => {
  const f = fixture();
  await act(async () => f.ui.result.current.start(.35, null));
  await advance(8500);
  const changes = f.commands.filter((v, i, all) => !i || v.pan !== all[i - 1]!.pan);
  expect(changes.slice(0, 3).map(v => v.pan)).toEqual([.2, -.2, .2]);
  expect(f.stops[0]).toBeLessThan(changes[1]!.time);
  expect(f.stops[1]).toBeLessThan(changes[2]!.time);
  expect(f.command.mock.calls.every(call => call[3].tilt === 0 && call[3].zoom === 0)).toBe(true);
  expect(f.position).not.toHaveBeenCalled();
  await act(async () => { await f.ui.result.current.stop(); });
  const count = f.command.mock.calls.length;
  await advance(4000); expect(f.command).toHaveBeenCalledTimes(count);
  expect(f.moving()).toBe(0);
});

it('keeps unverified visual routes out of production even if saved in this browser', async()=>{
  const f=fixture(saved,false,false,false);
  expect(f.ui.result.current.route).toBeNull();
  await act(async()=>f.ui.result.current.start(.2,null));
  await act(async()=>f.ui.result.current.teach(.2,false));
  expect(f.ui.result.current.status).toContain('无法回读');
  expect(f.acquired).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});

it('forbids AI tracking on visual routes even with a matching displayed target', async () => {
  const f = fixture();
  await act(async () => f.ui.result.current.start(.2, person));
  await advance(1000);
  expect(f.ui.result.current.active).toBe(false); expect(f.acquired).not.toHaveBeenCalled();
  await act(async () => f.ui.result.current.start(.2, null));
  await advance(5000);
  expect(f.command).toHaveBeenCalled();
  expect(f.follow).not.toHaveBeenCalled(); expect(f.step).not.toHaveBeenCalled();
  expect(f.ui.result.current.selectedId).toBeNull();
});

it('stops on missing visual feedback and ignores the eventual late observation', async () => {
  const f = fixture();
  let resolve!: (view: string) => void;
  f.capture.mockResolvedValueOnce('left').mockImplementationOnce(() => new Promise<string>(r => {resolve = r;}));
  await act(async () => f.ui.result.current.start(.2, null));
  await advance(3000);
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('反馈中断');
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.moving()).toBe(0);
  const count = f.command.mock.calls.length;
  await act(async () => resolve('right'));
  await advance(5000); expect(f.command).toHaveBeenCalledTimes(count);
});

it('stops if video time stops advancing although landmark observations still resolve', async () => {
  const f = fixture(); f.freezeVideo();
  await act(async () => f.ui.result.current.start(.2, null));
  await advance(3000);
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('反馈中断');
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.moving()).toBe(0);
});

it('brakes after repeated stationary observations in the middle of a long leg', async () => {
  const f=fixture({...saved, seconds:25});
  f.capture.mockImplementation(async()=>f.commands.length ? 'middle' : 'left');
  await act(async()=>{f.ui.result.current.start(.2,null)});
  await advance(11000);
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('未确认画面继续移动');
  expect(f.stop).toHaveBeenCalled();
});

it('brakes at the learned duration when delayed video has not yet shown the endpoint',async()=>{
  const f=fixture();
  let seen=0;
  f.capture.mockImplementation(async()=>{
    if(f.stops.length) {seen++;return 'right';}
    return f.commands.length ? 'middle' : 'left';
  });
  await act(async()=>f.ui.result.current.start(.2,null));
  await advance(3750);
  expect(f.stops[0]).toBeGreaterThanOrEqual(3000);
  expect(f.stops[0]).toBeLessThan(3300);
  expect(seen).toBeGreaterThanOrEqual(4);
  expect(f.commands.filter(v=>v.time<=f.stops[0]!).every(v=>v.pan>0)).toBe(true);
  expect(f.commands.find(v=>v.pan<0)?.time).toBeGreaterThan(f.stops[0]! + 600);
});

it('never saves a stationary trial as a learned endpoint', async () => {
  const f = fixture(null); f.capture.mockResolvedValue('left');
  await act(async () => f.ui.result.current.teach(.2, false));
  await advance(3200); expect(f.ui.result.current.canFinish).toBe(false);
  await act(async () => f.ui.result.current.confirmEnd());
  await advance(6500);
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('未确认镜头移动');
  expect(readRoute('visual-binding')).toBeNull(); expect(f.stop).toHaveBeenCalledTimes(1);
});

it('does not reverse after a stopped endpoint fails its final visual check', async () => {
  const f = fixture();
  const capture = f.capture.getMockImplementation()!;
  f.capture.mockImplementation(async video => f.stops.length ? 'middle' : capture(video));
  await act(async () => f.ui.result.current.start(.2, null));
  await advance(5000);
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('停转后端点未确认');
  expect(f.commands.every(v => v.pan > 0)).toBe(true); expect(f.stop).toHaveBeenCalledTimes(1);
});

it('rejects an unusable initial reference before acquiring a motor lease', async () => {
  const f = fixture(null); f.capture.mockRejectedValue(new Error('patrol_landmark:weak_texture'));
  await act(async () => f.ui.result.current.teach(.2, false));
  expect(f.ui.result.current.active).toBe(false);
  expect(f.ui.result.current.status).toContain('可辨细节不足');
  expect(f.acquired).not.toHaveBeenCalled(); expect(readRoute('visual-binding')).toBeNull();
});

it('verifies an intermediate reference before accepting a visual full-circle return', async () => {
  const f = fixture(null, true);
  await act(async () => f.ui.result.current.teach(.2, true));
  await advance(3100); expect(f.ui.result.current.canFinish).toBe(true);
  await act(async () => f.ui.result.current.confirmEnd());
  await advance(5000);
  expect(f.ui.result.current.status).toBe('范围已保存');
  expect(readRoute('visual-binding')).toMatchObject({kind:'visual', circle:true, left:'left', right:'left', via:'middle'});
  expect(f.stops).toHaveLength(2); expect(f.follow).not.toHaveBeenCalled();
});
