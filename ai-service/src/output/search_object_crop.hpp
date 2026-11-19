// AINVR. Detector-crop admission for search samples. Pure geometry: no image, model, storage or tracker work.
#pragma once
#include "output/result.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <string>

namespace ai_service::output {
// Short edge, in raw source pixels, of the one public detection of `track_id`. Detection boxes are (x, y, w, h)
// in the result's observation frame, which scales to the raw frame per axis. nullopt unless exactly one box.
inline std::optional<double> SearchObjectShortEdgePx(const FrameResult& result, const std::string& track_id,
                                                     int raw_width, int raw_height) {
  if (track_id.empty() || result.frame_width <= 0 || result.frame_height <= 0 || raw_width <= 0 || raw_height <= 0) return std::nullopt;
  const Detection* found = nullptr;
  for (const auto& detection : result.detections) if (detection.track_id == track_id) {
    if (found) return std::nullopt;
    found = &detection;
  }
  if (!found) return std::nullopt;
  const double w = found->bbox[2] * raw_width / result.frame_width, h = found->bbox[3] * raw_height / result.frame_height;
  if (!std::isfinite(w) || !std::isfinite(h) || w <= 0 || h <= 0) return std::nullopt;
  return std::min(w, h);
}
// `minimum` comes from the space (PackageSpec::object_min_short_edge_px): too small a box is left to the scene views.
inline bool SearchObjectLargeEnough(const FrameResult& result, const std::string& track_id, int raw_width, int raw_height,
                                    double minimum) {
  const auto edge = SearchObjectShortEdgePx(result, track_id, raw_width, raw_height);
  return edge && *edge >= minimum;
}
}  // namespace ai_service::output
