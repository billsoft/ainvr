// Copyright AINVR.
#pragma once
#include "snapshot_transform.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/jpeg_encoder.hpp"
#include <optional>
#include <string>
namespace ainvr {
struct EncodedSnapshot {
  SnapshotPlan plan;
  std::vector<uint8_t> jpeg;
  std::string render_backend, encoder_backend;
  std::vector<std::string> fallback_reasons;
};
// Construct and use on one worker thread. Produces the original crop only;
// brightness/restoration and archive delivery belong to the caller's next stage.
class SnapshotRenderer {
 public:
  explicit SnapshotRenderer(PreprocessorOptions options={}):images_(options),hardware_(options.dedicated_hardware){}
  // Disabled snapshots and invalid detections return nullopt. Other failures
  // propagate so the caller can retry/persist rather than silently drop a crop.
  std::optional<EncodedSnapshot> RenderOriginal(const Nv12Frame& frame,
      const std::array<double,4>& bbox,const ai_service::config::SnapshotConfig& config,
      bool square,bool bt709,bool full_range);
 private:
  ImagePreprocessor images_;
  bool hardware_;
  std::unique_ptr<JpegEncoder> jpeg_;
  std::array<int,3> jpeg_config_{};
};
}  // namespace ainvr
