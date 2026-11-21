import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPresetView } from '../../srs-web-console/backend/src/services/presetView.ts';

const identity = [1,0,0,0,1,0,0,0,1];
const native = { width: 512, height: 384 }, hd = { width: 1280, height: 960 };
const zone = [[0.25,0.25],[0.75,0.25],[0.75,0.75],[0.25,0.75]];
function match(extra = {}) {
  return { schema: 'ainvr.scene-match.v2', backend: 'neuflow-bpu', matched: true,
    candidateCount: 200, inliers: 200, reprojectionErrorPx: 0.15, coverage: 1,
    supportBounds: [0,0,1,1], supportGrid: { columns: 8, rows: 6, cells: Array(48).fill(true) },
    homography: [...identity], localEvidence: 's'.repeat(128 * 96), ...extra };
}
function evidence(fn) {
  return Array.from({length: 128 * 96}, (_, n) => fn((n % 128 + 0.5) / 128, (Math.floor(n / 128) + 0.5) / 96)).join('');
}
function shift(px, resolution) {
  return [1,0,px / resolution,0,1,0,0,0,1];
}
const decision = (m, size = native) => projectPresetView(m, zone, size);

test('legal small drift returns an independent copy of canonical vertices', () => {
  const p = decision(match({ homography: shift(1.9, 512) }));
  assert.deepEqual(p, zone);
  assert.notEqual(p, zone);
  p[0][0] = 0;
  assert.equal(zone[0][0], 0.25);
});
test('enforces the tighter of native and source radial displacement budgets', () => {
  const m = match({ homography: shift(1, 512) });
  assert(decision(m));
  assert.equal(decision(m, hd), null);
  assert.equal(projectPresetView(m, zone), null);
  assert(decision(match({homography: shift(1, 1280)}), hd));
  assert.equal(decision(match({homography: shift(2.1, 512)}), {width:256,height:192}), null);
  assert.equal(decision(match({homography:[1,0,1.5/512,0,1,1.5/384,0,0,1]})), null);
});
test('rules out pan, zoom, roll and perspective even if the center is stable', () => {
  for (const h of [shift(8,512), [1.04,0,-.02,0,1.04,-.02,0,0,1],
    [.999,-.04,.02,.04,.999,-.02,0,0,1], [1.1,0,0,0,1,0,.1,0,1],
    [1,0,0,0,1,0,-1,0,1]]) assert.equal(decision(match({homography:h})), null);
});
test('near-identity fitted warp does not excuse local independently displaced descriptors', () => {
  const sites = evidence((x,y) => x>.25 && x<.75 && y>.25 && y<.75 ? '6' : 's');
  assert.equal(decision(match({localEvidence:sites}), hd), null);
});
test('distributed unique anchors must corroborate the coarse geometric fit', () => {
  for (const sites of [evidence((x,y) => x>.23 && x<.77 && y>.23 && y<.77 ? 's':'a'),
    'a'.repeat(128 * 96), 'u'.repeat(128 * 96)]) {
    assert.equal(decision(match({localEvidence:sites})), null);
  }
  assert.equal(decision(match({supportGrid:{columns:8,rows:6,cells:Array(48).fill(false)}})), null);
});
test('moving foreground outside a still-visible region can be tolerated', () => {
  const m = match({localEvidence:evidence((x,y) => y>2/3 ? 'd':'s')});
  const upper = [[.2,.15],[.8,.15],[.8,.4],[.2,.4]];
  const lower = [[.2,.72],[.8,.72],[.8,.95],[.2,.95]];
  assert.deepEqual(projectPresetView(m,upper,hd),upper);
  assert.equal(projectPresetView(m,lower,hd),null);
});
test('an ambiguous, missing, moving or mostly obscured ROI stays paused', () => {
  for (const site of ['a','u','d']) {
    const m = match({localEvidence:evidence((x,y) => x>.25 && x<.75 && y>.25 && y<.75 ? site:'s')});
    assert.equal(decision(m),null);
  }
  const m = match({localEvidence:evidence((x,y) => x>.25 && x<.58 && y>.25 && y<.75 ? 'u':'s')});
  assert.equal(decision(m),null);
});
test('descriptor footprints must fit inside even a narrow or concave region', () => {
  const narrow = [[.2,.2],[.6,.2],[.6,.25],[.2,.25]];
  assert.deepEqual(projectPresetView(match(),narrow,native),narrow);
  const small = [[.49,.49],[.51,.49],[.51,.51],[.49,.51]];
  assert.equal(projectPresetView(match(),small,native),null);
  const elbow = [[.2,.2],[.8,.2],[.8,.3],[.3,.3],[.3,.8],[.2,.8]];
  const m = match({localEvidence:evidence((x,y) => x>.19 && y>.19 && x<.81 && y<.81 && (x<.31 || y<.31) ? 'u':'s')});
  assert.equal(projectPresetView(m,elbow,native),null);
});
test('malformed geometry, v1, invalid statistics and self-crossing polygons fail closed', () => {
  for (const patch of [{schema:'ainvr.scene-match.v1'}, {backend:'cpu'}, {matched:false}, {homography:[1]},
    {inliers:201}, {inliers:150}, {reprojectionErrorPx:Infinity}, {localEvidence:'5'.repeat(12288)}]) {
    assert.equal(decision(match(patch)),null);
  }
  for (const bad of [null, {width:0,height:1}, {width:4096,height:4096}]) {
    assert.equal(projectPresetView(match(),zone,bad),null);
  }
  for (const p of [[zone[0],zone[2],zone[1],zone[3]], [[NaN,0],[1,1],[0,1]], [zone[0],zone[0],zone[2]]]) {
    assert.equal(projectPresetView(match(),p,hd),null);
  }
});
test('replaying the same valid answer remains visually indistinguishable from a static scene', () => {
  const frozen = match();
  for (let i=0;i<2;i++) assert.deepEqual(projectPresetView(frozen,zone,hd),zone);
  // Only caller-held capture/source provenance, stop/pose and epoch can establish freshness.
});
