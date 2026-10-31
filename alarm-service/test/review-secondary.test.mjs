import test from 'node:test';
import assert from 'node:assert/strict';
import {SECONDARY_REVIEW_VERSION, secondaryPrompt, nonTargetPrompt, secondaryAssessment, expandedTarget} from '../src/review-secondary.mjs';

const assess = overrides => secondaryAssessment({
  primaryScores: [.728597, .999974], contextScores: [.999999, .999996],
  negativeEvidenceScores: [1, 1],
  rule: {reject_below: .05, approve_above: .99},
  policy: {confirm_above: .99, reject_below: .01}, complete: true, ...overrides,
});
const outcome = (overrides, expected) => assert.equal(assess(overrides).outcome, expected);

const source = Object.freeze({width: 1920, height: 1080});
const nearBox = (actual, expected) => actual.forEach((value, i) =>
  assert.ok(Math.abs(value - expected[i]) < 1e-12, `${i}: ${value} != ${expected[i]}`));

test('expanded target normalizes pixel coordinates by each source dimension', () => {
  const sample = Object.freeze({bbox: Object.freeze({x: 768, y: 496.8, w: 192, h: 216})});
  // y=0.46, center=(0.45, 0.56), half size=(0.075, 0.15).
  nearBox(expandedTarget(sample, source), [.375, .41, .525, .71]);
  nearBox(expandedTarget(sample, source), expandedTarget(sample, source));
});

test('expanded target clamps to image boundaries without moving the original center', () => {
  nearBox(expandedTarget({bbox: {x: 0, y: 0, w: 192, h: 216}}, source), [0, 0, .125, .25]);
  nearBox(expandedTarget({bbox: {x: 1728, y: 864, w: 192, h: 216}}, source), [.875, .75, 1, 1]);
  nearBox(expandedTarget({bbox: {x: 0, y: 0, w: 1920, h: 1080}}, source), [0, 0, 1, 1]);
});

test('expanded target rejects invalid or out-of-bounds geometry rather than repairing it', () => {
  const bbox = {x: 768, y: 496.8, w: 192, h: 216};
  const rejects = (sample, dimensions = source) =>
    assert.throws(() => expandedTarget(sample, dimensions), /^Error: invalid_secondary_target$/);
  for (const sample of [undefined, null, {}, {bbox: null}]) rejects(sample);
  for (const key of ['x', 'y', 'w', 'h']) {
    for (const value of [NaN, Infinity, -Infinity, undefined, null, '1']) {
      rejects({bbox: {...bbox, [key]: value}});
    }
  }
  for (const invalid of [{x: -.01}, {y: -.01}, {w: 0}, {h: 0}, {w: -1}, {h: -1},
    {x: 1800}, {y: 1000}, {w: 1921}, {h: 1081}]) rejects({bbox: {...bbox, ...invalid}});
  for (const dimensions of [undefined, null, {}, {width: 1920}, {height: 1080}]) {
    assert.throws(() => expandedTarget({bbox}, dimensions), /invalid_secondary_target/);
  }
  for (const key of ['width', 'height']) {
    for (const value of [NaN, Infinity, 0, -1, undefined, null, '1920']) {
      rejects({bbox}, {...source, [key]: value});
    }
  }
});

test('version and exact stable shadow prompt', () => {
  assert.equal(SECONDARY_REVIEW_VERSION, 'expanded-target-v1');
  assert.equal(secondaryPrompt('person'), '只核对图片中央的指定目标是否是真实的人，不要用周围其他目标代替。截图扩大了周围范围以保留环境线索。目标可能被画面边缘截断或被遮挡；请根据可见的身体、衣物与肢体结构判断，不要求必须看见完整头部。注意海报、屏幕、倒影和人形物体。');
  for (const label of ['car', '', 'Person', undefined, null]) {
    assert.throws(() => secondaryPrompt(label), /^Error: unsupported_secondary_label$/);
    assert.throws(() => nonTargetPrompt(label), /^Error: unsupported_secondary_label$/);
  }
  assert.equal(nonTargetPrompt('person'), '请判断是否有充分、清晰的视觉证据确认图片中央的指定目标不是人。只有看清中央目标确实是物体、背景、海报、屏幕或倒影而非真实人员，才回答是。画面昏暗、模糊、遮挡、目标太小、只有局部且无法确定，或中央目标可能是人，都回答否。不要用周围其他目标代替。');
});

test('actual paired scores confirm without claiming behavioral review', () => {
  assert.deepEqual(assess(), {outcome: 'confirmed', reason: 'secondary_class_confirmed'});
  outcome({contextScores: [.99999895, .99999611]}, 'confirmed');
  outcome({contextScores: [.999997434, .999998969]}, 'confirmed');
  outcome({primaryScores: [0], contextScores: [.0000437583], negativeEvidenceScores: [.888]}, 'uncertain');
  outcome({primaryScores: [0, .05], contextScores: [0, .01]}, 'false_positive');
});

test('contradictory and weak evidence cannot be outvoted', () => {
  for (const primaryScores of [[.01, 1], [.5, 1], [.98, .98]]) outcome({primaryScores}, 'uncertain');
  outcome({contextScores: [.99, .989999]}, 'uncertain');
  outcome({primaryScores: [0, 0], contextScores: [0, 1]}, 'uncertain');
  outcome({primaryScores: [1, 1], contextScores: [0, 0]}, 'uncertain');
});

test('complete must explicitly attest all real required frames', () => {
  for (const complete of [false, undefined, null, 1, 'true']) outcome({complete}, 'uncertain');
  assert.equal(secondaryAssessment().outcome, 'uncertain');
});

