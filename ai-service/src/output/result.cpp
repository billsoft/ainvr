#include "result.hpp"

#include <cmath>

namespace ai_service {

namespace {
double RoundTo(double v, int decimals) {
  double f = std::pow(10.0, decimals);
  // Python round() 是平局取偶(half-to-even),std::round 是远离零——对外
  // JSON 契约要与 v1 一致,用 nearbyint(默认舍入模式即 half-to-even)。
  return std::nearbyint(v * f) / f;
}
}  // namespace

nlohmann::json FrameResult::ToDict() const {
  nlohmann::json detections_json = nlohmann::json::array();
  for (const auto& d : detections) {
    nlohmann::json dj{
        {"class_id", d.class_id},
        {"class_name", d.class_name},
        {"confidence", RoundTo(d.confidence, 4)},
        {"bbox",
         {
             {"x", RoundTo(d.bbox[0], 2)},
             {"y", RoundTo(d.bbox[1], 2)},
             {"w", RoundTo(d.bbox[2], 2)},
             {"h", RoundTo(d.bbox[3], 2)},
         }},
    };
    if (!d.confidence_known) dj["confidence"] = nullptr;
    if (!d.label_id.empty()) dj["label_id"] = d.label_id;
    if (!d.track_id.empty()) dj["track_id"] = d.track_id;
    if (!d.query_description.empty()) dj["query_description"] = d.query_description;
    if (!d.model_extra.empty()) dj["model_extra"] = d.model_extra;
    // landmarks 键只在非空时出现在 JSON 里(不是恒为 null)——跟 Python
    // 版 **({...} if d.landmarks else {}) 语义一致。
    if (d.landmarks.has_value() && !d.landmarks->empty()) {
      nlohmann::json lm = nlohmann::json::array();
      for (auto&& p : *d.landmarks) {
        lm.push_back({{"x", RoundTo(p[0], 2)}, {"y", RoundTo(p[1], 2)}});
      }
      dj["landmarks"] = std::move(lm);
    }
    detections_json.push_back(std::move(dj));
  }

  return nlohmann::json{
      {"schema_version", schema_version},
      {"channel_id", channel_id},
      {"stream_url", stream_url},
      {"stream_protocol", stream_protocol},
      {"timestamp", RoundTo(timestamp, 3)},
      {"frame_pts_ns", frame_pts_ns},
      {"frame_index", frame_index},
      {"frame_width", frame_width},
      {"frame_height", frame_height},
      {"model",
       {
           {"name", model_name},
           {"format", model_format},
           {"provider", model_provider},
           {"input_size", model_input_size},
           {"end2end", model_end2end},
           {"version", model_version},
       }},
      {"timing_ms",
       {
           {"decode", RoundTo(time_decode_ms, 2)},
           {"preprocess", RoundTo(time_preprocess_ms, 2)},
           {"inference", RoundTo(time_inference_ms, 2)},
           {"postprocess", RoundTo(time_postprocess_ms, 2)},
           {"total", RoundTo(TotalTimeMs(), 2)},
       }},
      {"task_type", task_type},
      {"detections", std::move(detections_json)},
      {"model_extra", model_extra},
  };
}

}  // namespace ai_service
