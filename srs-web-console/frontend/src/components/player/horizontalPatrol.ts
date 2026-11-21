import { matchLandmark } from './patrolLandmark';

export const minPatrolSpeed = .10;
export const maxPatrolSpeed = 1;
export const teachingSpeedLimit = .35;

export function validPatrolSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minPatrolSpeed && value <= maxPatrolSpeed;
}

// At high speeds allow distance for a feedback sample, a command and mechanical braking.
export function approachSpeed(requested: number, remainingPan: number) {
  return Math.min(requested, Math.max(.20, remainingPan * 1.6));
}

export function preferredPatrolSpeed(identity?: string) {
  if (!identity) return .20;
  try {
    const value = Number(localStorage.getItem('ainvr:patrol-speed:' + identity));
    if (validPatrolSpeed(value)) return value;
  } catch { /* Use the existing route preference when storage is unavailable. */ }
  return readRoute(identity)?.speed ?? .20;
}

export function rememberPatrolSpeed(identity: string, speed: number) {
  if (!validPatrolSpeed(speed)) return;
  try { localStorage.setItem('ainvr:patrol-speed:' + identity, String(speed)); }
  catch { /* The selected speed still applies to this session. */ }
}

export interface Position { pan:number; tilt:number; zoom:number; wrap:boolean }
export type Route =
  | { kind:'position'; circle:boolean; left:number; right:number; wrap:boolean; speed:number; seconds:number }
  | { kind:'visual'; circle:boolean; left:string; right:string; via:string; speed:number; seconds:number };

export function panDelta(from:number, to:number, wrap:boolean) {
  const d = to - from;
  return wrap && Math.abs(d) > 1 ? d - Math.sign(d)*2 : d;
}

/** A rightward seam crossing is learned from adjacent samples at opposite ends
 * of normalized absolute pan. A device capability flag alone cannot prove it. */
export function isRightSeam(previous:number, next:number) {
  return previous > .85 && next < -.85 && panDelta(previous,next,true) > 0 &&
    panDelta(previous,next,true) < .12;
}

export function readRoute(identity?:string): Route | null {
  if (!identity) return null;
  try {
    const r = JSON.parse(localStorage.getItem('ainvr:horizontal-route:v1:'+identity) ?? 'null');
    if (!r || typeof r.circle !== 'boolean' || !validPatrolSpeed(r.speed) ||
        !Number.isFinite(r.seconds) || r.seconds < 2 || r.seconds > 180) return null;
    if (r.kind === 'position' && typeof r.wrap === 'boolean' && [r.left,r.right].every(v => Number.isFinite(v) && Math.abs(v)<=1) &&
        (r.circle ? r.wrap && Math.abs(panDelta(r.left,r.right,true))<=.035 : span(r.left,r.right,r.wrap)>=.06)) return r;
    if (r.kind === 'visual' && [r.left,r.right,r.via].every(v => typeof v === 'string' && v.length < 100000) &&
        matchLandmark(r.left,r.left) && matchLandmark(r.right,r.right) &&
        (r.circle ? matchLandmark(r.left,r.right) && matchLandmark(r.via,r.via) : !matchLandmark(r.left,r.right))) return r;
  } catch { /* Unusable or expired references require a new range. */ }
  return null;
}
export function storeRoute(identity:string, route:Route) {
  localStorage.setItem('ainvr:horizontal-route:v1:'+identity, JSON.stringify(route));
}

export function span(left:number,right:number,wrap:boolean) {
  const d = right-left;
  return wrap && d<0 ? d+2 : d;
}
export const tolerance = .012;
export function steerAxis(error:number,speed:number) {
  return Math.abs(error)<=tolerance ? 0 : Math.sign(error)*Math.min(speed, Math.max(.08,Math.abs(error)*2));
}
