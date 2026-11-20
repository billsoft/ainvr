import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { captureFlowView, CenterObservationError } from '@/components/player/ptzFlowFrames';
import type { PtzVector } from '@/api/ptzService';
import { flowCalibrationCoverage,runFlowCalibrationProbe,runFlowCenter,
  type FlowControl,type FlowFrame,type VisualCenterCalibrationSnapshot } from '@/components/player/ptzFlowCenter';

beforeEach(()=>{ vi.useFakeTimers(); });
afterEach(()=>{ vi.useRealTimers(); });
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const signal=()=>new AbortController().signal;
const dimensions={width:1920,height:1080};

function store(seed?:VisualCenterCalibrationSnapshot) {
  let current=seed;
  return {load:vi.fn(()=>current),save:vi.fn((s:VisualCenterCalibrationSnapshot)=>{current=s;})};
}
function trained() {
  const records: VisualCenterCalibrationSnapshot['records']=[];
  for (const axis of ['pan','tilt'] as const) {
    for (const sign of [-1,1] as const) {
      for (const ms of [1000,600,250,1000,600,250]) {
        records.push({axis,sign,speed:.36,durationMs:ms,displacement:(ms-80)*.0005,
          at:Date.now()-7*86400000-records.length});
      }
    }
  }
  return {version:1 as const,records};
}

function clickRig() {
  const moves:{at:number;v:PtzVector}[]=[];
  const stops:number[]=[];
  const storeNow=store(trained());
  const unused=vi.fn(()=>{throw Error('click accessed video or wrote calibration');});
  const control={calibrationStore:{load:storeNow.load,save:unused,allowEstimate:true},measure:unused,
    prepare:vi.fn(async()=>1200),
    move:vi.fn(async(v:PtzVector)=>{moves.push({at:performance.now(),v});}),
    release:vi.fn(async()=>{stops.push(performance.now());})};
  const click=(x:number,y:number,s=signal())=>runFlowCenter({...dimensions,...{fresh:unused}},{x,y},s,control);
  return {control,moves,stops,click,unused};
}

it('fits a durable six-endpoint delay and slope and runs a single open-loop Move through Stop',async()=>{
  const {click,moves,stops,unused}=clickRig();
  const run=click(.26,0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await run).toBe('estimated');
  expect(moves).toEqual([{at:0,v:{pan:.36,tilt:0,zoom:0}}]);
  expect(stops).toEqual([600]);
  expect(unused).not.toHaveBeenCalled();
});

it('uses the calibrated speeds for unequal axes, clears only the short axis and stops once',async()=>{
  const {click,moves,stops,unused}=clickRig();
  const run=click(-.26,.13);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await run).toBe('estimated');
  expect(moves).toEqual([{at:0,v:{pan:-.36,tilt:.36,zoom:0}},
    {at:340,v:{pan:-.36,tilt:0,zoom:0}}]);
  expect(stops).toEqual([600]);
  expect(unused).not.toHaveBeenCalled();
});

it.each([[1600,1100],[500,400]])('bounds a far click by fitted range and lease TTL %i',async(ttl,ms)=>{
  const {click,control,stops}=clickRig();
  control.prepare.mockResolvedValue(ttl);
  const run=click(1,0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await run).toBe('partial');
  expect(stops).toEqual([ms]);
});

it('never acquires for a centered click, an expired scope or missing/unreliable durations',async()=>{
  const {click,control,unused}=clickRig();
  expect(await click(0,0)).toBeUndefined();
  control.calibrationStore.allowEstimate=false;
  expect(await click(.3,0)).toBe('needs-calibration');
  expect(control.calibrationStore.load).not.toHaveBeenCalled();
  control.calibrationStore.allowEstimate=true;
  const s=trained();
  s.records=s.records.filter(r=>r.axis!=='pan' || r.sign!==1 || r.durationMs!==250);
  control.calibrationStore.load.mockReturnValue(s);
  expect(await click(.3,0)).toBe('needs-calibration');
  expect(flowCalibrationCoverage(s).filter(d=>d.ready)).toHaveLength(3);
  const inconsistent=trained();
  inconsistent.records.find(r=>r.axis==='pan' && r.sign===1)!.displacement*=2;
  control.calibrationStore.load.mockReturnValue(inconsistent);
  expect(await click(.3,0)).toBe('needs-calibration');
  expect(control.prepare).not.toHaveBeenCalled();
  expect(unused).not.toHaveBeenCalled();
});

