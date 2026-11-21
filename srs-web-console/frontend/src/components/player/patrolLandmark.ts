/** Appearance corroboration only, NEVER proof of a mechanical endpoint or motion.
 * The caller must establish departure, plausible commanded travel, then multiple
 * fresh return observations. Repeated scenery / decoder-repeated pictures remain
 * ambiguous: require operator confirmation, never extend travel on this result.
 * No JPEG, source pixels, canvas or video reference is persisted in a signature.
 */
const W = 64, H = 48, COLS = 16, ROWS = 12;
const busy = new WeakSet<HTMLVideoElement>();
const previous = new WeakMap<HTMLVideoElement, { source: string; object: unknown; time: number; frames: number }>();
const fail = (reason: string) => new Error(`patrol_landmark:${reason}`);

/** Safe UI text; never expose URLs, browser internals or arbitrary exception text. */
export function landmarkErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message.replace(/^patrol_landmark:/, '') : '';
  switch (code) {
    case 'no_new_frame': return '等待新视频帧超时或帧未推进，请检查实时视频是否卡顿';
    case 'invalid_frame_metadata': return '视频帧时间信息异常，无法确认新帧，请重新打开预览';
    case 'freshness_unsupported': return '当前浏览器不支持新视频帧核验，请使用支持该功能的浏览器';
    case 'freshness_unavailable': return '无法读取新视频帧，请重新打开预览';
    case 'weak_texture': return '画面可辨细节不足或过于集中，请让书架、桌面等固定景物分布在更大范围';
    case 'repetitive_texture': return '画面重复纹理过多，无法可靠区分位置，请更换参照景物';
    case 'exposure': return '画面过亮、过暗或曝光饱和，请调整曝光或更换参照方向';
    case 'video_unavailable': return '实时视频尚未就绪、已暂停或正在跳转，请等待画面恢复';
    case 'video_changed': return '采样期间视频来源或播放状态改变，请重新采样';
    case 'busy': return '上一帧参考采样尚未结束，请稍后重试';
    case 'canvas_unavailable': return '浏览器无法创建参考画面采样画布';
  }
  if ((error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)) &&
      error.name === 'SecurityError') return '浏览器禁止读取视频画面，请检查预览跨域权限';
  return '参考画面采样失败，请检查实时预览后重试';
}

/** @internal Non-image quality telemetry, also used by real-frame regressions.
 * These aggregates cannot reconstruct a frame; do not retain original pixels.
 */
export interface LandmarkQuality {
  mean: number; deviation: number; clippedRatio: number;
  detail: number[]; texturedCells: number[]; information: number[]; patterns: number;
}
/** @internal Shared quality gate for decoded pixels and aggregate-only fixtures. */
export function landmarkQualityError(q: LandmarkQuality): 'exposure' | 'weak_texture' | 'repetitive_texture' | null {
  if (![q.mean, q.deviation, q.clippedRatio, q.patterns].every(Number.isFinite) ||
      [q.detail, q.texturedCells, q.information].some(a => a.length !== 4 || a.some(n => !Number.isFinite(n) || n < 0)))
    return 'weak_texture';
  if (q.clippedRatio > .2 || q.mean < 25 || q.mean > 225) return 'exposure';
  // A whiteboard may occupy a whole quadrant. Require distributed detail in
  // THREE quadrants, plus total support, rather than vetoing the weakest one.
  // Curvature (not just gradient/contrast) still rejects plain walls; requiring
  // 40/140 interior cells avoids qualifying a small object on a blank surface.
  if (q.deviation < 18 || q.detail.reduce((a, b) => a + b, 0) / 4 < 5 ||
      q.detail.filter((v, i) => v >= 3 && q.texturedCells[i]! >= 6).length < 3 ||
      q.texturedCells.reduce((a, b) => a + b, 0) < 40 || !distributedInformation(q.information)) return 'weak_texture';
  return q.patterns < 48 ? 'repetitive_texture' : null;
}
function distributedInformation(information: number[]) {
  return information.filter(n => n >= 180).length >= 3 && information.reduce((a, b) => a + b, 0) >= 800;
}

