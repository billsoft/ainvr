import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ptzService } from '@/api/ptzService';
import { usePtzControl } from '@/components/player/usePtzControl';
import { usePtzPatrol } from '@/components/player/usePtzPatrol';
import { panDelta, readRoute, span, storeRoute } from '@/components/player/horizontalPatrol';
import type { AiDetection } from '@/types/aiChannel';

import { largestPatrolTarget, patrolLabelGroups } from '@/components/player/ptzPatrol';
const person = {class_id: 0, label_id: 'class:0', name: 'person'};
const speed=.2;
const short = 'source:1', large = 'source:2', predicted = 'source:3';
function box(id: string, width: number, predicted = false): AiDetection {
  return { track_id: id, class_id: 0, class_name: 'person', confidence: 0.9, predicted,
    bbox: {x:0,y:0,w:width,h:20} };
}
function fixture() {
  vi.useFakeTimers();
  storeRoute('binding',{kind:'position',circle:false,left:0,right:.12,wrap:false,speed,seconds:4});
  let pan=0,tilt=.3;
  const position=vi.spyOn(ptzService,'patrolPosition').mockImplementation(async()=>({pan,tilt,zoom:0,wrap:false}));
  const acquired = vi.spyOn(ptzService, 'acquire').mockResolvedValue({sessionId:'scan',identity:'binding',leaseMs:750});
  const command = vi.spyOn(ptzService, 'command').mockImplementation(async(_c,_s,_seq,v)=>{pan+=v.pan*.06;tilt+=v.tilt*.06;return {};});
  const stop = vi.spyOn(ptzService, 'stop').mockResolvedValue({stopConfirmed:true});
  const opened = vi.spyOn(ptzService, 'followSession').mockResolvedValue({sessionId:'follow'});
  const choices = [short, large, predicted].map(id => ({id,label:'person',x:0.5,y:0.5,w:0.2,h:0.2}));
  const step = vi.spyOn(ptzService, 'followStep').mockResolvedValue({choices});
  const video = document.createElement('video');
  Object.defineProperties(video,{currentTime:{get:()=>performance.now()/1000},paused:{value:false},readyState:{value:4}});
  const tracks = {current: (): AiDetection[] => []};
  const ui = renderHook(() => {
    const control = usePtzControl('camera','binding', () => {});
    return usePtzPatrol({camera:'camera',identity:'binding',processor:'ai',enabled:true,video,
      positionAvailable:true,displayedTracks:tracks,control});
  });
  return {ui, simulateFollowing:()=>{pan+=.05;tilt+=.05;}, position, acquired, command, stop, opened, step, tracks, video};
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
afterEach(async () => {
  cleanup();localStorage.clear();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reverses at verified pan endpoints while holding tilt and zoom', async()=>{
  const f=fixture();
  await act(async()=>f.ui.result.current.start(speed,null));
  await advance(5500);
  const moves=f.command.mock.calls.map(c=>c[3]);
  expect(moves.some(v=>v.pan>0)).toBe(true);
  expect(moves.some(v=>v.pan<0)).toBe(true);
  expect(moves.every(v=>v.tilt===0 && v.zoom===0)).toBe(true);
  expect(f.opened).not.toHaveBeenCalled();
  await act(async()=>{await f.ui.result.current.stop()});
  const count=moves.length;
  await advance(2500);
  expect(f.command).toHaveBeenCalledTimes(count);
});

it('brakes before tracking the largest measured match and resumes scanning after loss', async () => {
  const f = fixture();
  await act(async () => f.ui.result.current.start(speed, person));
  f.tracks.current = () => [box(short, 30), box(large, 90), box(predicted, 120, true)];
  await advance(300);
  await advance(1000);
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.opened.mock.invocationCallOrder[0]!);
  expect(f.ui.result.current.selectedId).toBe(large);
  await advance(350);
  expect(f.step).toHaveBeenCalledWith('camera','follow',large);
  f.simulateFollowing();
  f.tracks.current = () => [];
  f.step.mockImplementation(async (_channel,_session,_id,brakeOnly) => brakeOnly
    ? {choices:[], moving:false, reselect:true, displayEpoch:1} : {choices:[]});
  await advance(1400);
  expect(f.stop.mock.calls).toContainEqual(['camera','follow']);
  expect(f.ui.result.current.status).toContain('返回原巡航路线');
  expect(f.command.mock.calls.some(c=>c[3].tilt<0 && c[3].pan<0 && c[3].zoom===0)).toBe(true);
  await advance(2200);
  expect(f.ui.result.current.status).toContain('扫描');
  expect(f.command.mock.calls.at(-1)?.[3].tilt).toBe(0);
});

