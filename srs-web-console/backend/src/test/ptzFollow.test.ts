import { describe, expect, it, vi } from 'vitest';
import { FrameFollower } from '../services/ptzFollow.js';
import { PtzManager } from '../services/ptzManager.js';
import type { PtzAdapter } from '../services/ptzAdapter.js';
import type { PtzStore } from '../store/ptzStore.js';
import type { Channel } from '../types/channel.js';
const created=10000;
function frame(t:number,x=600,y=400,w=100,h=120,id='ai:s:7'){
  return {channel_id:'ai',frame_width:1000,frame_height:1000,frame_index:t,
    frame_pts_ns:t*1e6,timestamp:t/1000,detections:[{track_id:id,class_name:'chair',bbox:{x,y,w,h}}]};
}
describe('image-plane follow controller',()=>{
  it('starts a bounded lead only after device IDLE and washout on both clocks', () => {
    function approaching(idle:boolean, sourceScale:number, moveDuringWashout=false) {
      const follower=new FrameFollower('ai',created);
      let pan=0;
      for (let i=0;i<=6;i++) {
        const t=created+i*200;
        const e=[0,0,0,0,.002,.024,.05][i]!;
        const raw=frame(t,450+1000*e,450,100,100);
        raw.frame_pts_ns=(created+i*200*sourceScale)*1e6;
        if (idle && i%2===0 && !(moveDuringWashout && i>=3)) follower.observeIdle(true,t,t);
        if (i===3 && moveDuringWashout) {
          follower.dispatched(.2,0,t-1);
          follower.dispatched(0,0,t);
        }
        pan=follower.sample(raw,'ai:s:7',t).vector!.pan;
      }
      return pan;
    }
    expect(approaching(true,1)).toBeGreaterThan(0);
    expect(approaching(false,1)).toBe(0);
    expect(approaching(true,.4)).toBe(0);
    expect(approaching(true,1,true)).toBe(0);
  });
  it('requires continuous recent device IDLE even after a long stationary selection', () => {
    for (const evidence of ['continuous','expired','late','moving','unknown','pending']) {
      const f=new FrameFollower('ai',created);
      let pan=0;
      for (let i=0;i<=152;i++) {
        const t=created+200*i;
        if (i===0 || (evidence!=='expired' && i%2===0)) {
          const valid=i<152 || (evidence!=='moving' && evidence!=='unknown');
          f.observeIdle(valid,t-(i===152 && evidence==='late' ? 300 : 0),t);
        }
        f.idleProbePending=i===152 && evidence==='pending';
        const error=i<150 ? 0 : [.015,.033,.051][i-150]!;
        pan=f.sample(frame(t,450+1000*error,450,100,100),'ai:s:7',t).vector!.pan;
      }
      if (evidence==='continuous') expect(pan).toBeCloseTo(.15186);
      else expect(pan,evidence).toBe(0);
    }
  });
  it('raises only the threatened axis on consecutive outward observations, and drops the boost on closure', () => {
    const follower=new FrameFollower('ai',created);
    const values:number[]=[];
    for (const [i,offset] of [.12,.18,.24,.30,.36,.42,.39].entries()) {
      const t=created+200*i;
      const v=follower.sample(frame(t,470,470-1000*offset,60,60),'ai:s:7',t).vector!;
      expect(v.pan).toBe(0);
      expect(v.zoom).toBe(0);
      values.push(v.tilt);
      follower.dispatched(0,v.tilt,t);
      follower.parked=false;
    }
    expect(values[5]).toBeGreaterThan(.35);
    expect(values[5]!-values[4]!).toBeLessThanOrEqual(.131);
    expect(values[6]).toBeCloseTo(.226);
  });
  it('lists observations without moving and sticks to the full selected identity',()=>{
    const f=new FrameFollower('ai',created), a=frame(10100);
    expect(f.sample(a,undefined,10100).vector).toBeNull();
    expect(f.sample(a,'ai:s:7',10100).vector?.pan).toBeGreaterThan(0);
    expect(f.sample(frame(10300,600,400,100,120,'ai:s:8'),'ai:s:7',10300).vector).toBeNull();
    expect(f.sample(frame(10500),'ai:s:7',10500).vector?.pan).toBeGreaterThan(0);
    expect(()=>f.sample(frame(10600,600,400,100,120,'ai:new:7'),'ai:s:7',10600)).toThrow('ptz_follow_target_lost');
  });
  it('requires confirmation, then permits a long PTS gap only for a new measured frame of the held identity', () => {
    const f = new FrameFollower('ai',created);
    f.sample(frame(10100),'ai:s:7',10100);
    f.hold('ai:s:7');
    expect(f.holdUntil).toBe(0);
    expect(() => f.sample(frame(10300),'ai:s:7',10300)).toThrow();
    f.holdUntil=14300;
    expect(f.sample(frame(10100),'ai:s:7',12600)).toMatchObject({missing:true,vector:null});
    expect(f.sample({...frame(12800),detections:[]},'ai:s:7',12800).vector).toBeNull();
    expect(() => f.sample(frame(12799),'ai:s:7',12801)).toThrow('ptz_follow_frame_stale');
    expect(() => f.sample({...frame(12801),detections:[],model_extra:{analytics:{stream_session_id:'ai:new'}}},
      'ai:s:7',12801)).toThrow('ptz_follow_target_lost');
    expect(() => f.sample({...frame(12801),channel_id:'other'},'ai:s:7',12801)).toThrow('ptz_source_changed');
    expect(f.sample(frame(13900),'ai:s:7',13900).vector?.pan).toBeGreaterThan(0);
    expect(f.observationDeadline).toBe(14550);
    expect(() => f.sample(frame(14300),'ai:s:7',14300)).toThrow('ptz_follow_target_lost');
  });
  it('caps speed, identifies repeated frames without renewal and refuses stale input',()=>{
    const f=new FrameFollower('ai',created);
    f.sample(frame(10100),'ai:s:7',10100);
    expect(f.sample(frame(10100),'ai:s:7',10200)).toMatchObject({vector:null,repeat:true});
    expect(f.observationDeadline).toBe(10750);
    const v=f.sample(frame(10300,850,20),'ai:s:7',10400).vector!;
    expect(v.pan).toBeCloseTo(.25);expect(v.tilt).toBeCloseTo(.262);expect(v.zoom).toBe(0);
    expect(f.sample(frame(10300),'ai:s:7',11000)).toMatchObject({missing:true,vector:null});
  });
  it('brakes for each retarget and calculates the new motion using only the new identity', () => {
    const follower = new FrameFollower('ai',created);
    expect(follower.sample(frame(10100), 'ai:s:7', 10100).vector?.pan).toBeGreaterThan(0);
    const b = frame(10300,100,300,100,100,'ai:s:8');
    expect(follower.sample(b, 'ai:s:8', 10300).vector).toBeNull();
    const c = frame(10400,750,300,100,100,'ai:s:9');
    expect(follower.sample(c, 'ai:s:9', 10400).vector).toBeNull();
    const next = frame(10500,750,300,100,100,'ai:s:9');
    expect(follower.sample(next, 'ai:s:9', 10500).vector)
      .toEqual(new FrameFollower('ai',created).sample(next, 'ai:s:9', 10500).vector);
  });
  it('rejects retargeting to a lost, duplicate, or predicted identity', () => {
    const follower = new FrameFollower('ai',created);
    follower.sample(frame(10100), 'ai:s:7', 10100);
    const b = frame(10300,100,300,100,100,'ai:s:8');
    for (const detections of [[], [...b.detections, ...b.detections], [{...b.detections[0],predicted:true}]]) {
      expect(() => follower.sample({...b,detections}, 'ai:s:8', 10300)).toThrow('ptz_follow_target_lost');
    }
  });
  it('never zooms while following, including sustained small and large boxes', () => {
    const f = new FrameFollower('ai', created);
    for (let i = 0; i < 40; i++) {
      const size = i % 20 < 10 ? 90 : 650;
      const t = 10100 + i * 200;
      expect(f.sample(frame(t, 500-size/2, 500-size/2, size, size), 'ai:s:7', t).vector)
        .toEqual({pan:0, tilt:0, zoom:0});
    }
  });
  it('retains useful speed near center, stops inside the inner band and avoids hunting', () => {
    const f = new FrameFollower('ai', created);
    const positions = [850,650,540,525,544,555,600,420,410];
    const speeds = positions.map((center, i) => {
      const t = 10100 + 200*i;
      return f.sample(frame(t,center-50,450,100,100), 'ai:s:7', t).vector!.pan;
    });
    expect(speeds[0]).toBeGreaterThan(speeds[1]!);
    expect(speeds[2]).toBeGreaterThanOrEqual(.12);
    expect(speeds.slice(3,5)).toEqual([0,0]);
    expect(speeds[6]).toBeGreaterThan(0);
    expect(speeds[7]).toBe(0);
    expect(speeds[8]).toBeLessThan(0);
  });
  it('refuses predicted observations, wrong sources and expired sessions',()=>{
    const f=new FrameFollower('ai',created),a=frame(10100);
    expect(()=>f.sample({...a,detections:[{...a.detections[0],predicted:true}]},'ai:s:7',10100)).toThrow();
    expect(()=>f.sample({...a,channel_id:'other'},'ai:s:7',10100)).toThrow();
    expect(()=>f.sample(a,undefined,31000)).toThrow();
  });
});