export async function captureLandmark(video: HTMLVideoElement): Promise<string> {
  if (busy.has(video)) throw fail('busy');
  if (!video.requestVideoFrameCallback || !video.cancelVideoFrameCallback) throw fail('freshness_unsupported');
  const source = video.currentSrc, object = video.srcObject;
  const width = video.videoWidth, height = video.videoHeight;
  const ready = () => !video.paused && !video.ended && !video.seeking && video.readyState >= 2 &&
    width >= W && height >= H && video.videoWidth === width && video.videoHeight === height &&
    video.currentSrc === source && video.srcObject === object;
  if (!ready()) throw fail('video_unavailable');
  busy.add(video);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const frame = await new Promise<{time: number; frames: number}>((resolve, reject) => {
      let handle = 0;
      let settled = false;
      let first: {time: number; frames: number} | undefined;
      const done = (error?: Error, value?: {time: number; frames: number}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); video.cancelVideoFrameCallback(handle);
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => done(fail('no_new_frame')), 1500);
      const request = () => {
        try { handle = video.requestVideoFrameCallback(next); }
        catch { done(fail('freshness_unavailable')); }
      };
      const next: VideoFrameRequestCallback = (_now, metadata) => {
        if (settled) return;
        if (!ready()) return done(fail('video_changed'));
        const value = {time: metadata.mediaTime, frames: metadata.presentedFrames};
        if (!Number.isFinite(value.time) || value.time < 0 || !Number.isSafeInteger(value.frames) || value.frames < 1)
          return done(fail('invalid_frame_metadata'));
        if (!first) {
          first = value;
          request();
          return;
        }
        const last = previous.get(video);
        if (value.time <= first.time || value.frames <= first.frames ||
            (last?.source === source && last.object === object &&
              (value.time <= last.time || value.frames <= last.frames))) return done(fail('no_new_frame'));
        done(undefined, value);
      };
      request();
    });
    // Consume even a rejected low-quality frame; retry cannot reuse its metadata.
    previous.set(video, { source, object, ...frame });
    if (!ready()) throw fail('video_changed');
    canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw fail('canvas_unavailable');
    context.drawImage(video, 0, 0, W, H);
    const pixels = context.getImageData(0, 0, W, H).data;
    try { return describe(pixels, width / height); }
    finally { pixels.fill(0); }
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    busy.delete(video);
  }
}

function describe(pixels: Uint8ClampedArray, aspect: number): string {
  const cells = new Float64Array(COLS * ROWS * 3);
  let sum = 0, square = 0, clipped = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const luma = .299 * pixels[p]! + .587 * pixels[p + 1]! + .114 * pixels[p + 2]!;
    sum += luma; square += luma * luma;
    if (luma >= 245 || luma <= 10) clipped++;
    const cell = (Math.floor(y / 4) * COLS + Math.floor(x / 4)) * 3;
    for (let c = 0; c < 3; c++) cells[cell + c]! += pixels[p + c]! / 16;
  }
  const mean = sum / (W * H), deviation = Math.sqrt(Math.max(0, square / (W * H) - mean * mean));
  if (clipped / (W * H) > .2 || mean < 25 || mean > 225) throw fail('exposure');
  if (deviation < 18) throw fail('weak_texture');
  const detail = [0, 0, 0, 0], count = [0, 0, 0, 0], texturedCells = [0, 0, 0, 0];
  for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) {
    const q = (y >= ROWS / 2 ? 2 : 0) + (x >= COLS / 2 ? 1 : 0);
    const lum = (xx: number, yy: number) => {
      const i = (yy * COLS + xx) * 3;
      return .299 * cells[i]! + .587 * cells[i + 1]! + .114 * cells[i + 2]!;
    };
    const curvature = Math.abs(lum(x, y) - (lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1)) / 4);
    detail[q]! += curvature;
    if (curvature >= 5) texturedCells[q]!++;
    count[q]!++;
  }
  // Ternary spatial comparisons discard absolute intensities. Distributed
  // support is checked below; a single textured object cannot qualify a wall.
  let descriptor = '';
  const information = [0, 0, 0, 0];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const quadrant = (y >= ROWS / 2 ? 2 : 0) + (x >= COLS / 2 ? 1 : 0);
    for (const [dx, dy] of [[1, 0], [0, 1], [3, 2], [5, 3]]) {
      const peer = (((y + dy!) % ROWS) * COLS + (x + dx!) % COLS) * 3;
      for (let c = 0; c < 3; c++) {
        const delta = (cells[(y * COLS + x) * 3 + c]! - cells[peer + c]!) / deviation;
        const value = delta > .2 ? 2 : delta < -.2 ? 0 : 1;
        descriptor += String(value);
        if (value !== 1) information[quadrant]!++;
      }
    }
  }
  const patterns = new Set<string>();
  for (let i = 0; i < descriptor.length; i += 12) patterns.add(descriptor.slice(i, i + 12));
  const qualityError = landmarkQualityError({mean, deviation,
    clippedRatio: clipped / (W * H), detail: detail.map((n, i) => n / count[i]!),
    texturedCells, information, patterns: patterns.size});
  if (qualityError) throw fail(qualityError);
  // Four ternary symbols per byte, 576 bytes total; no thumbnail/photo encoding.
  let packed = '';
  for (let i = 0; i < descriptor.length; i += 4) {
    let byte = 0;
    for (let j = 0; j < 4; j++) byte = byte * 3 + Number(descriptor[i + j]);
    packed += String.fromCharCode(byte);
  }
  return `pl1:${Math.round(aspect * 1000)}:${btoa(packed)}`;
}

