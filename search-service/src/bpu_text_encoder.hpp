#pragma once
#include "http_service.hpp"
#include "model_package.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ainvr::search {
// Fixed measured profile for one specific complete-vocabulary text HBM.
// measured.ion_mb=972 in its sidecar and README section 8; file size is not ION.
inline constexpr uint64_t kSo400mTextReservationBytes = 972ULL * 1024 * 1024;
inline constexpr const char* kSo400mTextMeasuredSha256 =
    "b4d759a179dc037f05df781bcce77aec3d5263cf8bd65efb26169a7cc234bfe0";

struct BpuTextLoadOptions {
  // Deployment-controlled only. Never accept a directory/budget from HTTP.
  std::string reservation_directory = "/run/ainvr";
  uint64_t total_bytes = 7680ULL * 1024 * 1024;
  uint64_t headroom_bytes = 512ULL * 1024 * 1024;
};

// Pure software boundaries used both by the adapter and its contract tests.
// They do not create BPU tasks or claim numerical model validation.
void ValidateBpuTextDescription(const nlohmann::json& description, const PackageSpec& spec);
// Metadata/profile check only; Load additionally revalidates held descriptors
// under the reservation. A matching SHA is not a quality/readiness certificate.
uint64_t BpuTextReservationBytes(const VerifiedPackage& package);
std::vector<float> DecodeBpuTextEmbedding(const std::vector<unsigned char>& bytes,
                                        const nlohmann::json& output_descriptor,
                                        const PackageSpec& spec);

class BpuTextEncoder final : public TextEncoder {
 public:
  // Acquires the REAL shared exclusive reservation before constructing BpuModel.
  // Current Qwen residency therefore rejects with large_model_busy; there is no
  // automatic unload, model switch, budget reduction or CPU fallback.
  static std::unique_ptr<BpuTextEncoder> Load(VerifiedPackage package,
                                            const BpuTextLoadOptions& options = {});
  ~BpuTextEncoder() override;
  BpuTextEncoder(const BpuTextEncoder&) = delete;
  BpuTextEncoder& operator=(const BpuTextEncoder&) = delete;
  std::string ModelVersion() const override;
  size_t Dimensions() const override;
  // No internal task queue. Overlap is rejected, not accumulated. Callers drain
  // their existing HTTP generation before destroying this object.
  std::vector<float> Encode(const std::string& text) override;
 private:
  struct Impl;
  explicit BpuTextEncoder(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}  // namespace ainvr::search
