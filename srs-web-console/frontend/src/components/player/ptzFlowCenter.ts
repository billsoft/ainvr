import type { PtzVector } from '@/api/ptzService';

export interface VisualCenterCalibrationRecord {
  axis: 'pan' | 'tilt';
  sign: -1 | 1;
  speed: number;
  durationMs: number;
  displacement: number; // Magnitude along the axis in [-1, 1] image coordinates.
  at: number; // Unix milliseconds.
}
export interface VisualCenterCalibrationSnapshot {
  version: 1;
  records: VisualCenterCalibrationRecord[];
}
export interface VisualCenterCalibrationStore {
  allowEstimate?: boolean;
  load(): VisualCenterCalibrationSnapshot | null | undefined;
  save(snapshot: VisualCenterCalibrationSnapshot): void;
}

export interface FlowFrame { jpeg: string; at: number; width: 512; height: 384 }
export interface FlowFrames {
  initial: FlowFrame;
  fresh(signal: AbortSignal, timeout?: number): Promise<FlowFrame>;
}
export interface FlowMeasurement {
  dx: number; dy: number; width: number; height: number;
  inliers: number; validRatio: number; spread: number; backend: string;
}
export interface FlowCenterControl {
  prepare(): Promise<number | void>;
  move(vector: PtzVector): Promise<unknown>;
  release(): Promise<void>;
  calibrationStore?: Pick<VisualCenterCalibrationStore,'load'|'allowEstimate'>;
}
export interface FlowControl extends FlowCenterControl {
  calibrationWarmup?: { ready: boolean }; // Owned by one explicit calibration run.
  measure(a: FlowFrame, b: FlowFrame, signal: AbortSignal): Promise<FlowMeasurement>;
  calibrationStore?: VisualCenterCalibrationStore;
}

type Point = { x: number; y: number };
type Axis = 'pan' | 'tilt';
type Sample = VisualCenterCalibrationRecord;
type Dimensions = {width:number; height:number};
type Outcome = 'needs-calibration' | 'estimated' | 'partial' | void;
const pulseLengths = [1000,600,250] as const;
const axes = ['pan','tilt'] as const;
const scale = {pan:256, tilt:192};
const coord = {pan:'x', tilt:'y'} as const;
const now = () => performance.now();
const centered = (p: Point) => Math.hypot(p.x,p.y) <= .025;
const pixels = (p: Point) => Math.hypot(p.x*256,p.y*192);
class ObservationLost extends Error {}

function onAbort(signal: AbortSignal, callback: () => void) {
  signal.addEventListener('abort',callback,{once:true});
  if (signal.aborted) callback();
  return () => signal.removeEventListener('abort',callback);
}

async function bounded<T>(signal: AbortSignal, ms: number, task: (s: AbortSignal) => Promise<T>) {
  signal.throwIfAborted();
  const expiry = new AbortController();
  const s = AbortSignal.any([signal,expiry.signal]);
  let detach = () => {};
  const cancelled = new Promise<never>((_,reject) => { detach = onAbort(s,() => reject(s.reason)); });
  const timer = setTimeout(() => expiry.abort(new ObservationLost('视频反馈超时')),ms);
  try { return await Promise.race([cancelled,task(s)]); }
  finally { clearTimeout(timer); detach(); }
}

function validFrame(f: FlowFrame) {
  return !!f && f.width === 512 && f.height === 384 && !!f.jpeg && Number.isFinite(f.at);
}

async function measure(control: FlowControl,a: FlowFrame,b: FlowFrame,signal: AbortSignal,timeout=750) {
  const m = await bounded(signal,timeout,s => control.measure(a,b,s));
    if (m.width !== 512 || m.height !== 384 || !m.backend ||
        ![m.dx,m.dy,m.validRatio,m.inliers,m.spread].every(Number.isFinite) ||
        m.validRatio < .5 || m.validRatio > 1 || m.inliers < 4 || m.spread < 0 ||
        m.spread > Math.max(3,.4*Math.hypot(m.dx,m.dy)) ||
        Math.abs(m.dx) > 128 || Math.abs(m.dy) > 96) throw new ObservationLost();
  return m;
}

async function fresh(frames: FlowFrames,signal: AbortSignal,after: number) {
  try {
    const f = await bounded(signal,750,s => frames.fresh(s,750));
    if (!validFrame(f) || f.at <= after || f.at > now()+1 || now()-f.at > 500) throw new ObservationLost();
    return f;
  } catch { signal.throwIfAborted(); throw new ObservationLost(); }
}

