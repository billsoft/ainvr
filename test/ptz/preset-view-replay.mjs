// Offline replay from repository root, using the backend tsx loader. Outputs JSON to stdout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPresetView } from '../../srs-web-console/backend/src/services/presetView.ts';

const root = path.resolve(process.argv[2] ?? 'test/results/scene-trial4-pinned-20261121');
const pinned = path.join(root, 'pinned');
const digest = buf => createHash('sha256').update(buf).digest('hex');
const pin = await readFile(path.join(pinned, 'sha256.json'));
assert.equal(digest(pin), '08a78117a818073e7a8cbb3438e9f28a116dbb8c93f38e4bd26b08ee79cf6aa8');
for (const [file, expected] of Object.entries(JSON.parse(pin))) {
  assert.equal(digest(await readFile(path.join(pinned, file))), expected, file);
}
const raw = await readFile(path.join(root, 'observations.jsonl'));
assert.equal(digest(raw), 'c0faae18a065c00ead2d7a5d349a9afeb1c29fa276b6a132984c2b5957f09389');
const views = new Set(['translate8','translate_diag','translate24','zoom085','roll5','zoom115','projective',
  'second_scene_translation','camera_new_affine','pan-right-600','zoom-600-matched','onvif-pan-right']);
const manifest = new Map();
for (const suite of ['original','subcell','independent','live']) {
  const m = JSON.parse(await readFile(path.join(pinned, suite, 'manifest.json')));
  for (const c of m.cases) manifest.set(suite + '/' + c.name, { c, width: m.width, height: m.height });
}

const details = [], seen = new Set(), counts = {};
let wrong = 0;
for (const line of raw.toString().trimEnd().split('\n')) {
  const r = JSON.parse(line), suite = path.basename(r.dir), id = suite + '/' + r.name;
  assert(!seen.has(id)); seen.add(id);
  const { c, width, height } = manifest.get(id);
  for (const region of c.regions) {
    const label = views.has(c.name) ? 'differentView' : region.policy.startsWith('reject') ? 'unreliable' : 'sameView';
    if (label === 'sameView') assert.equal(region.policy, 'visible');
    const expected = label === 'sameView', points = region.polygon;
    const accepted = projectPresetView(r.match, points, { width, height }) !== null;
    const prior = r.regions.find(old => old.name === region.name);
    assert(prior);
    let maxCanonicalErrorPx = null;
    if (expected) {
      const h = region.oracleH;
      assert(h, id + '/' + region.name);
      maxCanonicalErrorPx = Math.max(...points.map(([u, v]) => {
        const x = u * width, y = v * height;
        const dot = row => row[0]*x + row[1]*y + row[2];
        return Math.hypot(dot(h[0])/dot(h[2]) - x, dot(h[1])/dot(h[2]) - y);
      }));
      assert(maxCanonicalErrorPx <= 2);
    }
    if (accepted && !expected) wrong++;
    const key = suite + '/' + label;
    const stat = counts[key] ??= { total: 0, accepted: 0, priorArbitraryAccepted: 0 };
    stat.total++; stat.accepted += Number(accepted); stat.priorArbitraryAccepted += Number(prior.projection !== null);
    details.push({ suite, pair: c.name, region: region.name, label, accepted, maxCanonicalErrorPx });
  }
}
assert.equal(manifest.size, 45);
assert.equal(seen.size, manifest.size);
assert.equal(details.length, 88);
const algorithm = new URL('../../srs-web-console/backend/src/services/presetView.ts', import.meta.url);
console.log(JSON.stringify({ frames: seen.size, regions: details.length, falseAccepts: wrong,
  pinSha256: digest(pin), observationsSha256: digest(raw), algorithmSha256: digest(await readFile(algorithm)),
  counts, details }, null, 2));
assert.equal(wrong, 0, 'Wrong-view or unsupported ROI accepted');
for (const [suite, minimum] of Object.entries({ original: 18, subcell: 3, independent: 5, live: 3 })) {
  assert(counts[suite + '/sameView'].accepted >= minimum, suite + ' lost same-view controls');
}
