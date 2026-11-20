import { z } from 'zod';
import { PtzError } from '../store/ptzStore.js';

const observed = z.object({
  track_id: z.string().max(256).nullish(), class_name: z.string(),
  predicted: z.boolean().optional(), lowConfidence: z.boolean().optional(),
  bbox: z.object({x:z.number(), y:z.number(), w:z.number(), h:z.number()}),
});
const result = z.object({
  stream_url:z.string().optional(),
  channel_id:z.string(), frame_width:z.number().positive(), frame_height:z.number().positive(),
  frame_index:z.number().int().nonnegative(), frame_pts_ns:z.number().nonnegative(), timestamp:z.number(),
  detections:z.array(observed).max(1000),
  model_extra:z.object({analytics:z.object({stream_session_id:z.string().optional()}).optional()}).optional(),
});
export const followPickMs = 20_000;
export const followFreshMs = 650;
export const followHoldMs = 4000;
export const followSpeedLimit = 0.50;

// Error is a fraction of the current field of view. Inside the inner band
// stop, then require a larger excursion to restart. Active axes have a speed
// floor so a small remaining offset does not stall the motor.
function axisSpeed(error: number, lastSpeed: number, extent: number) {
  const distance = Math.abs(error);
  if (distance <= (lastSpeed === 0 ? 0.055 : 0.03) || error * lastSpeed < 0) return 0;
  // Fast sweeps can move a small box farther than its own width between AI
  // frames. Limit the top speed for small targets; keep a useful approach speed.
  const ceiling = Math.min(0.31, 0.19 + 0.60 * extent);
  return Math.sign(error) * Math.min(ceiling, 0.12 + 0.9 * (distance - 0.03));
}

type Observation = { pan:number; tilt:number; w:number; h:number; pts:number; idle:boolean };

// All distances are fractions of one image axis. During movement the slope is
// used only to recognize worsening screen error; it is never a world velocity.
function followAxis(axis:'pan'|'tilt', current:Observation, history:Observation[], last:number,
                    drivingSince:number, now:number, ageMs:number, limit:number) {
  const size = axis==='pan' ? 'w' : 'h';
  const error = current[axis];
  const base = axisSpeed(error,last,current[size]);
  if (history.length < 2 || ageMs>250) return base;
  const [a,b]=history as [Observation,Observation];
  const dt=current.pts-b.pts, prevDt=b.pts-a.pts;
  if (Math.min(dt,prevDt)<0.04 || Math.max(dt,prevDt)>0.40) return base;
  const sign=Math.sign(error);
  const outward=(error-b[axis])*sign, priorOutward=(b[axis]-a[axis])*sign;
  if (Math.min(outward,priorOutward)<0.003) return base;
  const rate=Math.min(outward/dt,priorOutward/prevDt);
  if (current.idle && b.idle && a.idle) {
    const lead=Math.min(0.04,rate*Math.min(0.16,dt));
    return axisSpeed(error+sign*lead,last,current[size]);
  }
  if (!base || Math.sign(last)!==sign || !drivingSince || now-drivingSince < 350+ageMs) return base;
  const margin = 0.5-Math.abs(error)-current[size]/2;
  const edgeRate=Math.min((outward+(current[size]-b[size])/2)/dt,
                          (priorOutward+(b[size]-a[size])/2)/prevDt);
  if (edgeRate<=0 || margin>0.30) return base;
  const edgeSeconds=margin/edgeRate;
  const tier=edgeSeconds<1.2 ? limit : edgeSeconds<2.4 ? Math.min(limit,0.38) : 0;
  // Conservative simulation envelope: normalized image travel per command
  // unit, including observation lag, one sample, actuator lag and coast.
  const stopTime=0.32+dt+Math.max(0,ageMs)/1000;
  const stoppable=(Math.abs(error)-0.055)/(1.2*stopTime);
  const ramp=Math.abs(last)+0.65*Math.min(dt,0.25);
  return sign*Math.max(Math.abs(base),Math.min(tier,stoppable,ramp));
}