async function warm(frames: FlowFrames,signal: AbortSignal,control: FlowControl) {
  if (!validFrame(frames.initial)) throw new ObservationLost();
  signal.throwIfAborted();
  const cache = control.calibrationWarmup;
  if (cache?.ready) return;
  const m = await measure(control,frames.initial,frames.initial,signal,20000);
  signal.throwIfAborted();
  if (Math.hypot(m.dx,m.dy) > 1) throw new ObservationLost();
  if (cache) cache.ready = true;
}

function translated(p: Point,m: FlowMeasurement): Point {
  return {x:p.x+m.dx/256,y:p.y-m.dy/192};
}

function records(store?: FlowCenterControl['calibrationStore']): Sample[] {
  const snap = store?.load();
  if (snap?.version !== 1 || !Array.isArray(snap.records) || snap.records.length>24) return [];
  const at = Date.now();
  return snap.records.filter(r => r && axes.includes(r.axis) && (r.sign===1 || r.sign===-1) &&
    Number.isSafeInteger(r.at) && r.at>0 && r.at<=at &&
    Number.isFinite(r.speed) && Math.abs(r.speed-.36)<.001 &&
    Number.isFinite(r.durationMs) && Number.isFinite(r.displacement) &&
    r.displacement*scale[r.axis]>=3 && r.displacement<=2);
}

function groups(all: Sample[],axis: Axis,sign: number) {
  return pulseLengths.map(ms => all.filter(r => r.axis===axis && r.sign===sign &&
    Math.abs(r.durationMs-ms)<=Math.max(20,.08*ms)).sort((a,b) => b.at-a.at).slice(0,2));
}

function fit(all: Sample[],axis: Axis,sign: number) {
  const bins = groups(all,axis,sign);
  if (bins.some(bin => bin.length!==2 || bin[0]!.at===bin[1]!.at ||
      Math.max(...bin.map(r=>r.displacement))>1.25*Math.min(...bin.map(r=>r.displacement)))) return;
  const samples = bins.flat();
  const meanT = samples.reduce((s,r)=>s+r.durationMs,0)/samples.length;
  const meanD = samples.reduce((s,r)=>s+r.displacement,0)/samples.length;
  const variance = samples.reduce((s,r)=>s+(r.durationMs-meanT)**2,0);
  const slope = samples.reduce((s,r)=>s+(r.durationMs-meanT)*(r.displacement-meanD),0)/variance;
  if (!(slope>0)) return;
  const lag = meanT-meanD/slope;
  if (!Number.isFinite(lag) || Math.abs(lag)>200) return;
  if (samples.some(r => Math.abs(slope*(r.durationMs-lag)-r.displacement)>
    Math.max(1.25/scale[axis],.16*r.displacement))) return;
  return {slope,lag,limit:Math.min(1100,1.25*Math.max(...samples.map(r=>r.durationMs)))};
}

export function flowCalibrationCoverage(snapshot: ReturnType<VisualCenterCalibrationStore['load']>) {
  const all = records({load:()=>snapshot});
  return axes.flatMap(axis => ([-1,1] as const).map(sign => ({axis,sign,ready:!!fit(all,axis,sign)})));
}

// Only the .36 command was calibrated. Invert each axis separately and
// turn off the shorter axis without stopping the other motor or reversing.
function predict(all: Sample[],p: Point) {
  const duration = {pan:0,tilt:0};
  let limited = false;
  const vector: PtzVector = {pan:0,tilt:0,zoom:0};
  for (const axis of axes) {
    const distance = p[coord[axis]];
    if (Math.abs(distance)*scale[axis]<=1) continue;
    const curve = fit(all,axis,Math.sign(distance));
    if (!curve) return;
    const ms = Math.abs(distance)/curve.slope+curve.lag;
    limited ||= ms>curve.limit;
    duration[axis] = Math.round(Math.min(curve.limit,Math.max(60,ms)));
    vector[axis] = Math.sign(distance)*.36;
  }
  return {duration,vector,limited};
}

interface AxisDeadline {ms:number; vector:PtzVector}

