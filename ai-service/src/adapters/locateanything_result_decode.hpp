// Copyright AINVR. LocateAnything token geometry -> shared JSON/SEI detections.
#pragma once
#include <cmath>
#include <stdexcept>
#include "output/result.hpp"

namespace ai_service::adapters {
struct LocateAnythingGeometry {
  std::vector<Detection> detections;
  nlohmann::json points = nlohmann::json::array();
};

// Coordinates refer to the complete image resized to the fixed HBM profile.
// Never undo YOLO letterboxing here: this model has no letterbox padding.
inline LocateAnythingGeometry DecodeLocateAnythingGeometry(
    const nlohmann::json& response, int width, int height,
    const std::string& description, const std::string& label_id,
    const std::string& label_name, int maximum) {
  if (width <= 0 || height <= 0 || maximum <= 0 ||
      !response.value("terminal", false))
    throw std::invalid_argument("LocateAnything incomplete generation or invalid frame");
  const auto& ids = response.at("generated_ids");
  const auto& scores = response.at("token_logprobs");
  if (!ids.is_array() || !scores.is_array() || ids.size() != scores.size() ||
      ids.empty() || ids.size() > 512)
    throw std::invalid_argument("LocateAnything invalid token/score lengths");
  for (const auto& id : ids)
    if (!id.is_number_integer() || id.get<int64_t>() < 0 || id.get<int64_t>() >= 152681)
      throw std::invalid_argument("LocateAnything token outside original vocabulary");
  if (ids.back().get<int>() != 151645)
    throw std::invalid_argument("LocateAnything missing original end token");
  LocateAnythingGeometry result;
  for (size_t i = 0; i < ids.size(); ++i) {
    if (ids[i].get<int>() != 151668) continue;
    size_t end = i + 1;
    while (end < ids.size() && ids[end].get<int>() != 151669) ++end;
    if (end == ids.size()) throw std::invalid_argument("LocateAnything unterminated geometry");
    const size_t count = end - i - 1;
    if (count == 1 && ids[i + 1].get<int>() == 4064) { i = end; continue; }
    if (count != 2 && count != 4)
      throw std::invalid_argument("LocateAnything geometry requires two or four coordinates");
    std::array<double, 4> xy{};
    for (size_t j = 0; j < count; ++j) {
      const int value = ids[i + 1 + j].get<int>() - 151677;
      if (value < 0 || value > 1000)
        throw std::invalid_argument("LocateAnything invalid coordinate token");
      xy[j] = value / 1000.0 * (j % 2 ? height : width);
    }
    bool known = true;
    double sum = 0;
    for (size_t j = i; j <= end; ++j) {
      if (scores[j].is_null()) { known = false; continue; }
      if (!scores[j].is_number()) throw std::invalid_argument("LocateAnything invalid score");
      const double value = scores[j].get<double>();
      if (!std::isfinite(value) || value > 0)
        throw std::invalid_argument("LocateAnything invalid token log probability");
      sum += value;
    }
    const double confidence = known ? std::exp(sum / (end - i + 1)) : 0;
    if (result.detections.size() + result.points.size() >= size_t(maximum))
      throw std::invalid_argument("LocateAnything result exceeds requested geometry capacity");
    if (count == 2) {
      // Points remain points, rather than fabricated boxes sent to crop/archive.
      result.points.push_back({{"x", xy[0]}, {"y", xy[1]}, {"label_id", label_id},
          {"class_name", label_name.empty() ? description : label_name},
          {"query_description", description}, {"confidence_known", known},
          {"confidence", known ? nlohmann::json(confidence) : nlohmann::json(nullptr)}});
    } else {
      if (xy[2] <= xy[0] || xy[3] <= xy[1])
        throw std::invalid_argument("LocateAnything reversed or empty box");
      Detection detection;
      detection.class_id = 0;
      detection.class_name = label_name.empty() ? description : label_name;
      detection.label_id = label_id;
      detection.query_description = description;
      detection.bbox = {xy[0], xy[1], xy[2] - xy[0], xy[3] - xy[1]};
      detection.confidence = confidence;
      detection.confidence_known = known;
      detection.model_extra = {{"geometry_type", "box"}, {"coordinate_scale", 1000},
          {"score_kind", "mean_geometry_token_log_probability"}};
      result.detections.push_back(std::move(detection));
    }
    i = end;
  }
  return result;
}
}  // namespace ai_service::adapters
