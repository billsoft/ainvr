// Bounded metadata proof of the exact full-frame coordinate rescale already
// applied in InferOneFrame. This is not a calibration or reprojection claim.
#pragma once
#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>
namespace ai_service::sei {
inline nlohmann::json RecordingEvidenceGeometry(int ow,int oh,int ew,int eh,int64_t frame_index){
  if(ow<32||oh<32||ow>8192||oh>8192||ew<32||eh<32||ew>ow||eh>oh||frame_index<0||
      int64_t(ow)*eh!=int64_t(oh)*ew)return nullptr;
  return {{"schema","recording-frame-geometry-v1"},{"method","full_frame_axis_scale"},
    {"observation_size",{ow,oh}},{"encoded_size",{ew,eh}},{"source_frame_index",std::to_string(frame_index)}};
}
} // namespace ai_service::sei