// The dispatch clock owns both deadlines. ACK callbacks may report failure
// while a command is active, but never start, lengthen or stop another move.
async function pulse(control: FlowCenterControl,vector: PtzVector,ms: number,signal: AbortSignal,
  stop: () => Promise<void>, observation?: Promise<void>, short?: AxisDeadline) {
  signal.throwIfAborted();
  const start=now();
  let timer: ReturnType<typeof setTimeout>;
  let axisTimer: ReturnType<typeof setTimeout>|undefined;
  let detach=()=>{};
  let acknowledged=false;
  let dispatchGeneration=0;
  let ended=false;
  try {
    const deadline=new Promise<void>((resolve,reject) => {
      const finish=(failed:boolean,reason?:unknown) => {
        if (ended) return;
        ended=true;
        if (failed) reject(reason);
        else resolve();
      };
      function send(command:PtzVector) {
        if (ended) return;
        acknowledged=false;
        const generation=++dispatchGeneration;
        const current=()=>!ended && generation===dispatchGeneration;
        try {
          control.move(command).then(() => {
            if (current()) acknowledged=true;
          },error => {
            if (current()) finish(true,error);
          });
        } catch (error) {
          if (current()) finish(true,error);
        }
      }
      timer=setTimeout(()=>finish(false),ms);
      detach=onAbort(signal,()=>finish(true,signal.reason));
      if (short) axisTimer=setTimeout(()=>{
        if (!acknowledged || now()>=start+ms) { finish(false); return; }
        send(short.vector);
      },short.ms);
      observation?.then(()=>finish(false),e=>finish(true,e));
      send(vector);
    });
    await deadline;
    signal.throwIfAborted();
    return {duration:now()-start,acknowledged};
  } finally {
    ended=true;
    clearTimeout(timer!);
    clearTimeout(axisTimer);
    detach();
    await stop();
  }
}

async function withLease<T>(control: FlowCenterControl,signal: AbortSignal,
  action: (expires: number,stop:()=>Promise<void>)=>Promise<T>) {
  signal.throwIfAborted();
  const ttl = await control.prepare();
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= Promise.resolve().then(() => control.release());
  try {
    signal.throwIfAborted();
    const duration = ttl===undefined ? 620 : ttl;
    if (!Number.isFinite(duration) || duration<=100) throw Error('云台控制租约不足。');
    return await action(now()+duration-100,stop);
  } finally { await stop(); }
}

export async function runFlowCenter(dimensions: Dimensions,click: Point,signal: AbortSignal,
  control: FlowCenterControl): Promise<Outcome> {
  signal.throwIfAborted();
  if (![dimensions.width,dimensions.height].every(n=>Number.isFinite(n) && n>0) ||
      ![click.x,click.y].every(n=>Number.isFinite(n) && Math.abs(n)<=1)) throw Error('无效的画面坐标。');
  if (centered(click)) return;
  const store = control.calibrationStore;
  if (!store || store.allowEstimate===false) return 'needs-calibration';
  const plan = predict(records(store),click);
  if (!plan) return 'needs-calibration';
  return withLease(control,signal,async (expires,stop) => {
    if (store.allowEstimate===false) return 'needs-calibration' as const;
    const limit=Math.floor(expires-now());
    if (limit<60) throw Error('云台控制租约不足。');
    const pan=Math.min(limit,plan.duration.pan), tilt=Math.min(limit,plan.duration.tilt);
    const duration=Math.max(pan,tilt);
    const short=pan && tilt && pan!==tilt ? {ms:Math.min(pan,tilt), vector:{
      pan:pan<tilt ? 0 : plan.vector.pan, tilt:tilt<pan ? 0 : plan.vector.tilt,zoom:0,
    }} : undefined;
    const sent=await pulse(control,plan.vector,duration,signal,stop,undefined,short);
    signal.throwIfAborted();
    const truncated=plan.limited || duration<Math.max(plan.duration.pan,plan.duration.tilt) ||
      sent.duration+2<duration || !sent.acknowledged;
    return truncated ? 'partial' as const : 'estimated' as const;
  });
}

function nap(ms: number,signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve,reject) => {
    const timer=setTimeout(() => { detach(); resolve(); },Math.max(0,ms));
    const detach=onAbort(signal,() => { clearTimeout(timer); reject(signal.reason); });
  });
}

