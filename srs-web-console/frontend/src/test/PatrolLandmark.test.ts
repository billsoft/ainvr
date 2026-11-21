import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureLandmark, matchLandmark, nearLandmark, landmarkErrorMessage, landmarkQualityError } from '@/components/player/patrolLandmark';

let pixels: Uint8ClampedArray;
let lastRead: Uint8ClampedArray;
let draw: ReturnType<typeof vi.fn>;
function scene(seed = 1): Uint8ClampedArray {
  const cells: number[] = [];
  for (let i = 0; i < 16 * 12 * 3; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    cells.push(45 + seed % 165);
  }
  const data = new Uint8ClampedArray(64 * 48 * 4);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const cell = (Math.floor(y / 4) * 16 + Math.floor(x / 4)) * 3;
    for (let c = 0; c < 3; c++) data[(y * 64 + x) * 4 + c] = cells[cell + c]!;
    data[(y * 64 + x) * 4 + 3] = 255;
  }
  return data;
}
function fixture() {
  const video = document.createElement('video');
  Object.defineProperties(video, {
    paused: {value:false, configurable:true}, readyState:{value:4},
    videoWidth:{value:640}, videoHeight:{value:480}, currentSrc:{value:'blob:test', configurable:true},
  });
  let id = 0;
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  video.requestVideoFrameCallback = vi.fn(callback => { callbacks.set(++id, callback); return id; });
  video.cancelVideoFrameCallback = vi.fn(handle => { callbacks.delete(handle); });
  const emit = (time: number, frames: number) => {
    const pending = [...callbacks.values()]; callbacks.clear();
    pending.forEach(callback => callback(0, {mediaTime:time, presentedFrames:frames} as VideoFrameCallbackMetadata));
  };
  const capture = async (time = 1, frames = 1) => {
    const promise = captureLandmark(video);
    emit(time, frames); emit(time + .04, frames + 1);
    return promise;
  };
  return {video, emit, capture, callbacks};
}
beforeEach(() => {
  vi.useFakeTimers(); pixels = scene(); draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage:draw,
    getImageData:() => { lastRead = pixels.slice(); return {data:lastRead}; },
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('returns a bounded feature signature, clears source pixels and matches mild lighting changes', async () => {
  const f = fixture(); const a = await f.capture();
  expect(a.startsWith('pl1:')).toBe(true); expect(a.length).toBeLessThan(800);
  expect(a).not.toContain('data:image'); expect(lastRead.every(n => n === 0)).toBe(true);
  expect(draw).toHaveBeenCalledWith(f.video, 0, 0, 64, 48);
  pixels = pixels.map((value, index) => index % 4 === 3 ? value : value + 8);
  const b = await f.capture(2, 3); expect(matchLandmark(a, b)).toBe(true);
});
it('rejects different scenes and a changed quadrant despite identical remaining scenery', async () => {
  const f = fixture(); const a = await f.capture();
  const different = scene(42); pixels = different;
  expect(matchLandmark(a, await f.capture(2, 3))).toBe(false);
  pixels = scene();
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++)
    for (let c = 0; c < 3; c++) pixels[(y * 64 + x) * 4 + c] = different[(y * 64 + x) * 4 + c]!;
  expect(matchLandmark(a, await f.capture(3, 5))).toBe(false);
});
it('does not interpret identical fresh pictures as proof of an endpoint', async () => {
  const f = fixture(); const a = await f.capture(); const b = await f.capture(2, 3);
  // Only appearance is reported. The caller MUST establish departure/travel;
  // a stationary camera (or repeated decoded pictures) also matches here.
  expect(matchLandmark(a, b)).toBe(true);
});
it.each([0, 128, 255])('rejects blank/under/overexposed pixels %i', async value => {
  pixels.fill(value); await expect(fixture().capture()).rejects.toThrow(/exposure|weak_texture/);
});
it('rejects smooth gradients and repetitive high-contrast patterns', async () => {
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
    for (let c = 0; c < 3; c++) pixels[(y * 64 + x) * 4 + c] = 40 + x * 2;
  await expect(fixture().capture()).rejects.toThrow('weak_texture');
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
    for (let c = 0; c < 3; c++) pixels[(y * 64 + x) * 4 + c] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 60 : 190;
  await expect(fixture().capture()).rejects.toThrow('repetitive_texture');
});
it('rejects stale callbacks, including reuse across captures', async () => {
  const f = fixture(); const promise = captureLandmark(f.video);
  f.emit(1, 1); f.emit(1, 2); await expect(promise).rejects.toThrow('no_new_frame');
  await f.capture(2, 3);
  await expect(f.capture(1, 1)).rejects.toThrow('no_new_frame');
});
it('bounds waits, cancels callbacks and releases the reentry guard after timeout', async () => {
  const f = fixture(); const promise = captureLandmark(f.video);
  const rejected = expect(promise).rejects.toThrow('no_new_frame');
  await expect(captureLandmark(f.video)).rejects.toThrow('busy');
  await vi.advanceTimersByTimeAsync(1500); await rejected;
  expect(f.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  await expect(f.capture()).resolves.toContain('pl1:');
});
it('rejects paused video, unsupported freshness and a source switch in flight', async () => {
  const paused = fixture(); Object.defineProperty(paused.video, 'paused', {value:true});
  await expect(captureLandmark(paused.video)).rejects.toThrow('video_unavailable');
  const unsupported = fixture(); Object.defineProperty(unsupported.video, 'requestVideoFrameCallback', {value:undefined});
  await expect(captureLandmark(unsupported.video)).rejects.toThrow('freshness_unsupported');
  const f = fixture(); const promise = captureLandmark(f.video); f.emit(1, 1);
  Object.defineProperty(f.video, 'currentSrc', {value:'blob:other'}); f.emit(2, 2);
  await expect(promise).rejects.toThrow('video_changed');
});
it('releases reentry protection after canvas security errors', async () => {
  const f = fixture(); draw.mockImplementationOnce(() => { throw new DOMException('tainted', 'SecurityError'); });
  await expect(f.capture()).rejects.toThrow('tainted');
  await expect(f.capture(2, 3)).resolves.toContain('pl1:');
});
it('rejects invalid frame metadata and cleans up a failing callback API', async () => {
  const f = fixture(); const promise = captureLandmark(f.video);
  f.emit(NaN, 1); await expect(promise).rejects.toThrow('invalid_frame_metadata');
  vi.mocked(f.video.requestVideoFrameCallback).mockImplementationOnce(() => { throw new Error('closed'); });
  await expect(captureLandmark(f.video)).rejects.toThrow('freshness_unavailable');
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.capture()).resolves.toContain('pl1:');
});
it('fails closed on malformed, oversized, low-information and incompatible signatures', async () => {
  const a = await fixture().capture();
  for (const bad of ['', 'pl2:1333:abc', 'x'.repeat(10000), 'pl1:1333:' + btoa('('.repeat(576)), 'pl1:1333:' + 'A'.repeat(768), a.slice(0, -1), a.replace('1333', '1778')])
    expect(matchLandmark(a, bad)).toBe(false);
  expect(matchLandmark('pl1:1333:' + 'A'.repeat(768), 'pl1:1333:' + 'A'.repeat(768))).toBe(false);
});

// Synthetic decoded-thumbnail oracles only. Borders come from another scene,
// not wraparound: a PTZ view shift brings previously unseen pixels into view.
function shifted(source: Uint8ClampedArray, dx: number, dy: number, light = 0) {
  const output = scene(991);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const xx = x - dx, yy = y - dy;
    if (xx < 0 || xx >= 64 || yy < 0 || yy >= 48) continue;
    for (let c = 0; c < 3; c++) output[(y * 64 + x) * 4 + c] = source[(yy * 64 + xx) * 4 + c]! + light;
  }
  return output;
}
async function signature(data: Uint8ClampedArray) {
  pixels = data; return fixture().capture();
}
it.each([[4, 0], [-4, 0], [8, 0], [-8, 0], [0, 4], [0, -4], [8, 4], [-8, -4]])(
  'near accepts a coherent shift (%i,%i) with new borders and illumination change while strict rejects', async (dx, dy) => {
    const source = scene(71);
    const a = await signature(source), b = await signature(shifted(source, dx, dy, 7));
    expect(matchLandmark(a, b)).toBe(false);
    expect(nearLandmark(a, b)).toBe(true); expect(nearLandmark(b, a)).toBe(true);
  });
