export const SECONDARY_REVIEW_VERSION = 'expanded-target-v1';

export function secondaryPrompt(label) {
  if (label !== 'person') throw Error('unsupported_secondary_label');
  return '只核对图片中央的指定目标是否是真实的人，不要用周围其他目标代替。截图扩大了周围范围以保留环境线索。目标可能被画面边缘截断或被遮挡；请根据可见的身体、衣物与肢体结构判断，不要求必须看见完整头部。注意海报、屏幕、倒影和人形物体。';
}

// Pixel bbox -> normalized [left, top, right, bottom] for existing GPU prep.
// Expand 1.5x about the original center, then clamp (do not recenter).
// The existing GPU's subsequent 1.5x expansion yields up to 2.25x overall.
export function expandedTarget(sample, source) {
  const bbox = sample?.bbox;
  if (!Number.isFinite(source?.width) || source.width <= 0 ||
      !Number.isFinite(source?.height) || source.height <= 0 ||
      !bbox || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(bbox[key])) ||
      bbox.x < 0 || bbox.y < 0 || bbox.w <= 0 || bbox.h <= 0 ||
      bbox.w > source.width || bbox.h > source.height ||
      bbox.x > source.width - bbox.w || bbox.y > source.height - bbox.h) {
    throw Error('invalid_secondary_target');
  }
  const cx = bbox.x / source.width + (bbox.w / source.width) / 2;
  const cy = bbox.y / source.height + (bbox.h / source.height) / 2;
  const halfw = (bbox.w / source.width) * .75;
  const halfh = (bbox.h / source.height) * .75;
  return [Math.max(0, cx - halfw), Math.max(0, cy - halfh),
    Math.min(1, cx + halfw), Math.min(1, cy + halfh)];
}

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
export function nonTargetPrompt(label) {
  if (label !== 'person') throw Error('unsupported_secondary_label');
  return '请判断是否有充分、清晰的视觉证据确认图片中央的指定目标不是人。只有看清中央目标确实是物体、背景、海报、屏幕或倒影而非真实人员，才回答是。画面昏暗、模糊、遮挡、目标太小、只有局部且无法确定，或中央目标可能是人，都回答否。不要用周围其他目标代替。';
}

const scoresValid = scores => Array.isArray(scores) && scores.length >= 1 &&
  scores.length <= 4 && Array.from(scores).every(probability);
const uncertain = reason => ({outcome: 'uncertain', reason});

// complete is a caller attestation that every required real frame is present,
// paired in order across both score arrays. Scores alone cannot prove provenance,
// required-frame coverage, geometry, or behavior; those checks belong upstream.
// This pure assessment does not authorize or persist a production verdict.
export function secondaryAssessment({primaryScores, contextScores, negativeEvidenceScores, rule, policy, complete} = {}) {
  if (complete !== true) return uncertain('incomplete_frames');
  if (!scoresValid(primaryScores) || !scoresValid(contextScores) ||
      primaryScores.length !== contextScores.length) return uncertain('invalid_scores');
  if (!probability(rule?.reject_below) || !probability(rule?.approve_above) ||
      rule.reject_below >= rule.approve_above ||
      !probability(policy?.confirm_above) || !probability(policy?.reject_below) ||
      policy.reject_below >= policy.confirm_above) return uncertain('invalid_thresholds');

  const contextFloor = Math.max(.99, policy.confirm_above, rule.approve_above);
  const primaryFloor = Math.max(.5, rule.reject_below);
  const strongFloor = Math.max(.99, rule.approve_above);
  if (contextScores.every(score => score >= contextFloor) &&
      primaryScores.every(score => score > primaryFloor) &&
      primaryScores.some(score => score >= strongFloor)) {
    return {outcome: 'confirmed', reason: 'secondary_class_confirmed'};
  }
  if (primaryScores.every(score => score <= Math.min(.05, rule.reject_below)) &&
      contextScores.every(score => score <= Math.min(.01, policy.reject_below))) {
    // Low person scores alone do not distinguish a non-person from unclear imagery.
    const negativeFloor = Math.max(.99, 1 - policy.reject_below);
    if (!scoresValid(negativeEvidenceScores) ||
        negativeEvidenceScores.length !== primaryScores.length ||
        !negativeEvidenceScores.every(score => score >= negativeFloor)) {
      return uncertain('insufficient_non_target_evidence');
    }
    return {outcome: 'false_positive', reason: 'secondary_class_rejected'};
  }
  return uncertain('insufficient_class_evidence');
}