export class FrameFollower {
  target='';
  processing=false;
  needsDiscovery=false;
  needsHoldAck=false;
  displayEpoch=0;
  parking?:Promise<void>;
  holding?:Promise<void>;
  motionUntil=0;
  holdUntil=0;
  heldId?:string;
  observationDeadline=0;
  private pan = 0;
  private tilt = 0;
  private lastSeen=0;
  parked=true;
  private previous?:{index:number;pts:number;timestamp:number};
  private streamUrl?:string;
  private history:Observation[]=[];
  private idleAt=0;
  private idleUntil=0;
  private idlePts?:number;
  idleProbeAfter=0;
  idleProbePending=false;
  private leadUntil=0;
  private motor={pan:0,tilt:0};
  private drivingSince={pan:0,tilt:0};
  constructor(readonly processor:string,readonly created:number,private readonly speedLimit=followSpeedLimit) {}
  revokeIdle() {
    this.idleAt=0;
    this.idleUntil=0;
    this.idlePts=undefined;
    for (const sample of this.history) sample.idle=false;
  }
  observeIdle(idle:boolean, sent:number, now:number) {
    if (!idle || now<sent || now-sent>250) { this.revokeIdle(); return; }
    if (!this.idleAt || now>=this.idleUntil) {
      this.revokeIdle();
      this.idleAt=now;
    }
    this.idleUntil=sent+followFreshMs;
  }
  leadExpired(now:number) {
    return !!this.leadUntil && (now>=this.leadUntil || !this.idleAt || this.idleProbePending);
  }
  dispatched(pan:number,tilt:number,now:number) {
    const next={pan:Math.sign(pan),tilt:Math.sign(tilt)};
    for (const axis of ['pan','tilt'] as const) {
      if (next[axis]!==this.motor[axis]) this.drivingSince[axis]=next[axis] ? now : 0;
    }
    if (next.pan!==this.motor.pan || next.tilt!==this.motor.tilt) this.history=[];
    this.motor=next;
    this.revokeIdle();
    this.idleProbeAfter=0;
  }
  hold(id:string|undefined) {
    if (!id || (this.target && this.target !== id) || (this.heldId && this.heldId !== id))
      throw new PtzError('ptz_follow_target_lost',409);
    this.heldId = id;
    this.revokeIdle();
    this.history=[];
    this.pan = this.tilt = 0;
  }
  resumed() {
    this.heldId = undefined;
    this.holdUntil = 0;
  }
  sample(raw:unknown, id:string|undefined, now:number) {
    if (this.heldId && (id !== this.heldId || !this.holdUntil || !this.parked || now >= this.holdUntil))
      throw new PtzError('ptz_follow_target_lost',409);
    if(!this.target && !this.heldId && now-this.created>=followPickMs) throw new PtzError('ptz_follow_ended',409);
    const parsed=result.safeParse(raw);
    const frame=parsed.success ? parsed.data : undefined;
    const age=frame ? now-frame.timestamp*1000 : Infinity;
    if(raw == null && (this.target || this.heldId)) return {choices:[],vector:null,missing:true};
    if(frame && frame.channel_id!==this.processor && (id || this.target)) throw new PtzError('ptz_source_changed',409);
    if(!frame || frame.channel_id!==this.processor || frame.timestamp*1000<this.created || age< -25) {
      if(id || this.target) throw new PtzError('ptz_follow_frame_stale',409);
      return {choices:[],vector:null};
    }
    const tracks=frame.detections.filter(d=>d.track_id && !d.predicted && !d.lowConfidence &&
      d.bbox.w>0 && d.bbox.h>0 && d.bbox.x>=0 && d.bbox.y>=0 &&
      d.bbox.x+d.bbox.w<=frame.frame_width+1 && d.bbox.y+d.bbox.h<=frame.frame_height+1);
    const choices=tracks.map(d=>({id:d.track_id!,label:d.class_name,x:(d.bbox.x+d.bbox.w/2)/frame.frame_width,w:d.bbox.w/frame.frame_width,h:d.bbox.h/frame.frame_height,y:(d.bbox.y+d.bbox.h/2)/frame.frame_height}));
    if(!id && !this.target) return {choices:age>followFreshMs ? [] : choices,vector:null};
    const selected = this.target || this.heldId || id;
    if (selected) {
      if (this.streamUrl !== undefined && frame.stream_url !== this.streamUrl)
        throw new PtzError('ptz_source_changed',409);
      this.streamUrl=frame.stream_url;
      const prefix = selected.slice(0,selected.lastIndexOf(':')+1);
      const session=frame.model_extra?.analytics?.stream_session_id;
      if ((session !== undefined && session+':' !== prefix) ||
          frame.detections.some(d => d.track_id && d.track_id.slice(0,d.track_id.lastIndexOf(':')+1) !== prefix))
        throw new PtzError('ptz_follow_target_lost',409);
    }
    const matches=tracks.filter(d=>d.track_id===id);
    // Keep a watermark for *all* inspected frames, including empty frames.
    const prior=this.previous;
    const pts=frame.frame_pts_ns/1e9;
    const repeat=prior?.index===frame.frame_index && pts===prior.pts;
    if(prior && !repeat && (frame.timestamp<prior.timestamp || frame.frame_index<=prior.index || pts<=prior.pts))
      throw new PtzError('ptz_follow_frame_stale',409);
    if (!repeat) this.previous={index:frame.frame_index,pts,timestamp:frame.timestamp};
    if (age>followFreshMs || (this.heldId && frame.timestamp*1000 < this.holdUntil-followHoldMs)) {
      if (!this.target && !this.heldId) throw new PtzError('ptz_follow_frame_stale',409);
      return {choices:[],vector:null,missing:true};
    }
    if (this.target && this.target !== id) {
      if (!id || matches.length !== 1) throw new PtzError('ptz_follow_target_lost',409);
      // followStep serializes samples and confirms this brake before accepting
      // another step. The new target starts with both axes at rest.
      this.target = id;
      this.history=[];
      this.pan = this.tilt = 0;
      this.observationDeadline = 0;
      this.lastSeen = now;
      return {choices, vector:null};
    }
    // Brake immediately on a missed detection. A short gap may resume only
    // with the same full identity and fresh measured geometry.
    if(matches.length===0 && (this.target || this.heldId)) {
      return {choices,vector:null,missing:true};
    }
    if(matches.length!==1) throw new PtzError('ptz_follow_target_lost',409);
    if (repeat) return {choices,vector:null,repeat:true};
    if (!this.heldId && this.target && (now-this.lastSeen>followFreshMs || (prior && pts-prior.pts>0.85)))
      return {choices,vector:null,missing:true};
    this.target=id!;
    const box=matches[0]!.bbox;
    const x=(box.x+box.w/2)/frame.frame_width, y=(box.y+box.h/2)/frame.frame_height;
    this.observationDeadline = frame.timestamp * 1000 + followFreshMs;
    this.lastSeen = now;
    // Wash out both the result clock and source PTS after explicit device IDLE.
    // GB without MoveStatus still uses outward screen error for edge feedback.
    if (this.idleAt && now>=this.idleUntil) this.revokeIdle();
    if (this.parked && this.idleAt && frame.timestamp*1000>=this.idleAt) this.idlePts ??= pts;
    const idle=!!this.idleAt && !this.idleProbePending && this.parked && this.idlePts!==undefined &&
      pts-this.idlePts>=followFreshMs/1000 && frame.timestamp*1000-this.idleAt>=followFreshMs;
    const sample={pan:x-0.5,tilt:0.5-y,w:box.w/frame.frame_width,h:box.h/frame.frame_height,pts,idle};
    this.leadUntil=idle && this.history.length===2 && this.history.every(s=>s.idle) ? this.idleUntil : 0;
    this.pan=followAxis('pan',sample,this.history,this.pan,this.drivingSince.pan,now,age,this.speedLimit);
    this.tilt=followAxis('tilt',sample,this.history,this.tilt,this.drivingSince.tilt,now,age,this.speedLimit);
    this.history.push(sample);
    if (this.history.length>2) this.history.shift();
    return {choices, vector: {pan: this.pan, tilt: this.tilt, zoom: 0}};
  }
}