it.each([-6, -2, 2, 6])('near tolerates horizontal sub-cell displacement %i', async dx => {
  const source = scene(21), a = await signature(source), b = await signature(shifted(source, dx, 0));
  expect(matchLandmark(a, b)).toBe(false);
  expect(nearLandmark(a, b)).toBe(true); expect(nearLandmark(b, a)).toBe(true);
});
it.each([72, 105, 163])('near handles sub-cell movement on additional texture seed %i', async seed => {
  const source = scene(seed), a = await signature(source);
  for (const dx of [-6, -2, 2, 6]) {
    const b = await signature(shifted(source, dx, 0));
    expect(nearLandmark(a, b)).toBe(true); expect(nearLandmark(b, a)).toBe(true);
  }
});
it('near accepts the same view and modest contrast/brightness changes', async () => {
  const source = scene(33), a = await signature(source);
  const changed = source.map((v, i) => i % 4 === 3 ? v : v * .9 + 12);
  expect(nearLandmark(a, a)).toBe(true);
  expect(nearLandmark(a, await signature(changed))).toBe(true);
});
it.each([42, 93, 177, 825])('near rejects unrelated textured scene %i', async seed => {
  const a = await signature(scene(71)), b = await signature(scene(seed));
  expect(nearLandmark(a, b)).toBe(false); expect(nearLandmark(b, a)).toBe(false);
});
it.each([0, 1, 2, 3])('near rejects a replaced quadrant %i despite three exact matching quadrants', async quadrant => {
  const source = scene(71), replacement = scene(42), changed = source.slice();
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    if ((y >= 24 ? 2 : 0) + (x >= 32 ? 1 : 0) !== quadrant) continue;
    for (let c = 0; c < 3; c++) changed[(y * 64 + x) * 4 + c] = replacement[(y * 64 + x) * 4 + c]!;
  }
  const a = await signature(source), b = await signature(changed);
  expect(nearLandmark(a, b)).toBe(false); expect(nearLandmark(b, a)).toBe(false);
});
it('near rejects excessive displacement and contradictory local translations', async () => {
  const source = scene(71), a = await signature(source);
  expect(nearLandmark(a, await signature(shifted(source, 16, 0)))).toBe(false);
  const left = shifted(source, -8, 0), right = shifted(source, 8, 0);
  for (let y = 24; y < 48; y++) for (let x = 0; x < 64; x++)
    for (let c = 0; c < 3; c++) left[(y * 64 + x) * 4 + c] = right[(y * 64 + x) * 4 + c]!;
  expect(nearLandmark(a, await signature(left))).toBe(false);
});
it('near rejects invalid/low-information signatures and incompatible aspect ratios', async () => {
  const a = await signature(scene(71));
  for (const bad of ['', 'pl2:1333:abc', 'x'.repeat(10000), 'pl1:1333:' + 'A'.repeat(768),
    a.slice(0, -1), a.replace('1333', '1778')]) expect(nearLandmark(a, bad)).toBe(false);
});

