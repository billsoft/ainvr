#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
namespace ainvr::search {
inline constexpr const char* kSearchModelRoot = "/home/sunrise/ainvr/ai-service/models/search";
struct TensorSpec { std::string name, dtype; std::vector<int64_t> shape; };
struct EncoderSpec { std::string file, program; TensorSpec input, output; };
struct PackageSpec {
  std::string id, title, family;
  EncoderSpec vision, text;
  std::string tokenizer;
  std::vector<std::string> tokenizer_auxiliary;
  size_t dimensions = 0;
  // HBM addressable rows, not the raw SentencePiece piece count.
  int64_t embedding_vocab_size = 0;
  bool pruned = false;
  int64_t pad_id = 0, eos_id = 1;
  // Pin numerical preprocessing; FrameRef supplies YUV matrix/range.
  std::string input_spec_version;
};
const std::vector<PackageSpec>& PackageSpecs();
const PackageSpec& FindPackageSpec(const std::string& id);
const char* DefaultPackageId();
struct VerifiedArtifact { std::string relative_path, sha256; uint64_t bytes = 0; };
struct PackageVerificationState;
// Retains stable read-only descriptors through loading. No copied raw FDs.
class VerifiedPackage {
 public:
  VerifiedPackage() = default;
  VerifiedPackage(VerifiedPackage&&) noexcept = default;
  VerifiedPackage& operator=(VerifiedPackage&&) noexcept = default;
  VerifiedPackage(const VerifiedPackage&) = delete;
  VerifiedPackage& operator=(const VerifiedPackage&) = delete;
  bool files_verified = false;
  // Sidecar claims only, NOT proof of G1, BPU execution or ION safety.
  bool production_approval_declared = false;
  const PackageSpec* spec = nullptr;
  std::string model_version;
  std::vector<VerifiedArtifact> artifacts;
  // Borrowed FD: do not close it or outlive this object.
  int BorrowedFileDescriptor(const std::string& relative_path) const;
 private:
  std::shared_ptr<PackageVerificationState> state_;
  friend VerifiedPackage VerifyPackageAtTrustedRoot(const std::string&, const std::string&);
  friend bool VerifyStillCurrent(const VerifiedPackage&);
};
// Production loader uses only the fixed-root entry point.
VerifiedPackage VerifyPackage(const std::string& package_id);
// Explicit trusted test/offline root; MUST NOT be an HTTP parameter.
VerifiedPackage VerifyPackageAtTrustedRoot(const std::string& root, const std::string& package_id);
// Recheck held descriptors and their directory entries before/after loading.
bool VerifyStillCurrent(const VerifiedPackage& package);
// Metadata inventory only: no HBM hashing, allocation or readiness certificate.
nlohmann::json InspectPackageMetadata(const std::string& trusted_root, const PackageSpec& spec);
bool PackageArtifactsPresent(const std::string& trusted_root, const PackageSpec& spec);
}  // namespace ainvr::search