test('missing, invalid, sparse, or miscounted scores fail closed', () => {
  const bad = [undefined, null, [], [NaN], [Infinity], [-.01], [1.01], ['1'], [null],
    new Array(2), [.99, , 1], [1, 1, 1, 1, 1], new Float64Array([1])];
  for (const scores of bad) {
    outcome({primaryScores: scores}, 'uncertain');
    outcome({contextScores: scores}, 'uncertain');
  }
  outcome({contextScores: [1]}, 'uncertain');
  outcome({primaryScores: [1]}, 'uncertain');
  for (const count of [1, 2, 3, 4]) {
    outcome({primaryScores: Array(count).fill(1), contextScores: Array(count).fill(1)}, 'confirmed');
    outcome({primaryScores: Array(count).fill(0), contextScores: Array(count).fill(0), negativeEvidenceScores: Array(count).fill(1)}, 'false_positive');
  }
});

test('invalid or unordered thresholds fail closed', () => {
  for (const field of ['approve_above', 'reject_below']) {
    for (const value of [undefined, null, NaN, Infinity, -.01, 1.01, '.99']) {
      outcome({rule: {reject_below: .05, approve_above: .99, [field]: value}}, 'uncertain');
    }
  }
  for (const field of ['confirm_above', 'reject_below']) {
    for (const value of [undefined, null, NaN, Infinity, -.01, 1.01, '.99']) {
      outcome({policy: {confirm_above: .99, reject_below: .01, [field]: value}}, 'uncertain');
    }
  }
  for (const rule of [undefined, {}, {reject_below: .99, approve_above: .99}, {reject_below: 1, approve_above: 0}]) outcome({rule}, 'uncertain');
  for (const policy of [undefined, {}, {reject_below: .99, confirm_above: .99}]) outcome({policy}, 'uncertain');
});

test('confirmation boundaries: inclusive context and strong score, strict primary floor', () => {
  outcome({primaryScores: [.500001, .99], contextScores: [.99, .99]}, 'confirmed');
  outcome({primaryScores: [.5, .99]}, 'uncertain');
  outcome({primaryScores: [.98, .989999]}, 'uncertain');
  outcome({policy: {confirm_above: .999999, reject_below: .01}}, 'uncertain');
  const rule = {reject_below: .7, approve_above: .995};
  outcome({rule, primaryScores: [.700001, .995], contextScores: [.995, .995]}, 'confirmed');
  outcome({rule, primaryScores: [.7, 1]}, 'uncertain');
  outcome({rule, primaryScores: [.8, .994999]}, 'uncertain');
  outcome({rule, contextScores: [.994999, 1]}, 'uncertain');
  outcome({rule: {reject_below: 0, approve_above: .9}, primaryScores: [.8, .99], contextScores: [.99, .989999]}, 'uncertain');
  outcome({policy: {confirm_above: .9, reject_below: .01}, contextScores: [.98, 1]}, 'uncertain');
});

test('rejection boundaries: both arrays unanimously meet the stricter ceiling', () => {
  const primaryScores = [.05, .05], contextScores = [.01, .01];
  outcome({primaryScores, contextScores}, 'false_positive');
  outcome({primaryScores: [.050001, 0], contextScores}, 'uncertain');
  outcome({primaryScores, contextScores: [.010001, 0]}, 'uncertain');
  outcome({primaryScores, contextScores, rule: {reject_below: .04, approve_above: .99}}, 'uncertain');
  outcome({primaryScores, contextScores, policy: {reject_below: .005, confirm_above: .99}}, 'uncertain');
  outcome({primaryScores: [.04, 0], contextScores: [.005, 0], rule: {reject_below: .04, approve_above: .99}, policy: {reject_below: .005, confirm_above: .99}}, 'false_positive');
  outcome({primaryScores, contextScores, rule: {reject_below: .2, approve_above: .99}, policy: {reject_below: .2, confirm_above: .99}}, 'false_positive');
});

test('rejection needs complete, strong explicit non-person evidence for every frame', () => {
  const low = {primaryScores: [0, .01], contextScores: [.0000437583, 0]};
  const insufficient = {outcome: 'uncertain', reason: 'insufficient_non_target_evidence'};
  for (const negativeEvidenceScores of [undefined, null, [], [.999], [1, 1, 1],
    [NaN, 1], [Infinity, 1], [-1, 1], [1.01, 1], ['1', 1], new Array(2),
    [.999, ,], [.888, .999], [.011, .999], [.989999, 1]]) {
    assert.deepEqual(assess({...low, negativeEvidenceScores}), insufficient);
  }
  outcome({...low, negativeEvidenceScores: [.999, .999]}, 'false_positive');
  outcome({...low, negativeEvidenceScores: [.99, .99]}, 'false_positive');
  const policy = {confirm_above: .99, reject_below: .001};
  const stricter = {...low, contextScores: [0, 0], policy};
  assert.deepEqual(assess({...stricter, negativeEvidenceScores: [.998999, 1]}), insufficient);
  outcome({...stricter, negativeEvidenceScores: [.999, .999]}, 'false_positive');
  // Explicitly non-person evidence is optional and cannot affect confirmation.
  for (const negativeEvidenceScores of [undefined, [.011, .011], [NaN], []]) {
    outcome({negativeEvidenceScores}, 'confirmed');
  }
});

test('assessment is deterministic and leaves inputs unchanged', () => {
  const input = Object.freeze({primaryScores: Object.freeze([.8, 1]), contextScores: Object.freeze([1, 1]),
    rule: Object.freeze({reject_below: .05, approve_above: .99}),
    policy: Object.freeze({confirm_above: .99, reject_below: .01}), complete: true});
  assert.deepEqual(secondaryAssessment(input), secondaryAssessment(input));
  assert.equal(secondaryAssessment(input).outcome, 'confirmed');
});