// 190 local SRS GB preview, 2026-11-21. Three real decoded 64x48 frames;
// ONLY non-reconstructable aggregates retained, never photographs/pixel arrays.
const officeFrames = [
  {mean:145.32105078125153, deviation:42.80380140561107, clippedRatio:0,
    detail:[12.299188839285714,13.55504330357143,19.096452232142855,10.14316473214285],
    texturedCells:[26,25,30,19], information:[434,415,474,446], patterns:169},
  {mean:145.35482682291834, deviation:42.63651038550836, clippedRatio:0,
    detail:[12.302957589285711,13.486713392857139,19.059395535714295,10.096606696428568],
    texturedCells:[26,25,28,19], information:[433,417,471,445], patterns:171},
  {mean:145.25488085937675, deviation:42.55782772391356, clippedRatio:0,
    detail:[12.32570535714286,13.468435714285711,18.96160892857143,10.119244642857145],
    texturedCells:[26,25,28,19], information:[433,415,472,449], patterns:168},
];
it.each(officeFrames)('accepts real GB office quality aggregates %#', frame => {
  expect(landmarkQualityError(frame)).toBeNull();
});
it('does not veto distributed office detail when one quadrant becomes a whiteboard', () => {
  expect(landmarkQualityError({...officeFrames[0]!, detail:[12.3,13.5,19.1,1],
    texturedCells:[26,25,30,2], information:[434,415,474,100]})).toBeNull();
});
it('accepts a large blank whiteboard with distributed surrounding scene features', async () => {
  const source = scene(71);
  // 39% blank board, including an entirely blank top-left quadrant.
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++)
    for (let c = 0; c < 3; c++) source[(y * 64 + x) * 4 + c] = 210;
  const a = await signature(source);
  expect(matchLandmark(a, a)).toBe(true);
  expect(nearLandmark(a, a)).toBe(true);
});
it.each([[0,0],[24,16],[48,32]])('rejects one small textured object at (%i,%i), including across quadrant boundaries', async (left, top) => {
  const texture = scene(71), source = new Uint8ClampedArray(64 * 48 * 4).fill(190);
  for (let y = top; y < top + 16; y++) for (let x = left; x < left + 16; x++)
    for (let c = 0; c < 3; c++) source[(y * 64 + x) * 4 + c] = texture[(y * 64 + x) * 4 + c]!;
  await expect(signature(source)).rejects.toThrow('weak_texture');
});
it.each([
  ['no_new_frame','视频帧超时'], ['invalid_frame_metadata','时间信息异常'],
  ['weak_texture','细节不足'], ['repetitive_texture','重复纹理'], ['exposure','曝光'],
  ['freshness_unsupported','不支持'], ['video_changed','来源或播放状态改变'], ['busy','尚未结束'],
])('maps %s to a distinct Chinese diagnostic', (code, expected) => {
  expect(landmarkErrorMessage(new Error(`patrol_landmark:${code}`))).toContain(expected);
});
it('does not leak arbitrary exception text and identifies canvas security failure', () => {
  expect(landmarkErrorMessage(new Error('secret-url'))).not.toContain('secret-url');
  expect(landmarkErrorMessage(new DOMException('tainted', 'SecurityError'))).toContain('跨域');
  expect(landmarkErrorMessage(null)).toContain('采样失败');
});