it.each([1,2])('a pending Move %i ACK cannot postpone Stop or dispatch a stale vector',async pending=>{
  const {click,control,stops}=clickRig();
  let rejectLate!: (e:Error)=>void;
  control.move.mockImplementation(async()=>{
    if (control.move.mock.calls.length===pending) await new Promise<void>((_,r)=>{rejectLate=r;});
  });
  const run=click(.26,.13);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await run).toBe('partial');
  expect(stops).toEqual([pending===1 ? 340 : 600]);
  rejectLate(Error('session already stopped'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(control.move).toHaveBeenCalledTimes(pending);
  expect(control.release).toHaveBeenCalledTimes(1);
});

it('waits for confirmed Stop on abort and propagates a Stop failure',async()=>{
  const {click,control}=clickRig();
  const ac=new AbortController();
  let fail!: (e:Error)=>void;
  control.release.mockImplementation(()=>new Promise<void>((_,r)=>{fail=r;}));
  let done=false;
  const result=click(.26,.13,ac.signal).catch((e:Error)=>e).finally(()=>{done=true;});
  await vi.advanceTimersByTimeAsync(100);
  ac.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).toBe(false);
  expect(control.move).toHaveBeenCalledTimes(1);
  fail(Error('Stop unconfirmed'));
  expect(await result).toMatchObject({message:'Stop unconfirmed'});
  expect(control.release).toHaveBeenCalledTimes(1);
});

const frame=(at:number):FlowFrame=>({at,width:512,height:384,jpeg:String(at)});
function probeRig(axis:'pan'|'tilt',sign:-1|1,calibration=store()) {
  let issued=Infinity, stopped=Infinity;
  const timeline:string[]=[];
  const capture={initial:frame(performance.now()),fresh:vi.fn(async(s:AbortSignal)=>{
    await sleep(10); s.throwIfAborted(); return frame(performance.now());
  })};
  // The decoder presents the move 1800 ms later. The motor starts after 80 ms.
  const travel=(at:number)=>Math.max(0,Math.min(at-1800,stopped)-issued-80)*.045;
  const control:FlowControl={
    calibrationStore:calibration,
    async prepare(){timeline.push('prepare');return 1200;},
    async move(v){timeline.push('move');expect(v).toEqual({pan:axis==='pan' ? sign*.36:0,
      tilt:axis==='tilt' ? sign*.36:0,zoom:0});issued=performance.now();},
    async release(){timeline.push('stop');stopped=performance.now();},
    measure:vi.fn(async(a,b)=>{
      const delta=travel(b.at)-travel(a.at);
      timeline.push(a===b ? 'warm' : 'pair');
      return {dx:axis==='pan' ? -sign*delta : 0,dy:axis==='tilt' ? sign*delta:0,
        width:512,height:384,inliers:1800,validRatio:.96,spread:.2,backend:'bpu'};
    }),
  };
  return {capture,control,timeline,calibration,duration:()=>stopped-issued,
    run:(s=signal())=>runFlowCalibrationProbe(capture,axis,sign,s,control)};
}

it.each([['pan',1],['tilt',-1]] as const)('calibrates %s %i from incremental flow after a delayed stable endpoint',async(axis,sign)=>{
  const calibration=store();
  const warmup={ready:false};
  for (const [i,expected] of [1000,600,250,1000,600,250].entries()) {
    const r=probeRig(axis,sign,calibration);
    r.control.calibrationWarmup=warmup;
    const run=r.run();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await run).toBe(true);
    expect(r.duration()).toBe(expected);
    expect(warmup.ready).toBe(true);
    expect(r.timeline.filter(event=>event==='warm')).toHaveLength(i===0?1:0);
    expect(r.timeline.slice(i===0?1:0,i===0?3:2)).toEqual(['prepare','move']);
    expect(r.capture.fresh).toHaveBeenCalled();
    const samples=calibration.load()!.records;
    expect(samples).toHaveLength(i+1);
    expect(samples.at(-1)!.displacement).toBeCloseTo((expected-80)*.045/(axis==='pan'?256:192),5);
    expect(flowCalibrationCoverage(calibration.load()).filter(d=>d.ready)).toHaveLength(i===5?1:0);
  }
});