function harness(moveStatus=false) {
  const store = {
    settings: async () => ({settings:{enabled:true, capacity:4, leaseMs:1200}}),
    camera: async () => ({settings:{enabled:true}}), guard: async () => null,
    block: vi.fn(async () => 1), record: vi.fn(), stopped: vi.fn(), restoreUnissued: vi.fn(), restore: vi.fn(),
  };
  const input = {id:'in',streamName:'cam',onvif:{deviceId:'nvr',videoSource:'camera'}} as Channel;
  const output = {id:'out',streamName:'detected'} as Channel;
  let fixedFrameTime: number | undefined;
  const frames = () => {
    const t = fixedFrameTime ?? Date.now();
    const first = frame(t,650,400,100,100,'ai:s:7');
    const second = frame(t,100,400,100,100,'ai:s:8');
    return {...first,detections:[...first.detections,...second.detections]};
  };
  const latestFrame = vi.fn(async () => frames());
  const call = vi.fn<PtzAdapter['call']>().mockResolvedValue({stopConfirmed:true});
  const verify = vi.fn(async () => {});
  const resetProcessors = vi.fn(async () => {});
  const manager = new PtzManager(store as unknown as PtzStore, {
    channels:async () => [input,output],
    ai:async () => [{id:'ai',config:{stream:{url:'rtmp://localhost/live/cam'},
      publish:{enabled:true,target_url:'rtmp://localhost/live/detected'}}}],
    prepare:async () => ({resource:'motor',identity:'nvr',protocol:'onvif',call,verify,
      caps:{panTilt:true,zoom:false,position:false,moveStatus,presets:false,presetWrite:false}}),
    latestFrame, resetProcessors, synchronize:async () => ({state:'applied'}),
  });
  return {manager,store,latestFrame,frames,call,verify,resetProcessors,
    setFrameTime:(t?:number) => { fixedFrameTime=t; }};
}

