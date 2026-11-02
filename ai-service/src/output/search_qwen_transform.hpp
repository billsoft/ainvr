// AINVR. Pure geometry of the Qwen3-VL-Embedding image input: the SAME source rectangle as the stored
// evidence JPEG goes to the GPU sampler, fitted into 896x448. Regions whose aspect is close to 2:1 are
// stretched (what the model was validated on); others are letterboxed with neutral grey so objects keep
// their proportions. Resize filter: Area (box, anti-aliased) when both axes shrink, else bicubic. Plain bicubic on the GPU has no
// anti-aliasing and lost cosine 0.89 against the anti-aliased reference on 4K/8K frames; Area alone blurs small upscaled crops
// (0.96). The rules are part of the vector space (input_spec_version).
#pragma once
#include "output/snapshot_transform.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace ai_service::output {

inline constexpr int kQwenImageWidth = 896, kQwenImageHeight = 448;
inline constexpr double kQwenStretchMinAspect = 1.6, kQwenStretchMaxAspect = 2.5;

inline ainvr::ImageTransform QwenVisionTransform(const ainvr::SnapshotPlan& plan, bool bt709, bool full_range) {
  if (plan.perspective) throw std::runtime_error("search_vision_panorama_unverified");
  const double rw = plan.source_rectangle[2], rh = plan.source_rectangle[3];
  if (!(rw > 0 && rh > 0)) throw std::runtime_error("search_vision_crop_invalid");
  auto t = ainvr::SnapshotTransform(plan, bt709, full_range);
  t.width = kQwenImageWidth; t.height = kQwenImageHeight;
  t.bgr = false; t.nearest = false;
  t.mean = t.divisor = {127.5f, 127.5f, 127.5f};
  t.padding = {127.5f, 127.5f, 127.5f};   // neutral grey: exactly 0 after normalisation
  const double aspect = rw / rh;
  t.letterbox = !(aspect >= kQwenStretchMinAspect && aspect <= kQwenStretchMaxAspect);
  double fitted_w = kQwenImageWidth, fitted_h = kQwenImageHeight;   // size the region occupies inside the 896x448 canvas
  if (t.letterbox) {
    const double scale = std::min(kQwenImageWidth / rw, kQwenImageHeight / rh);
    fitted_w = std::nearbyint(rw * scale); fitted_h = std::nearbyint(rh * scale);
  }
  t.interpolation = (rw > fitted_w && rh > fitted_h) ? ainvr::ImageInterpolation::Area : ainvr::ImageInterpolation::Bicubic;
  return t;
}

// Evidence of the model input for the stored sample (informational; the vector space is fixed by input_spec_version).
inline nlohmann::json QwenModelInputEvidence(const ainvr::SnapshotPlan& plan) {
  const auto t = QwenVisionTransform(plan, true, false);
  return {{"width", kQwenImageWidth}, {"height", kQwenImageHeight}, {"color", "RGB"}, {"interpolation", t.interpolation == ainvr::ImageInterpolation::Area ? "area" : "bicubic"},
          {"aspect", t.letterbox ? "letterbox" : "stretch"}, {"padding", 127.5}, {"mean", 127.5}, {"divisor", 127.5}};
}

}  // namespace ai_service::output
