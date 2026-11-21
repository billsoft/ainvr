import { z } from 'zod';
type ScenePoint = [number, number];

const width = 512, height = 384, stride = 4;
const unit = z.number().finite().min(0).max(1);
const frame = z.object({
  schema: z.literal('ainvr.scene-match.v2'),
  backend: z.literal('neuflow-bpu'),
  matched: z.literal(true),
  homography: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(),
    z.number(), z.number(), z.number(), z.number()]).refine(h => h.every(Number.isFinite)),
  supportBounds: z.tuple([unit, unit, unit, unit]),
  supportGrid: z.object({ columns: z.literal(8), rows: z.literal(6), cells: z.array(z.boolean()).length(48) }),
  localEvidence: z.string().length(width * height / stride ** 2).regex(/^[usad12346789]+$/),
  candidateCount: z.number().int().min(40).max(width * height),
  inliers: z.number().int().min(40).max(width * height),
  coverage: unit.min(0.5),
  reprojectionErrorPx: z.number().finite().min(0).max(stride / 4),
});
type Frame = z.infer<typeof frame>;
type Geometry = { width: number; height: number };

// Bound the fitted warp throughout the frame, including interior projective bulge.
// Bilinear corner weights times the positive homogeneous denominator reproduce H.
// After subtracting identity, the two remaining terms are g*x*(1-x)/w and
// k*y*(1-y)/w. Each quadratic is at most 1/4 on the unit interval.
function sameGeometry(h: Frame['homography'], size: Geometry) {
  const [a, b, c, d, e, f, g, k, i] = h;
  if (Math.abs(i - 1) > 1e-6) return false;
  const minW = Math.min(i, i + g, i + k, i + g + k);
  if (minW <= 0) return false;
  let cornerError = 0;
  for (const x of [0, 1]) for (const y of [0, 1]) {
    const w = g * x + k * y + i;
    const dx = size.width * ((a * x + b * y + c) / w - x);
    const dy = size.height * ((d * x + e * y + f) / w - y);
    cornerError = Math.max(cornerError, Math.hypot(dx, dy));
  }
  return cornerError + Math.hypot(size.width * g, size.height * k) / (4 * minW) <= stride / 2;
}

function unique(site: string) {
  return site === 's' || (site >= '1' && site <= '9' && site !== '5');
}

// Twelve frame sectors, each split into four tiles. One textured object cannot
// establish the view. Allow a third of the sectors to be occluded.
function distributed(m: Frame) {
  const [left, top, right, bottom] = m.supportBounds;
  if (right - left < 0.5 || bottom - top < 0.5 ||
      m.inliers > m.candidateCount || m.inliers < 0.8 * m.candidateCount) return false;
  const tiles = new Uint8Array(12);
  for (let row = 0; row < 96; row++) for (let col = 0; col < 128; col++) {
    if (!m.supportGrid.cells[(row >> 4) * 8 + (col >> 4)] ||
        !unique(m.localEvidence[row * 128 + col]!)) continue;
    const sector = (row >> 5) * 4 + (col >> 5);
    const tile = ((row >> 4) & 1) * 2 + ((col >> 4) & 1);
    tiles[sector]! |= 1 << tile;
  }
  let covered = 0, columns = 0;
  for (let i = 0; i < tiles.length; i++) {
    // At least three distinct 64x64 native-pixel tiles per sector.
    if (![7, 11, 13, 14, 15].includes(tiles[i]!)) continue;
    covered++;
    columns |= 1 << (i % 4);
  }
  return covered >= 8 && columns === 15;
}

function cross(a: ScenePoint, b: ScenePoint, c: ScenePoint) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function validPolygon(p: ScenePoint[]) {
  if (!Array.isArray(p) || p.length < 3 || p.length > 32 ||
      !p.every(v => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0 && n <= 1))) return false;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!;
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 2; j < p.length; j++) {
      if (i === 0 && j === p.length - 1) continue;
      const c = p[j]!, d = p[(j + 1) % p.length]!;
      if ([0, 1].some(axis => Math.max(a[axis]!, b[axis]!) < Math.min(c[axis]!, d[axis]!) ||
          Math.max(c[axis]!, d[axis]!) < Math.min(a[axis]!, b[axis]!))) continue;
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return false;
    }
  }
  return true;
}