it('waits for the old wire-session stop before moving B and preserves the acquisition guard', async () => {
  const {manager,store,latestFrame,frames,call,verify,resetProcessors,setFrameTime}=harness();
  try {
    const {identity} = await manager.inspect('out');
    const {sessionId} = await manager.acquire('out','operator',identity!,'ai');
    const step = (id?:string) => manager.followStep('out',sessionId,'operator',id);
    await step();
    expect(call).toHaveBeenCalledTimes(1); // Only acquisition's guard stop.
    setFrameTime(Date.now());
    await step('ai:s:7');
    expect(await step('ai:s:7')).toMatchObject({moving:true});
    expect(call).toHaveBeenCalledTimes(2);
    const oldMove = call.mock.calls[1]![1]!.command as {session:string};
    let confirm!: (result:{stopConfirmed:boolean}) => void;
    call.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    setFrameTime();
    const switching = step('ai:s:8');
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
    expect(call.mock.calls[2]![1]!.command).toMatchObject({stop:true,session:oldMove.session});
    await expect(step('ai:s:8')).rejects.toThrow('ptz_busy');
    expect(call).toHaveBeenCalledTimes(3);
    confirm({stopConfirmed:true});
    expect((await switching).moving).toBe(false);
    setFrameTime(Date.now());
    expect((await step('ai:s:8')).moving).toBe(true);
    const newMove = call.mock.calls[3]![1]!.command as {session:string;vector:{pan:number}};
    expect(newMove.session).not.toBe(oldMove.session);
    expect(newMove.vector.pan).toBeLessThan(0);
    // A step already awaiting the backend frame, and one arriving out of
    // order after the brake, both carry the superseded display epoch.
    let deliver!: (value:ReturnType<typeof frames>) => void;
    latestFrame.mockImplementationOnce(() => new Promise(resolve => { deliver=resolve; }));
    const inFlight = step('ai:s:8');
    const held = await manager.followStep('out',sessionId,'operator','ai:s:8',true,1);
    expect(held.moving).toBe(false);
    expect(call.mock.calls.at(-1)![1]!.command).toMatchObject({stop:true,session:newMove.session});
    const afterBrake = call.mock.calls.length;
    deliver(frames());
    await inFlight;
    await step('ai:s:8');
    expect(call).toHaveBeenCalledTimes(afterBrake);
    expect(await manager.followStep('out',sessionId,'operator','ai:s:8',false,1))
      .toMatchObject({moving:false,waiting:true});
    setFrameTime(Date.now()+1);
    expect((await manager.followStep('out',sessionId,'operator','ai:s:8',false,1)).moving).toBe(true);
    // Interrupt after sampling but before command() finishes its guard checks.
    let finishVerify!: () => void;
    let checking!: () => void;
    const entered = new Promise<void>(resolve => { checking=resolve; });
    verify.mockImplementationOnce(() => new Promise<void>(resolve => { finishVerify=resolve; checking(); }));
    setFrameTime(Date.now()+2);
    const guarded = manager.followStep('out',sessionId,'operator','ai:s:8',false,1);
    await entered;
    await manager.followStep('out',sessionId,'operator','ai:s:8',true,2);
    const stoppedAt = call.mock.calls.length;
    finishVerify();
    expect(await guarded).toMatchObject({moving:false});
    expect(call).toHaveBeenCalledTimes(stoppedAt);
    expect(store.block).toHaveBeenCalledTimes(1);
    expect(resetProcessors).toHaveBeenCalledTimes(1);
    expect(store.restore).not.toHaveBeenCalled();
  } finally {
    await manager.close();
  }
});