it('allows a 12-second cold warmup before any lease or motor command',async()=>{
  const r=probeRig('pan',1);
  const measure=r.control.measure;
  r.control.measure=async(a,b,s)=>{
    if(a===b) await sleep(12000);
    return measure(a,b,s);
  };
  const run=r.run();
  await vi.advanceTimersByTimeAsync(11999);
  expect(r.timeline).toEqual([]);
  expect(r.capture.fresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await run).toBe(true);
  expect(r.timeline.slice(0,3)).toEqual(['warm','prepare','move']);
  expect(r.duration()).toBe(1000);
});

it('propagates stale epoch from preflight without acquiring or moving',async()=>{
  const r=probeRig('pan',1);
  const warmup=r.control.calibrationWarmup={ready:false};
  r.control.measure=vi.fn(async()=>{throw Error('ptz_calibration_stale');});
  await expect(r.run()).rejects.toThrow('ptz_calibration_stale');
  expect(warmup.ready).toBe(false);
  expect(r.timeline).toEqual([]);
  expect(r.calibration.save).not.toHaveBeenCalled();
});

it('requires a new presented frame before acquire even after a successful warmup',async()=>{
  const r=probeRig('pan',1);
  r.control.calibrationWarmup={ready:true};
  r.capture.fresh.mockResolvedValue(r.capture.initial);
  expect(await r.run()).toBe(false);
  expect(r.capture.fresh).toHaveBeenCalledTimes(1);
  expect(r.control.measure).not.toHaveBeenCalled();
  expect(r.timeline).toEqual([]);
});

it('stops on a missing flow interval and never saves an invented zero displacement',async()=>{
  const r=probeRig('pan',1);
  const measure=r.control.measure;
  r.control.measure=async(a,b,s)=>{
    const m=await measure(a,b,s);
    return a===b ? m : {...m,validRatio:0};
  };
  const run=r.run();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await run).toBe(false);
  expect(r.duration()).toBeLessThan(1000);
  expect(r.timeline.filter(t=>t==='stop')).toHaveLength(1);
  expect(r.calibration.save).not.toHaveBeenCalled();
});

it('keeps the probe Stop independent of slow flow and rejects a late Move ACK',async()=>{
  const r=probeRig('pan',1);
  const move=r.control.move,measure=r.control.measure;
  r.control.move=async v=>{await move(v);await sleep(3000);};
  r.control.measure=async(a,b,s)=>{
    if(a!==b && a.at>400) await sleep(2000);
    return measure(a,b,s);
  };
  const err=expect(r.run()).rejects.toThrow('运动回执');
  await vi.advanceTimersByTimeAsync(6000);
  await err;
  expect(r.duration()).toBe(1000);
  expect(r.calibration.save).not.toHaveBeenCalled();
});

it('captures the presented video as 512×384 JPEG and rejects frames from a replaced source', async () => {
  const video = document.createElement('video');
  let source = 'first';
  let present!: () => void;
  Object.defineProperties(video, {
    videoWidth: { value: 1920 }, videoHeight: { value: 1080 },
    paused: { value: false }, readyState: { value: 4 },
    currentSrc: { get: () => source },
    requestVideoFrameCallback: { value: (cb: () => void) => { present = cb; return 1; } },
    cancelVideoFrameCallback: { value: vi.fn() },
  });
  const drawImage = vi.fn();
  const ctx = vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D);
  const jpeg = vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/jpeg;base64,YQ==');
  try {
    const capturing = captureFlowView(video, signal());
    expect(drawImage).not.toHaveBeenCalled();
    present();
    const frames = await capturing;
    expect(frames.initial).toMatchObject({width:512,height:384,jpeg:'YQ=='});
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(video,0,0,512,384);
    const next = frames.fresh(signal());
    source = 'second';
    present();
    await expect(next).rejects.toBeInstanceOf(CenterObservationError);
    expect(jpeg).toHaveBeenCalledTimes(1);
  } finally {
    ctx.mockRestore();
    jpeg.mockRestore();
  }
});
