// Copyright AINVR. LocateAnything token geometry -> shared JSON/SEI detections.
#pragma once
#include <cctype>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include "config/config.hpp"
#include "output/result.hpp"

namespace ai_service::adapters {
struct LocateAnythingGeometry {
  std::vector<Detection> detections;
  nlohmann::json points = nlohmann::json::array();
  // Geometry generated under a category name that matches no configured slot.
  size_t unmatched = 0;
};

// Same capacity as the 8-slot open-vocabulary model;the compiled prefill
// profile still bounds the total text (checked by the executor's validate).
constexpr size_t kLocateAnythingMaximumSlots = 8;

// One request per frame. Several slots use the model's own multi-category form
// (README detect(): categories joined by the special token </c>).
inline std::string LocateAnythingQuery(const config::ModelConfig& cfg) {
  if (cfg.prompts.empty()) return cfg.description;
  if (cfg.prompts.size() > kLocateAnythingMaximumSlots)
    throw std::invalid_argument("LocateAnything accepts at most 8 categories");
  std::string query;
  for (const auto& row : cfg.prompts) {
    if (!query.empty()) query += "</c>";
    query += row.description;
  }
  return query;
}

// Echoed names differ from the configured text in small ways (observed on the
// BPU model):case, spacing, a dropped leading article, a final period.
inline std::string LocateAnythingNormalizedName(const std::string& text) {
  std::string out;
  for (unsigned char c : text) {
    if (std::isspace(c)) {
      if (!out.empty() && out.back() != ' ') out += ' ';
    } else {
      out += static_cast<char>(std::tolower(c));
    }
  }
  while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
  for (const char* article : {"a ", "an ", "the "})
    if (out.rfind(article, 0) == 0) { out.erase(0, std::strlen(article)); break; }
  return out;
}

// Singular/plural of the final word count as the same category ("cars" / "car").
inline bool LocateAnythingSameName(const std::string& a, const std::string& b) {
  const auto x = LocateAnythingNormalizedName(a), y = LocateAnythingNormalizedName(b);
  if (x.empty() || y.empty()) return false;
  if (x == y) return true;
  auto stem = [](const std::string& s) {
    if (s.size() > 4 && s.compare(s.size() - 2, 2, "es") == 0) return s.substr(0, s.size() - 2);
    if (s.size() > 3 && s.back() == 's') return s.substr(0, s.size() - 1);
    return s;
  };
  return x == stem(y) || stem(x) == y || stem(x) == stem(y);
}

// The k-th <ref> token in generated_ids owns the k-th <ref>name</ref> of the
// decoded response text. Returns the configured slot of each, -1 when the
// generated name is not one of the configured categories.
// truncated:generation stopped at the token limit;a cut final name is unmatched.
inline std::vector<int> LocateAnythingRefSlots(const nlohmann::json& response,
                                               const std::vector<config::PromptLabel>& slots,
                                               bool truncated = false) {
  const auto& ids = response.at("generated_ids");
  if (!response.contains("response") || !response["response"].is_string())
    throw std::invalid_argument("LocateAnything multi-category output lacks decoded text");
  size_t refs = 0;
  for (const auto& id : ids) refs += id.get<int>() == 151672;
  const std::string text = response["response"].get<std::string>();
  std::vector<int> result;
  for (size_t at = text.find("<ref>"); at != std::string::npos; at = text.find("<ref>", at)) {
    const size_t start = at + 5, end = text.find("</ref>", start);
    if (end == std::string::npos) {
      if (!truncated) throw std::invalid_argument("LocateAnything unterminated category name");
      result.push_back(-1);
      break;
    }
    const auto name = text.substr(start, end - start);
    int slot = -1;
    for (size_t i = 0; i < slots.size() && slot < 0; ++i)
      if (LocateAnythingSameName(slots[i].description, name)) slot = int(i);
    result.push_back(slot);
    at = end + 6;
  }
  if (result.size() != refs)
    throw std::invalid_argument("LocateAnything category names differ from generated tokens");
  return result;
}

// Coordinates refer to the complete image resized to the fixed HBM profile.
// Never undo YOLO letterboxing here: this model has no letterbox padding.
// With slots, ref_slots[k] labels the geometry after the k-th <ref>.
// truncated:stopped at the token limit;finished geometry is kept, the cut tail dropped.
inline LocateAnythingGeometry DecodeLocateAnythingGeometry(
    const nlohmann::json& response, int width, int height,
    const std::string& description, const std::string& label_id,
    const std::string& label_name, int maximum,
    const std::vector<config::PromptLabel>* slots = nullptr,
    const std::vector<int>* ref_slots = nullptr, bool truncated = false) {
  if (width <= 0 || height <= 0 || maximum <= 0 ||
      (!truncated && !response.value("terminal", false)))
    throw std::invalid_argument("LocateAnything incomplete generation or invalid frame");
  if ((slots == nullptr) != (ref_slots == nullptr) || (slots && slots->empty()))
    throw std::invalid_argument("LocateAnything category slots are incomplete");
  const auto& ids = response.at("generated_ids");
  const auto& scores = response.at("token_logprobs");
  if (!ids.is_array() || !scores.is_array() || ids.size() != scores.size() ||
      ids.empty() || ids.size() > 512)
    throw std::invalid_argument("LocateAnything invalid token/score lengths");
  for (const auto& id : ids)
    if (!id.is_number_integer() || id.get<int64_t>() < 0 || id.get<int64_t>() >= 152681)
      throw std::invalid_argument("LocateAnything token outside original vocabulary");
  if (!truncated && ids.back().get<int>() != 151645)
    throw std::invalid_argument("LocateAnything missing original end token");
  if (slots) {
    size_t refs = 0;
    for (const auto& id : ids) refs += id.get<int>() == 151672;
    if (refs != ref_slots->size())
      throw std::invalid_argument("LocateAnything category slots differ from generated groups");
    for (int slot : *ref_slots)
      if (slot < -1 || slot >= int(slots->size()))
        throw std::invalid_argument("LocateAnything category slot outside configuration");
  }
  LocateAnythingGeometry result;
  int group = -1;  // index into ref_slots of the current <ref> group
  for (size_t i = 0; i < ids.size(); ++i) {
    if (ids[i].get<int>() == 151672) { ++group; continue; }
    if (ids[i].get<int>() != 151668) continue;
    size_t end = i + 1;
    while (end < ids.size() && ids[end].get<int>() != 151669) ++end;
    if (end == ids.size()) {
      if (truncated) break;
      throw std::invalid_argument("LocateAnything unterminated geometry");
    }
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
    if (count == 4 && (xy[2] <= xy[0] || xy[3] <= xy[1]))
      throw std::invalid_argument("LocateAnything reversed or empty box");
    int class_id = 0;
    std::string id = label_id, name = label_name.empty() ? description : label_name, query = description;
    if (slots) {
      if (group < 0) throw std::invalid_argument("LocateAnything geometry precedes its category name");
      const int slot = (*ref_slots)[size_t(group)];
      if (slot < 0) { ++result.unmatched; i = end; continue; }
      const auto& row = (*slots)[size_t(slot)];
      class_id = slot; id = row.label_id; query = row.description;
      name = row.label_name.empty() ? row.description : row.label_name;
    }
    if (result.detections.size() + result.points.size() >= size_t(maximum))
      throw std::invalid_argument("LocateAnything result exceeds requested geometry capacity");
    if (count == 2) {
      // Points remain points, rather than fabricated boxes sent to crop/archive.
      result.points.push_back({{"x", xy[0]}, {"y", xy[1]}, {"label_id", id},
          {"class_name", name}, {"query_description", query}, {"confidence_known", known},
          {"confidence", known ? nlohmann::json(confidence) : nlohmann::json(nullptr)}});
    } else {
      Detection detection;
      detection.class_id = class_id;
      detection.class_name = name;
      detection.label_id = id;
      detection.query_description = query;
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