function parse(signature: string): {aspect: number; values: number[]} | undefined {
  if (typeof signature !== 'string' || signature.length > 800) return;
  const match = /^pl1:([1-9][0-9]{1,4}):([A-Za-z0-9+/]{768})$/.exec(signature);
  if (!match) return;
  const aspect = Number(match[1]);
  if (aspect < 100 || aspect > 10000) return;
  const packed = atob(match[2]!);
  const values: number[] = [];
  for (const char of packed) {
    let value = char.charCodeAt(0);
    if (value > 80) return;
    const digits = [0, 0, 0, 0];
    for (let i = 3; i >= 0; i--) { digits[i] = value % 3; value = Math.floor(value / 3); }
    values.push(...digits);
  }
  const information = [0, 0, 0, 0];
  values.forEach((value, i) => { if (value !== 1) information[quadrant(i)]!++; });
  if (!distributedInformation(information)) return;
  const patterns = new Set<string>();
  for (let i = 0; i < values.length; i += 12) patterns.add(values.slice(i, i + 12).join(''));
  if (patterns.size < 48) return;
  return {aspect, values};
}
function quadrant(i: number): number {
  const cell = Math.floor(i / 12);
  return (Math.floor(cell / COLS) >= ROWS / 2 ? 2 : 0) + (cell % COLS >= COLS / 2 ? 1 : 0);
}

/** False means unavailable or different. True is only an appearance candidate.
 * Signature syntax is validated, not authenticated; never accept untrusted
 * signatures as authorization. Identical repeating scenes cannot be separated.
 */
export function matchLandmark(a: string, b: string): boolean {
  const left = parse(a), right = parse(b);
  if (!left || !right || Math.abs(left.aspect - right.aspect) > 5) return false;
  const differences = [0, 0, 0, 0];
  left.values.forEach((value, i) => { if (value !== right.values[i]) differences[quadrant(i)]!++; });
  return differences.every(n => n / 576 <= .1) && differences.reduce((a, b) => a + b, 0) / 2304 <= .06;
}

/** Brake candidate, NOT endpoint proof. Compatible with existing pl1 signatures.
 * Search one coherent translation (at most 12.5% width / 8.3% height), not
 * independent regional best matches. Wrapped descriptor edges are excluded.
 * Every quadrant in BOTH images must agree, preventing a matching small object
 * or three matching quadrants from outweighing different surroundings.
 * Ternary neutral/strong disagreements cost 0.35; opposite contrasts cost 1.
 * Require weighted cost <=0.28 globally, <=0.32 in every quadrant, and >=45%
 * identical non-neutral contrasts per quadrant (at least 120 comparisons each).
 * Exception: at most ONE common quadrant may be weak on both sides. Its exact
 * disagreements must be <=10%, cost <=5%, opposite contrasts <=2%, strong
 * density drift <=8%, and >=75% of its stronger side's contrasts must agree.
 * The other three quadrants in both images retain the original strong gate.
 * These conservative synthetic-test thresholds are not a field accuracy claim.
 * Use only after verified departure and plausible travel, brake on a candidate,
 * then require multiple fresh stopped observations. Never replace strict
 * matchLandmark for reference discrimination or treat stillness as arrival.
 */
