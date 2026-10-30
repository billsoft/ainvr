// AINVR. Verified paired-model vision adapter; no runtime instance is created here.
#pragma once
#include "model_package.hpp"
#include "../../ai-service/src/output/snapshot_transform.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
namespace ainvr { struct Nv12Frame; }
namespace ainvr::search {
inline constexpr uint64_t kSiglip2BaseVisionReservationBytes = 103ULL * 1024 * 1024;
inline constexpr const char* kSiglip2BaseVisionMeasuredSha256 =
    "595b9b64f3bf7968949b3442f418c4cb5774d0dddcdcc04421cca330b1c99443";
// Pinned official pooler HBM measured at 537 MiB; reserve 576 MiB,
// separately from the existing allocation headroom probe.
inline constexpr uint64_t kSo400mVisionReservationBytes = 576ULL * 1024 * 1024;
inline constexpr const char* kSo400mVisionMeasuredSha256 =
    "cba12c5063090254bcd0e65f580f9eebd04cef336e7b643682b93041ddb9b71a";
struct BpuVisionLoadOptions {
  std::string reservation_directory = "/run/ainvr";
  uint64_t total_bytes = UINT64_MAX;  // optional cap; the real budget is read from the SDK (ReadBpuIonBudgetBytes)
  uint64_t headroom_bytes = 256ULL * 1024 * 1024;
};
// Pure contracts: no SDK calls, allocations on devices, files or EGL contexts.
void ValidateBpuVisionLoadOptions(const BpuVisionLoadOptions& options);
uint64_t BpuVisionReservationBytes(const VerifiedPackage& package);
void ValidateBpuVisionDescription(const nlohmann::json& description, const PackageSpec& spec);
ainvr::ImageTransform BpuVisionTransform(const ainvr::SnapshotPlan& plan,
    const PackageSpec& spec, bool bt709, bool full_range);
std::vector<float> NormalizeBpuVisionEmbedding(const std::vector<std::vector<float>>& outputs,
    const PackageSpec& spec);
struct BpuVisionResult {
  std::vector<float> embedding;
  std::string image_backend;
  double preprocess_ms = 0, inference_ms = 0, output_decode_ms = 0;
};
class BpuVisionEncoder {
 public:
  // Explicit call on the EXISTING image/GLES owner thread only. Reservation
  // precedes BpuImageRunner/model/DMA; held descriptors precede SDK path loading.
  // The shared reservation label is search-service even when this search role
  // is hosted in ai-service: accounting merges all holders by actual PID.
  static std::unique_ptr<BpuVisionEncoder> Load(VerifiedPackage package,
      const BpuVisionLoadOptions& options = {});
  ~BpuVisionEncoder();
  BpuVisionEncoder(const BpuVisionEncoder&) = delete;
  BpuVisionEncoder& operator=(const BpuVisionEncoder&) = delete;
  const std::string& ModelVersion() const;
  const std::string& InputSpecVersion() const;
  size_t Dimensions() const;
  // The caller's existing PlanSnapshot/strict SnapshotRenderer supplies this
  // same crop plan for evidence. No second crop/association/NN/thread pipeline.
  // Load, Encode and normal destruction must all occur on the same owner.
  BpuVisionResult Encode(const ainvr::Nv12Frame& frame, const ainvr::SnapshotPlan& plan,
      bool bt709, bool full_range);
 private:
  struct Impl;
  explicit BpuVisionEncoder(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}  // namespace ainvr::search