async function observe(frames: FlowFrames,control: FlowControl,initial: FlowFrame,axis: Axis,sign: number,
  start: number,stopped: {at:number; duration:number},signal: AbortSignal) {
  let previous=initial, p:Point={x:0,y:0};
  let onset: number|undefined, quiet: {at:number; point:Point; count:number}|undefined;
  let furthest=0;
  for (;;) {
    // Pair adjacent samples, including throughout the Stop request. A failed
    // interval invalidates the sum; never restart the integration at zero.
    await nap(110-(now()-previous.at),signal);
    const frame=await fresh(frames,signal,previous.at);
    if (frame.at-previous.at>600) throw new ObservationLost();
    const m=await measure(control,previous,frame,signal);
    signal.throwIfAborted();
    p=translated(p,m);
    previous=frame;
    const along=-sign*p[coord[axis]]*scale[axis];
    const lateral=axis==='pan' ? Math.abs(p.y)*192 : Math.abs(p.x)*256;
    furthest=Math.max(furthest,along);
    if (along < -2 || furthest-along>Math.max(2,furthest*.2)) throw new ObservationLost();
    if (along>=2) onset ??= Math.max(0,frame.at-start);
    if (onset===undefined || frame.at<Math.max(stopped.at,start+stopped.duration+onset) ||
        Math.hypot(m.dx,m.dy)>.65 || along<3 || lateral>Math.max(1.5,.25*along)) {
      quiet=undefined;
      continue;
    }
    if (!quiet || pixels({x:p.x-quiet.point.x,y:p.y-quiet.point.y})>.9)
      quiet={at:frame.at,point:p,count:0};
    quiet.count++;
    if (quiet.count>=3 && frame.at-quiet.at>=300) return along/scale[axis];
  }
}

function nextLength(bins: Sample[][]) {
  // Visit all three durations before repeating. When the six measurements
  // disagree, refresh the oldest group first on an explicit retry.
  let index=0;
  for (let i=1;i<bins.length;i++) {
    const a=bins[i]!, b=bins[index]!;
    if (a.length<b.length || (a.length===b.length && a.length && a[0]!.at<b[0]!.at)) index=i;
  }
  return index;
}

export async function runFlowCalibrationProbe(frames: FlowFrames,axis: Axis,sign: -1|1,
  signal: AbortSignal,control: FlowControl): Promise<boolean> {
  signal.throwIfAborted();
  const store=control.calibrationStore;
  if (!store || !axes.includes(axis) || (sign!==1 && sign!==-1)) return false;
  const bins=groups(records(store),axis,sign);
  const index=nextLength(bins);
  const ms=pulseLengths[index]!;
  try {
    await warm(frames,signal,control);
    const preflight=await fresh(frames,signal,frames.initial.at);
    return await withLease(control,signal,async (expires,stop) => {
      const initial=await fresh(frames,signal,preflight.at);
      const planned=Math.min(ms,Math.floor(expires-now()));
      if (ms-planned>Math.max(20,.08*ms)) return false;
      const vector:PtzVector={pan:0,tilt:0,zoom:0};
      vector[axis]=.36*sign;
      const stopped={at:Infinity,duration:Infinity};
      const watch=new AbortController();
      const observation=observe(frames,control,initial,axis,sign,now(),stopped,
        AbortSignal.any([signal,watch.signal]));
      try {
        // observe cannot resolve before Stop, but it can reject mid-pulse.
        const {duration,acknowledged}=await pulse(control,vector,planned,signal,stop,observation.then(()=>{}));
        if (!acknowledged) throw Error('运动回执未及时确认，已确认停转。');
        stopped.at=now();
        stopped.duration=duration;
        signal.throwIfAborted();
        if (Math.abs(duration-ms)>Math.max(20,ms*.08)) return false;
        const displacement=await bounded(signal,4000,() => observation);
        signal.throwIfAborted();
        if (!(displacement>0 && displacement<=2)) return false;
        const previous=records(store);
        const keep=groups(previous,axis,sign).flatMap((bin,i)=>i===index ? bin.slice(0,1) : bin);
        const sample:Sample={axis,sign,speed:.36,durationMs:duration,displacement,at:Date.now()};
        store.save({version:1,records:[
          ...previous.filter(r=>r.axis!==axis || r.sign!==sign),...keep,sample,
        ]});
        return true;
      } finally { watch.abort(); }
    });
  } catch (e) { signal.throwIfAborted(); if (e instanceof ObservationLost) return false; throw e; }
}