export function nearLandmark(a: string, b: string): boolean {
  // Near must include strict matches. A valid whiteboard quadrant may have
  // <45% non-neutral comparisons even with itself; the shifted-search support
  // threshold must not veto strict, full-frame AND per-quadrant agreement.
  if (matchLandmark(a, b)) return true;
  const left = parse(a), right = parse(b);
  if (!left || !right || Math.abs(left.aspect - right.aspect) > 5) return false;
  const offsets = [[1, 0], [0, 1], [3, 2], [5, 3]] as const;
  // Bounds keep >=80% of anchor positions overlapping. No rescaling, mirroring,
  // free rotation, foreground masks, model inference or source-photo storage.
  for (let sy = -1; sy <= 1; sy++) for (let sx = -2; sx <= 2; sx++) {
    const costs = Array<number>(8).fill(0), totals = Array<number>(8).fill(0);
    const agreements = Array<number>(8).fill(0);
    const leftStrong = Array<number>(8).fill(0), rightStrong = Array<number>(8).fill(0);
    const differences = Array<number>(8).fill(0), opposites = Array<number>(8).fill(0);
    let totalCost = 0, total = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const xx = x + sx, yy = y + sy;
      if (xx < 0 || xx >= COLS || yy < 0 || yy >= ROWS) continue;
      const i = (y * COLS + x) * 12, j = (yy * COLS + xx) * 12;
      const regions = [quadrant(i), 4 + quadrant(j)];
      for (let k = 0; k < offsets.length; k++) {
        const [dx, dy] = offsets[k]!;
        // A wrapped comparison describes unrelated opposite borders after a
        // camera translation; counting it would invent a false disagreement.
        if (x + dx >= COLS || xx + dx >= COLS || y + dy >= ROWS || yy + dy >= ROWS) continue;
        for (let c = 0; c < 3; c++) {
          const l = left.values[i + k * 3 + c]!, r = right.values[j + k * 3 + c]!;
          const cost = l === r ? 0 : l === 1 || r === 1 ? .35 : 1;
          const agreed = l === r && l !== 1 ? 1 : 0;
          totalCost += cost; total++;
          for (const region of regions) {
            costs[region]! += cost; totals[region]!++; agreements[region]! += agreed;
            leftStrong[region]! += l !== 1 ? 1 : 0;
            rightStrong[region]! += r !== 1 ? 1 : 0;
            differences[region]! += l !== r ? 1 : 0;
            opposites[region]! += l !== 1 && r !== 1 && l !== r ? 1 : 0;
          }
        }
      }
    }
    if (!total || totalCost / total > .28) continue;
    const strong = totals.map((n, q) => n >= 120 && costs[q]! / n <= .32 && agreements[q]! / n >= .45);
    if (strong.every(Boolean)) return true;
    const weak = (q: number) => {
      const n = totals[q]!;
      return n >= 120 && leftStrong[q]! / n < .45 && rightStrong[q]! / n < .45 &&
        differences[q]! / n <= .10 && costs[q]! / n <= .05 && opposites[q]! / n <= .02 &&
        Math.abs(leftStrong[q]! - rightStrong[q]!) / n <= .08 &&
        agreements[q]! >= .75 * Math.max(leftStrong[q]!, rightStrong[q]!);
    };
    for (let q = 0; q < 4; q++) {
      // Match the SAME spatial quadrant in both image partitions. No skipping
      // a different weak patch per image or independently aligning quadrants.
      if (weak(q) && weak(q + 4) && strong.every((ok, i) => i % 4 === q || ok)) return true;
    }
  }
  return false;
}
