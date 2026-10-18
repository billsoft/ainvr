// Copyright AINVR. Point archive geometry is distinct from a detection box.
#pragma once
#include <cmath>
#include <stdexcept>
#include <vector>
#include "result.hpp"

namespace ai_service::output {
inline void ValidateSnapshotPoint(const nlohmann::json& point) {
  if (!point.is_object() || point.value("coordinate_space", std::string()) != "normalized_full_frame")
    throw std::invalid_argument("Snapshot point requires normalized full-frame coordinates");
  for (const char* key : {"x", "y"}) {
    if (!point.contains(key) || !point.at(key).is_number())
      throw std::invalid_argument("Snapshot point coordinate missing");
    const double value = point.at(key).get<double>();
    if (!std::isfinite(value) || value < 0 || value > 1)
      throw std::invalid_argument("Snapshot point coordinate outside frame");
  }
  if (point.contains("context_image_rect")) {
    const auto& rect = point.at("context_image_rect");
    if (!rect.is_object()) throw std::invalid_argument("Invalid point context image rectangle");
    for (const char* key : {"x", "y", "w", "h"}) {
      if (!rect.contains(key) || !rect.at(key).is_number() ||
          !std::isfinite(rect.at(key).get<double>()))
        throw std::invalid_argument("Invalid point context image rectangle");
    }
    const double x = rect.at("x"), y = rect.at("y"), w = rect.at("w"), h = rect.at("h");
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1)
      throw std::invalid_argument("Point context rectangle outside encoded image");
  }
}
// JPEG minimum-size edge padding changes the canvas,not the original point.
// Preserve its visible full-frame rectangle on subsequent encode/recovery retries.
inline void PreserveSnapshotPointContext(nlohmann::json& point,
    int visible_width, int visible_height, int encoded_width, int encoded_height) {
  ValidateSnapshotPoint(point);
  if (visible_width <= 0 || visible_height <= 0 || encoded_width < visible_width ||
      encoded_height < visible_height || encoded_width > 8192 || encoded_height > 8192)
    throw std::invalid_argument("Invalid point context canvas dimensions");
  if (!point.contains("context_image_rect")) {
    point["context_image_rect"] = {{"x", 0}, {"y", 0},
      {"w", double(visible_width) / encoded_width}, {"h", double(visible_height) / encoded_height}};
  }
  ValidateSnapshotPoint(point);
}
struct GroundingSnapshotTarget {
  nlohmann::json point;
  Detection properties;  // Class/query/confidence only; no detection bbox.
};
inline std::vector<GroundingSnapshotTarget> GroundingSnapshotTargets(const FrameResult& result) {
  const auto& extra = result.model_extra;
  if (!extra.is_object() || !extra.contains("grounding")) return {};
  const auto& g = extra.at("grounding");
  if (!g.is_object() || g.value("complete", false) != true ||
      g.value("coordinate_space", std::string()) != "normalized_full_frame") return {};
  if (!g.contains("points") || !g.at("points").is_array())
    throw std::invalid_argument("Snapshot grounding points must be an array");
  // No silent truncation: accepting a frame promises all of its point records.
  // Bound one result before any capture; the model's generation itself is bounded.
  if (g.at("points").size() > 1024)
    throw std::invalid_argument("Snapshot grounding exceeds 1024 points per result");
  std::vector<GroundingSnapshotTarget> out;
  for (const auto& p : g.at("points")) {
    if (!p.is_object() || !p.contains("x") || !p.contains("y"))
      throw std::invalid_argument("Snapshot grounding point missing coordinates");
    GroundingSnapshotTarget target;
    target.point = {{"x", p.at("x")}, {"y", p.at("y")},
                    {"coordinate_space", "normalized_full_frame"}};
    ValidateSnapshotPoint(target.point);
    auto& d = target.properties;
    d.class_id = -1;
    d.bbox = {0, 0, 0, 0};  // Not a region; must never be serialized as a bbox.
    d.class_name = p.value("class_name", p.value("query_description", std::string()));
    d.label_id = p.value("label_id", std::string());
    d.query_description = p.value("query_description", std::string());
    d.confidence_known = p.contains("confidence") && !p.at("confidence").is_null();
    d.confidence = d.confidence_known ? p.at("confidence").get<double>() : 0;
    if (d.confidence_known && (!std::isfinite(d.confidence) || d.confidence < 0 || d.confidence > 1))
      throw std::invalid_argument("Snapshot point confidence outside range");
    d.model_extra = extra;
    out.push_back(std::move(target));
  }
  return out;
}
}  // namespace ai_service::output