// Actual stationary GB office, three frames sampled at 1 FPS on 190. These are
// irreversible comparison signatures, NOT pictures. Before the fix strict was
// true for all nine pairs but near was false for all nine (including self).
const stationaryOffice = [
  'pl1:1333:KUgbKUgbKUgANUgAKUgAKUgJREgNKCQNKCQNKSQJKSQJKUgaKUgRKUggKCQFBCQIJwEbJwE2JwAAJwAAJwAAJwAAJAAAJwAAJwAAJwEbKgQbJwAaJwAIJwQ2JwE2KgBHAkgAUFBLKUgJKU8AKUsAJSQATUgAKCQAJRsAAj8AKUgAREgBTUgBUFA4KFA3B0k+C0gAAj8AKhsATgAAAj8ASwAAQgAAJAAASwAAJwAATgAAJwAAJwAAAAAAJwAATgAbAAAAAAACAAAbUFBLAAAARCcJASQAASQAASgWKCg1KCg1KAQ1TghQTghHTgVHTgE4TCgZTyQMAwg2Twg/AAAAJUsJHEgJASQMAkw1KVBQKVBQKVBQKVBQKFBQT1BQT01QJwAZKSgMJwgnKCgnTygMKUsJHUsJJSgWAk81JlBQKVBQKVBQKVBQKVBQUFBQUElQUFA1ASgJSwhLJAQVUEYwTgAAAAAAREYxJSgoJlBQKVBQKVBQKVBQKVBQUFBQEDFQTyg1AR8aKUdPUEc0NCgMAScJJSgMKCgoKCgoKCgoKDFQKDFQKDVQKDVQKDVNKyxQTUMaAkw1KVBQTyxQKCQaAkIaKCgaKCg1KCg1KCg1KCg1KCtQKCxQKCxQKCxQKyxQUFBQAixQDkdQTCxQTyxQAlBQKVBQKCxQKCxQKCxQKCxQKCxQKCxQKCxQKCxQTyxQACk3HFA3AVA7UFBQUFBHAAAAAAkbRFBQKVBQKVBQKVBQKVBQKVA7KVA+KVA+UFA+',
  'pl1:1333:KUgbKUgbKUgANUgAKUgAKUgJKUgNKCQNKSQNKSQJKSQJKUgaKUgRKUggKCQFBCQIJwEbJwE2JwAAJwAAJwAAJwAAJAAAJwAAJwAAJwEbKgQbJwAaJwAIJwQ2JwE2KgBHAkgAUFBLKUgJKU8AKUsAJSQATUgAKCQAJRsAAj8AKUgAREgBTUgBUFA4KFA3B0k+C0gAAj8AKhsATgAAAj8ASwAAQgAAJAAASwAAJwAATgAAJwAAJwAAAAAAJwAATgAbAAAAAAACAAAbUFBLAAAARCcJASQAASQAASgWKCg1KCg1KAQ1TghQTghHTgVHTgE4TCgZTyQMAwg2Twg/AAAAJUsJHEgJASQMAkw1KVBQKFBQKVBQKVBQKFBQT1BQT01QJwAZKSgMJwgnKCgnTygMKUsJHUsJJSgWAk81JlBQKVBQKVBQKVBQKVBQUFBQUElQUFA1ASgJSwhLJAQVUEYwTgAAAAAAREYxJSgoJlBQKVBQKVBQKVBQKVBQUFBQEDFQTyg1AR8aKUdPUEc0NCgMAScJJSgMKCgoKCgoKCgoKDFQKDFQKDVQKDVQKDVNKyxQTUMaAkw1KVBQTyxQKCQaAkIaKCgaKCg1KCg1KCg1KCg1KChQKCxQKCxQKCxQKyxQUFBQAixQDkdQTCxQTyxQAlBQKVBQKCxQKCxQKCxQKCxQKCxQKCxQKCxQKCxQTyxQACk3HFA3AVA7UFBQUFBHAAAAAAkbRFBQKVBQKVBQKVBQKVBQKVA7KVA+KVA+UFA+',
  'pl1:1333:KUgbKUgbKUgANUgAKUgAKUgJREgNKCQNKCQNKSQJKSQJKUgaKUgRKUggKCQFBCQIJwEbJwE2JwAAJwAAJwAAJwAAJAAAJwAAJwAAJwEbKgQbJwAaJwAIJwQ2JwE2KgBHAkgAUFBLKUgJKU8AKUsAKCQATUgAKCQAJRsAAj8AKUgAREgBTUgBUFA4KFA3B0k+C0gAAj8AKhsATgAAAj8ASwAAQgAAJAAASwAAJwAATgAAJwAAJwAAAAAAJwAATgAbAAAAAAACAAAbUFBLAAAARCcJASQAASQAASgWKCg1KCg1KAQ1TghQTghHTgVHTgE4TCgZTyQMAwg2Twg/AAAAJUsJHEgJASQMAkw1KVBQKFBQKVBQKVBQKFBQT1BQT01QJwAZKSgMJwgnKCgnTygMKUsJHUsJJSgWAk81JlBQKVBQKVBQKVBQKVBQUFBQUElQUFA1ASgJSwhLJAQVUEYwTgAAAAAAREYxJSgoJlBQKVBQKVBQKVBQKVBQUFBQEDFQTyg1AR8aKUdPUEc0NCgMAScJJSgMKCgoKCgoKCgoKDFQKDFQKDVQKDVQKDVNKyxQTUMaAkw1KVBQTyxQKCQaAkIaKCgaKCg1KCg1KCg1KCg1KCtQKCxQKCxQKCxQKyxQUFBQAixQDkdQTCxQTyxQAlBQKVBQKCxQKCxQKCxQKCxQKCxQKCxQKCxQKCxQTyxQACk3HFA3AVA7UFBQUFBHAAAAAAkbRFBQKVBQKVBQKVBQKVBQKVA7KVA+KVA+UFA+',
];
it('preserves reflexivity and all directed pairs from three real stationary office frames', () => {
  for (const a of stationaryOffice) for (const b of stationaryOffice) {
    expect(matchLandmark(a, b)).toBe(true);
    expect(nearLandmark(a, b)).toBe(true);
  }
});
it('does not confuse real stationary office references with unrelated textured scenes', async () => {
  const unrelated = await signature(scene(189));
  for (const real of stationaryOffice) {
    expect(nearLandmark(real, unrelated)).toBe(false);
    expect(nearLandmark(unrelated, real)).toBe(false);
  }
});