it('requires fresh positions and confirmed range before enabling playback', async()=>{
  const f=fixture();
  await act(async()=>f.ui.result.current.teach(speed,false));
  expect(f.ui.result.current.canFinish).toBe(false);
  await advance(3200);
  expect(f.ui.result.current.canFinish).toBe(true);
  await act(async()=>f.ui.result.current.confirmEnd());
  await advance(1200);
  expect(f.ui.result.current.status).toBe('范围已保存');
  expect(f.stop).toHaveBeenCalledWith('camera','scan');
});
it('refuses to move from outside the saved range',async()=>{
  const f=fixture();
  f.position.mockResolvedValue({pan:-.4,tilt:.3,zoom:0,wrap:false});
  await act(async()=>f.ui.result.current.start(speed,null));
  expect(f.ui.result.current.status).toContain('范围外');
  expect(f.acquired).not.toHaveBeenCalled();
});
it('renews an active segment independently while waiting for the next observation',async()=>{
  const f=fixture();
  await act(async()=>f.ui.result.current.teach(speed,false));
  await advance(400);
  const count=f.command.mock.calls.length;
  let answer!: (p:Awaited<ReturnType<typeof ptzService.patrolPosition>>)=>void;
  f.position.mockImplementationOnce(()=>new Promise(resolve=>{answer=resolve;}));
  await advance(1000);
  expect(answer).toBeTypeOf('function');
  expect(f.acquired).toHaveBeenCalledTimes(1);
  expect(f.command.mock.calls.length).toBeGreaterThan(count+3);
  expect(f.stop).not.toHaveBeenCalled();
  await act(async()=>{await f.ui.result.current.stop();answer({pan:.1,tilt:.3,zoom:0,wrap:false});});
});
it('discards a late acquisition before issuing the first movement',async()=>{
  const f=fixture();
  let permit!: (value: Awaited<ReturnType<typeof ptzService.acquire>>) => void;
  f.acquired.mockReturnValueOnce(new Promise(resolve=>{permit=resolve;}));
  await act(async()=>f.ui.result.current.start(speed,null));
  await advance(2600);
  await act(async()=>permit({sessionId:'late',identity:'binding',leaseMs:750}));
  expect(f.command).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith('camera','late');
  expect(f.ui.result.current.active).toBe(false);
});
it('rechecks the native pose after acquire before sending a vector',async()=>{
  const f=fixture();
  f.acquired.mockImplementationOnce(async()=>{
    f.position.mockResolvedValue({pan:.4,tilt:.3,zoom:0,wrap:false});
    return {sessionId:'changed',identity:'binding',leaseMs:750};
  });
  await act(async()=>f.ui.result.current.start(speed,null));
  await advance(300);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith('camera','changed');
});
it('brakes on confirmation even with a position read and a command ACK outstanding',async()=>{
  const f=fixture();
  await act(async()=>f.ui.result.current.teach(speed,false));
  await advance(3000);
  expect(f.ui.result.current.canFinish).toBe(true);
  let reply!: (p: Awaited<ReturnType<typeof ptzService.patrolPosition>>)=>void;
  let ack!: (r:{})=>void;
  f.position.mockImplementationOnce(()=>new Promise(r=>{reply=r;}));
  f.command.mockImplementationOnce(()=>new Promise(r=>{ack=r;}));
  await advance(220);
  expect(reply).toBeTypeOf('function');expect(ack).toBeTypeOf('function');
  const count=f.command.mock.calls.length;
  await act(async()=>f.ui.result.current.confirmEnd());
  expect(f.stop).toHaveBeenCalledWith('camera','scan');
  await act(async()=>{reply({pan:.9,tilt:0,zoom:1,wrap:false});ack({});});
  await advance(1000);
  expect(f.command).toHaveBeenCalledTimes(count);
  expect(f.ui.result.current.status).toBe('范围已保存');
});
it('stops a pending scan when the video is paused and never dispatches its late lease', async () => {
  const f = fixture();
  let permit!: (value: Awaited<ReturnType<typeof ptzService.acquire>>) => void;
  f.acquired.mockReturnValueOnce(new Promise(resolve => { permit = resolve; }));
  await act(async () => f.ui.result.current.start(speed, {class_id: 2, label_id: 'class:2', name: 'car'}));
  await act(async () => f.video.dispatchEvent(new Event('pause')));
  await act(async () => permit({sessionId:'scan',identity:'binding',leaseMs:750}));
  expect(f.stop).toHaveBeenCalledWith('camera','scan');
  expect(f.command).not.toHaveBeenCalled();
  expect(f.opened).not.toHaveBeenCalled();
});

it('orders merged catalog labels and keeps distinct custom prompt identities', () => {
  const labels = ['umbrella','dog','smoke','fire','bicycle','motorcycle','car','person','face','person']
    .map((name,class_id) => ({name,class_id,label_id:'node:a:'+class_id}));
  const groups = patrolLabelGroups([...labels, labels[0]!]);
  expect(groups.map(g => g.items.map(l => l.name))).toEqual([
    ['face','person','person','car','motorcycle','bicycle','fire','smoke'], ['dog'], ['umbrella']]);
  const selected = labels[7]!;
  const other = {...box(short, 100), class_id:9, label_id:labels[9]!.label_id};
  const measured = {...box(large, 20), class_id:7};
  expect(largestPatrolTarget(selected, [other, measured])).toBe(large);
  expect(largestPatrolTarget(selected, [other])).toBeUndefined();
});

it('wraps only when the camera supplies a cyclic coordinate',()=>{
  expect(panDelta(.96,-.96,true)).toBeCloseTo(.08);
  expect(span(.96,-.96,false)).toBeCloseTo(-1.92);
  localStorage.setItem('ainvr:horizontal-route:v1:legacy',JSON.stringify({layers:3,turnSeconds:45}));
  expect(readRoute('legacy')).toBeNull();
});