it('polls a 5 FPS source every 125 ms without moving or renewing TTL on duplicate index and PTS', async () => {
  vi.useFakeTimers();
  const start=100_000;
  vi.setSystemTime(start);
  const {manager,call,latestFrame,frames,setFrameTime}=harness();
  try {
    const {identity}=await manager.inspect('out');
    const {sessionId}=await manager.acquire('out','operator',identity!,'ai');
    for (let poll=0;poll<=1000;poll+=125) {
      if (poll) await vi.advanceTimersByTimeAsync(125);
      const source=Math.min(400,Math.floor(poll/200)*200);
      setFrameTime(start+source);
      const current=frames();
      if (poll!==0 && poll!==250 && poll!==500) current.timestamp=Date.now()/1000;
      latestFrame.mockResolvedValueOnce(current);
      expect((await manager.followStep('out',sessionId,'operator','ai:s:7')).moving).toBe(true);
      expect(call).toHaveBeenCalledTimes(2+source/200);
    }
    await vi.advanceTimersByTimeAsync(49);
    expect(call).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.mock.calls[4]![1]!.command).toMatchObject({stop:true});
  } finally { await manager.close(); vi.useRealTimers(); }
});

it.each(['MOVING','UNKNOWN','IDLE'])('uses fresh %s feedback only after an acknowledged stop and washout', async status => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const {manager,call,latestFrame}=harness(true);
  try {
    const {identity}=await manager.inspect('out');
    const {sessionId}=await manager.acquire('out','operator',identity!,'ai');
    const step=(e:number) => {
      latestFrame.mockResolvedValueOnce(frame(Date.now(),450+e*1000,450,100,100));
      return manager.followStep('out',sessionId,'operator','ai:s:7');
    };
    await step(.20);
    await vi.advanceTimersByTimeAsync(200);
    let stop!: (r:{stopConfirmed:boolean}) => void;
    call.mockImplementationOnce(()=>new Promise(resolve=>{stop=resolve;}));
    let state='IDLE';
    call.mockImplementation(async op=>op==='status' ? {panTilt:state} : {stopConfirmed:true});
    const parking=step(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(stop).toBeTypeOf('function');
    expect(call.mock.calls.some(([op])=>op==='status')).toBe(false);
    stop({stopConfirmed:true});
    await parking;
    expect(call.mock.calls.at(-1)![0]).toBe('status');
    for (const e of [.015,.033,.051,0,0,.015,.033,.051]) {
      await vi.advanceTimersByTimeAsync(200);
      if (Date.now()===101600) state=status;
      const isLast=Date.now()===102000;
      expect((await step(e)).moving).toBe(isLast && status==='IDLE');
    }
  } finally { await manager.close(); vi.useRealTimers(); }
});

