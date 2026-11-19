#pragma once
#include <nlohmann/json.hpp>
#include "../../shared/cpp/search_views.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
namespace ainvr::search {
inline constexpr const char* kSearchModelRoot = "/home/sunrise/ainvr/ai-service/models/search";
struct TensorSpec { std::string name, dtype; std::vector<int64_t> shape; };
struct EncoderSpec { std::string file, program; TensorSpec input, output; };
// DualTower: one vision HBM + one text HBM + SentencePiece tokenizer (SigLIP family).
// QwenEmbedding: Qwen3-VL-Embedding, nine HBM packages plus host data files, owned by one process
// (ai-service); search-service only asks that owner for text vectors.
enum class PackageKind { DualTower, QwenEmbedding };
// How a detector box becomes the model input. None: this space stores scene samples only (detector crops are
// refused). Legacy: the single-view packages' original crop (squashed, or the Qwen owner's own rule), unchanged.
// LetterboxGray127: the box keeps its aspect ratio and is centred on a grey (127) square, so one fixed square
// vision model takes tall people and wide vehicles alike (2026-11-19 offline eval: no worse than a portrait grid).
enum class ObjectCrop { None, Legacy, LetterboxGray127 };
struct PackageSpec {
  PackageKind kind = PackageKind::DualTower;
  // QwenEmbedding only: every artifact relative to the model root (HBM + sidecar, data, tokenizer).
  std::vector<std::string> embedding_artifacts;
  uint64_t reservation_bytes = 0;   // measured ION accounting for the whole package
  std::string id, title, family;
  EncoderSpec vision, text;
  std::string tokenizer;
  std::vector<std::string> tokenizer_auxiliary;
  size_t dimensions = 0;
  // Vectors stored per scene sample (see shared/cpp/search_views.hpp); the text vector has `dimensions` floats.
  size_t views = 1;
  // Detector crops: stored as ONE vector per sample (never `views`), ranked apart from scene samples and fused by rank.
  ObjectCrop object_crop = ObjectCrop::None;
  // Track slots a detector crop may use (the policy has 8): 0 = first sighting, 1 = best quality, 2..7 change/probe.
  size_t object_slots = 0;
  // Detector boxes whose short edge is under this many source pixels are not stored (0 = no floor): too little to
  // encode, and the scene views of the same frame still cover them. 2026-11-19 starting point, not calibrated.
  double object_min_short_edge_px = 0;
  // Square model input side in pixels (the vision tower's fixed grid).
  int vision_size = 256;
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
// Vectors stored per scene sample for a package id; 1 for an id this build does not know.
inline size_t PackageViews(const std::string& id) {
  try { return FindPackageSpec(id).views; } catch (...) { return 1; }
}
// Whether this space stores detector crops at all. An id this build does not know is treated like PackageViews
// does (a single-view space, which always took crops); no hardware owner can load such a package anyway.
inline bool PackageStoresObjects(const std::string& id) {
  try { const auto& spec = FindPackageSpec(id); return spec.object_crop != ObjectCrop::None && spec.object_slots > 0; }
  catch (...) { return true; }
}
// Source-pixel floor for a detector box's short edge in this space; 0 (no floor) for an unknown id.
inline double PackageObjectMinShortEdge(const std::string& id) {
  try { return FindPackageSpec(id).object_min_short_edge_px; } catch (...) { return 0; }
}
// Vectors in ONE sample of this space: a scene sample carries the package's views, a detector crop exactly one.
inline size_t SampleViews(const std::string& id, bool scene) { return scene ? PackageViews(id) : 1; }
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
  // false for VerifyPackageDeclared: large files are bound by SHA256SUMS.txt + inode identity, not rehashed.
  bool contents_hashed = true;
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
  friend VerifiedPackage VerifyEmbeddingPackage(const std::string&, const PackageSpec&, bool);
  friend bool VerifyStillCurrent(const VerifiedPackage&);
};
// Cheap identity for processes that never load weights (search-service asking the owner for text
// vectors): small files are fully hashed, large files are bound by SHA256SUMS.txt and their size.
// The loading owner always uses the full VerifyPackage; the vector-space version is identical.
VerifiedPackage VerifyPackageDeclared(const std::string& package_id);
VerifiedPackage VerifyPackageDeclaredAtTrustedRoot(const std::string& root, const std::string& package_id);
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