// Closed segment versus the actual square descriptor footprint (9x9 plus
// 3x3 median). A circumscribed disk would discard valid narrow shelf regions.
function touchesPatch(ax: number, ay: number, dx: number, dy: number, x: number, y: number) {
  let enter = 0, leave = 1;
  for (const [offset, delta] of [[ax - x, dx], [ay - y, dy]]) {
    if (delta === 0) {
      if (Math.abs(offset!) > 5) return false;
    } else {
      const t0 = (-5 - offset!) / delta!, t1 = (5 - offset!) / delta!;
      enter = Math.max(enter, Math.min(t0, t1));
      leave = Math.min(leave, Math.max(t0, t1));
      if (enter > leave) return false;
    }
  }
  return true;
}
function interior(x: number, y: number, polygon: ScenePoint[]) {
  let inside = false;
  for (let n = 0; n < polygon.length; n++) {
    const [ax, ay] = polygon[n]!, [bx, by] = polygon[(n + 1) % polygon.length]!;
    const dx = bx - ax, dy = by - ay;
    if (touchesPatch(ax, ay, dx, dy, x, y)) return false;
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside;
  }
  return inside;
}

function visible(m: Frame, points: ScenePoint[], source: Geometry) {
  const p: ScenePoint[] = points.map(([x, y]) => [x * width, y * height]);
  const xs = p.map(v => v[0]), ys = p.map(v => v[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const [a, b, c, d, e, f, g, k, i] = m.homography;
  let total = 0, compatible = 0, anchors = 0, disagree = 0, quadrants = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let row = Math.max(0, Math.ceil((top - 2) / stride)); row < 96 && row * stride + 2 < bottom; row++) {
    for (let col = Math.max(0, Math.ceil((left - 2) / stride)); col < 128 && col * stride + 2 < right; col++) {
      const x = stride * col + 2, y = stride * row + 2;
      if (!interior(x, y, p)) continue;
      total++;
      const site = m.localEvidence[row * 128 + col]!;
      if (site === 'd') disagree++;
      if (site === 'a') compatible++; // Can corroborate visibility, never identity.
      if (!unique(site)) continue;
      const slot = site === 's' ? 4 : Number(site) - 1;
      const u = x / width, v = y / height, w = g * u + k * v + i;
      const tx = Math.round(width * (a * u + b * v + c) / w) + slot % 3 - 1;
      const ty = Math.round(height * (d * u + e * v + f) / w) + Math.floor(slot / 3) - 1;
      if (Math.hypot((tx - x) * source.width / width, (ty - y) * source.height / height) > 2 ||
          Math.hypot(tx - x, ty - y) > stride / 2) {
        disagree++;
        continue;
      }
      if (!interior(tx, ty, p)) continue;
      compatible++;
      anchors++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const quadrant = Number(x > (left + right) / 2) + 2 * Number(y > (top + bottom) / 2);
      quadrants |= 1 << quadrant;
    }
  }
  // A visible majority and spread of distinct interior evidence are required
  // even when the rest of the image is a perfect copy of the reference.
  return compatible > total / 2 && anchors >= 3 && anchors >= 4 * disagree &&
    [7, 11, 13, 14, 15].includes(quadrants) &&
    maxX - minX >= Math.max(stride, (right - left - 10) / 3) &&
    maxY - minY >= Math.max(stride, (bottom - top - 10) / 3);
}

// Single-frame visual gate. The caller proves preset identity, geometry,
// measured stationary pose, frame freshness and two independent acquisitions.
export function projectPresetView(raw: unknown, referencePoints: ScenePoint[],
    geometry?: Geometry): ScenePoint[] | null {
  if (!validPolygon(referencePoints)) return null;
  if (geometry !== undefined && (!geometry || ![geometry.width, geometry.height].every(n =>
    Number.isInteger(n) && n > 0 && n <= 4096) || geometry.width * geometry.height > 8 * 1024 * 1024)) return null;
  // Without dimensions, use the largest supported value on each axis.
  const source = geometry ?? { width: 4096, height: 4096 };
  const parsed = frame.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (!sameGeometry(m.homography, { width, height }) || !sameGeometry(m.homography, source) ||
      !distributed(m) || !visible(m, referencePoints, source)) return null;
  return referencePoints.map(([x, y]) => [x, y]);
}
