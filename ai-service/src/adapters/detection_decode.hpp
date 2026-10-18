// Copyright AINVR. Backend-independent decoding of validated dense tensors.
#pragma once
#include "output/result.hpp"
#include "pipeline/scale_info.hpp"
namespace ainvr {
struct DenseTensor {std::string name;std::vector<int64_t> shape;std::vector<float> values;};
struct DetectionOptions {double confidence=.25,iou=.45;int maximum=300;};
struct DetectionDecodeStats {
  uint64_t clamped_probabilities=0,clamped_distances=0,rejected_geometry=0;
};
// Process totals; malformed shapes, non-finite values and invalid classes remain fatal.
DetectionDecodeStats GetDetectionDecodeStats();
std::vector<ai_service::Detection> DecodeScrfd(const std::vector<DenseTensor>& outputs,
    const ai_service::pipeline::ScaleInfo& scale,const DetectionOptions& options={});
// Explicit contract: each row is [x1,y1,x2,y2,confidence,class_id], already NMSed.
std::vector<ai_service::Detection> DecodeEndToEnd(const DenseTensor& output,
    const ai_service::pipeline::ScaleInfo& scale,const std::vector<std::string>& classes,
    const DetectionOptions& options={});
// Raw [1,4+slots,anchors]: xywh and probabilities. Only the supplied active
// class names participate; padded slots must never become detections.
std::vector<ai_service::Detection> DecodeYoloeRaw(const DenseTensor& output,
    const ai_service::pipeline::ScaleInfo& scale,const std::vector<std::string>& active_classes,
    const DetectionOptions& options={});
}
