// Copyright AINVR. Normalized source-image geometry; no tracking or inference.
import {unwrapErp} from './erp-geometry.mjs';
const EPS = 1e-10;
export function cross(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}
export function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) < EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}
export function intersects(a, b, c, d) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function inside(points, p) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if (onSegment(a, b, p)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
      p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
export function distanceSegment(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Distance to the zone boundary in source pixels (the approach range is set in pixels).
export function boundaryDistancePx(points, p, width, height) {
  const scale = ([x, y]) => [x * width, y * height];
  return boundaryDistance(points.map(scale), scale(p));
}
export function boundaryDistance(points, p) {
  return Math.min(...points.map((a, i) => distanceSegment(a, points[(i + 1) % points.length], p)));
}
export function boxIntersects(points, box) {
  const [x, y, w, h] = box;
  const corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  return corners.some(p => inside(points, p)) || points.some(p => p[0]>=x && p[0]<=x+w && p[1]>=y && p[1]<=y+h) ||
    corners.some((a,i) => points.some((c,j) => intersects(a,corners[(i+1)%4],c,points[(j+1)%points.length])));
}
export function validatePoints(points, line = false, erpWrap = false) {
  if (!Array.isArray(points) || (line ? points.length !== 2 : points.length < 3 || points.length > 32)) throw new Error('Invalid geometry vertex count');
  for (const p of points) if (!Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('Coordinates must be normalized');
  if(erpWrap)points=unwrapErp(points);
  if (line) {
    if (Math.hypot(points[1][0]-points[0][0],points[1][1]-points[0][1]) < EPS) throw new Error('Zero length line');
    return;
  }
  let area = 0;
  for (let i=0;i<points.length;i++) {
    const a=points[i], b=points[(i+1)%points.length];
    if (Math.hypot(a[0]-b[0],a[1]-b[1]) < EPS) throw new Error('Repeated vertex');
    area += a[0]*b[1]-b[0]*a[1];
    for (let j=i+1;j<points.length;j++) {
      if (j===i+1 || (i===0 && j===points.length-1)) continue;
      if (intersects(a,b,points[j],points[(j+1)%points.length])) throw new Error('Self intersecting polygon');
    }
  }
  if (Math.abs(area)<EPS) throw new Error('Zero area polygon');
}

// Distance between polygon and rectangle in normalized source coordinates.
export function boxRegionDistance(points,box){
  if(boxIntersects(points,box))return 0;
  const [x,y,w,h]=box,corners=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  return Math.min(...corners.map(p=>boundaryDistance(points,p)),...points.map(p=>boundaryDistance(corners,p)));
}

// Versioned pixel tolerance. Rules without it retain legacy normalized semantics.
export function boundaryStable(rule,frame,point){
 return rule.hysteresis_px===undefined
  ? boundaryDistance(rule.points,point)>=rule.hysteresis
  : boundaryDistancePx(rule.points,point,frame.source.width,frame.source.height)>=rule.hysteresis_px;
}