function unpack(signature: string): number[] {
  return [...atob(signature.split(':')[2]!)].flatMap(char => {
    let n = char.charCodeAt(0); const values = [0, 0, 0, 0];
    for (let i = 3; i >= 0; i--) {values[i] = n % 3; n = Math.floor(n / 3);}
    return values;
  });
}
function pack(values: number[]): string {
  let bytes = '';
  for (let i = 0; i < values.length; i += 4)
    bytes += String.fromCharCode(values[i]! * 27 + values[i + 1]! * 9 + values[i + 2]! * 3 + values[i + 3]!);
  return 'pl1:1333:' + btoa(bytes);
}
// Feature-grid translation of the actual office (1 cell = 4 thumbnail pixels).
// Not a newly photographed scene: preserve its measured descriptors; fill new
// borders with another captured signature. No wraparound or per-region fitting.
function shiftFeatures(signature: string, dx: number, border: string): string {
  const source = unpack(signature), result = unpack(border);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const xx = x - dx;
    if (xx < 0 || xx >= 16) continue;
    for (let c = 0; c < 12; c++) result[(y * 16 + x) * 12 + c] = source[(y * 16 + xx) * 12 + c]!;
  }
  return pack(result);
}
function changeQuadrant(signature: string, quadrant: number, change: (v: number, i: number) => number) {
  return pack(unpack(signature).map((v, i) => {
    const cell = Math.floor(i / 12), q = (Math.floor(cell / 16) >= 6 ? 2 : 0) + (cell % 16 >= 8 ? 1 : 0);
    return q === quadrant ? change(v, i) : v;
  }));
}
it.each([-2, -1, 1, 2])('near matches the real weak-quadrant office shifted %i cells coherently', async dx => {
  const border = await signature(scene(610));
  for (const reference of stationaryOffice) {
    const moved = shiftFeatures(reference, dx, border);
    expect(matchLandmark(reference, moved)).toBe(false);
    expect(nearLandmark(reference, moved)).toBe(true);
    expect(nearLandmark(moved, reference)).toBe(true);
  }
});
it('weak-quadrant exception rejects one-sided detail loss and reversed contrast', async () => {
  const reference = stationaryOffice[0]!, border = await signature(scene(610));
  for (const change of [(v: number) => v === 1 ? 1 : 1, (v: number) => 2 - v]) {
    const changed = changeQuadrant(reference, 3, change);
    const moved = shiftFeatures(changed, 1, border);
    expect(nearLandmark(reference, moved)).toBe(false);
    expect(nearLandmark(moved, reference)).toBe(false);
  }
});
it('cannot waive two weak quadrants even when their translated patterns agree', async () => {
  const base = await signature(scene(71)), border = await signature(scene(610));
  const weaken = (v: number, i: number) => i % 5 < 2 ? v : 1;
  const twoWeak = changeQuadrant(changeQuadrant(base, 2, weaken), 3, weaken);
  // Valid signature: rejection must come from matching, not malformed input.
  expect(matchLandmark(twoWeak, twoWeak)).toBe(true);
  const moved = shiftFeatures(twoWeak, 1, border);
  expect(matchLandmark(moved, moved)).toBe(true);
  expect(matchLandmark(twoWeak, moved)).toBe(false);
  expect(nearLandmark(twoWeak, moved)).toBe(false);
  expect(nearLandmark(moved, twoWeak)).toBe(false);
});
it('rejects weak regions at different locations in the two views', async () => {
  const base = await signature(scene(71)), border = await signature(scene(610));
  const weaken = (v: number, i: number) => i % 5 < 2 ? v : 1;
  const a = changeQuadrant(base, 2, weaken), b = shiftFeatures(changeQuadrant(base, 3, weaken), 1, border);
  expect(nearLandmark(a, b)).toBe(false); expect(nearLandmark(b, a)).toBe(false);
});