it('brakes at the wire TTL, starts four seconds only on stop confirmation, then rearms picking on the same lease', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const {manager,call,store,setFrameTime,latestFrame,frames}=harness();
  try {
    const {identity}=await manager.inspect('out');
    const {sessionId}=await manager.acquire('out','operator',identity!,'ai');
    const step=(track?:string,brake=false,epoch=0) => manager.followStep('out',sessionId,'operator',track,brake,epoch);
    setFrameTime(Date.now());
    await step('ai:s:7'); // Legacy Web: no brake or epoch fields.
    expect(call.mock.calls.at(-1)![1]!.command).toMatchObject({ttlMs:650});
    await vi.advanceTimersByTimeAsync(500);
    expect((await step('ai:s:7')).moving).toBe(true);
    // A rewritten result timestamp must not renew a repeated media frame.
    latestFrame.mockResolvedValueOnce({...frames(),timestamp:Date.now()/1000});
    expect((await step('ai:s:7')).moving).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    let confirm!: (v:{stopConfirmed:boolean}) => void;
    call.mockImplementationOnce(() => new Promise(resolve => { confirm=resolve; }));
    await vi.advanceTimersByTimeAsync(150);
    expect(call.mock.calls.at(-1)![1]!.command).toMatchObject({stop:true});
    const ack=step('ai:s:7',true,1);
    await vi.advanceTimersByTimeAsync(800);
    await expect(step('ai:s:7',false,1)).rejects.toThrow('ptz_busy');
    confirm({stopConfirmed:true});
    expect(await ack).toMatchObject({moving:false,holdMs:4000});
    await vi.advanceTimersByTimeAsync(2600);
    expect(await step('ai:s:7',true,1)).toMatchObject({holdMs:1400});
    expect(await step('ai:s:7',false,1)).toMatchObject({waiting:true,holdMs:1400});
    expect(call.mock.calls.length).toBe(3);
    setFrameTime(Date.now()-200);
    expect((await step('ai:s:7',false,1)).moving).toBe(true);
    expect(call.mock.calls.at(-1)![1]!.command).toMatchObject({ttlMs:450});
    await step('ai:s:7',true,2);
    await vi.advanceTimersByTimeAsync(4000);
    const count=call.mock.calls.length;
    expect(await step('ai:s:7',false,2)).toMatchObject({reselect:true,displayEpoch:3});
    expect(await step('ai:s:7',true,3)).toMatchObject({reselect:true});
    setFrameTime(Date.now());
    expect((await step(undefined,false,3)).choices).toHaveLength(2);
    expect(call.mock.calls.length).toBe(count);
    expect(store.stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(step(undefined,false,3)).rejects.toThrow('ptz_session_expired');
    expect(store.stopped).toHaveBeenCalledTimes(1);
    expect(store.restore).not.toHaveBeenCalled();
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});

it('requires a renderer round trip after an automatic stop and joins a concurrent generation-change brake', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const {manager,call,store}=harness();
  try {
    const {identity}=await manager.inspect('out');
    const {sessionId}=await manager.acquire('out','operator',identity!,'ai');
    const step=(id?:string,brake=false,epoch=0) => manager.followStep('out',sessionId,'operator',id,brake,epoch);
    await step('ai:s:7');
    await vi.advanceTimersByTimeAsync(1800);
    expect(await step('ai:s:7')).toMatchObject({moving:false,waiting:true,holdMs:2850});
    expect(call).toHaveBeenCalledTimes(3);
    expect((await step('ai:s:7')).moving).toBe(true);
    let confirm!: (v:{stopConfirmed:boolean}) => void;
    call.mockImplementationOnce(() => new Promise(resolve => { confirm=resolve; }));
    const brake=step('ai:s:7',true,1);
    const forget=step(undefined,true,2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(5);
    confirm({stopConfirmed:true});
    await brake;
    expect(await forget).toMatchObject({reselect:true,displayEpoch:3});
    expect((await step(undefined,false,3)).choices).toHaveLength(2);
    expect(store.stopped).not.toHaveBeenCalled();
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});
