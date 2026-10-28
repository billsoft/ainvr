// Copyright AINVR.
#pragma once
#include "snapshot_transform.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/jpeg_encoder.hpp"
#include <optional>
#include <string>
namespace ainvr {
enum class SnapshotEncodingPolicy { Compatible, HardwareOnly };
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
  explicit SnapshotRenderer(PreprocessorOptions options={},
      SnapshotEncodingPolicy policy=SnapshotEncodingPolicy::Compatible)
      :images_(CheckedOptions(options,policy)),hardware_(options.dedicated_hardware),policy_(policy){}
  // Disabled snapshots and invalid detections return nullopt. Other failures
  // propagate so the caller can retry/persist rather than silently drop a crop.
  std::optional<EncodedSnapshot> RenderOriginal(const Nv12Frame& frame,
      const std::array<double,4>& bbox,const ai_service::config::SnapshotConfig& config,
      bool square,bool bt709,bool full_range);
 private:
  static PreprocessorOptions CheckedOptions(PreprocessorOptions options, SnapshotEncodingPolicy policy) {
    if(policy==SnapshotEncodingPolicy::HardwareOnly && (!options.dedicated_hardware || options.cpu_reference))
      throw std::invalid_argument("snapshot_hardware_policy_requires_hardware");
    return options;
  }
  ImagePreprocessor images_;
  bool hardware_;
  SnapshotEncodingPolicy policy_;
  std::unique_ptr<JpegEncoder> jpeg_;
  std::array<int,3> jpeg_config_{};
};
}  // namespace ainvr
