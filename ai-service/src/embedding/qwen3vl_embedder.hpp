// AINVR. Qwen3-VL-Embedding-2B on the S100P BPU (9 HBM packages: 4 vision groups, 4 text groups
// of 7 layers with s1+s256 profiles, final-norm head). Single owner of all weights; image and
// text queries share the text groups. Image calls are interleaved with text queries at call
// granularity and yield to waiting queries.
#pragma once
#include "embedding/qwen3vl_host.hpp"
#include "embedding/qwen3vl_package.hpp"
#include "embedding/qwen_tokenizer.hpp"
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace ainvr { class BpuProgram; class BpuPack; }

namespace ainvr::embedding {

inline constexpr size_t kEmbeddingDimensions = 2048;
// Whole prompt (template ~36 tokens + query). The page allows 256 characters; a Chinese character is at most one token.
inline constexpr size_t kMaxQueryTokens = 320;


struct EmbeddingFiles {
  // Path usable by the SDK / open() for a verified artifact (e.g. "/proc/self/fd/N").
  std::function<std::string(const std::string&)> path;
  // Whole-file bytes for small artifacts (tokenizer).
  std::function<std::string(const std::string&)> read;
};

// Text-group profile: host chunk build, input copy+flush, BPU run, output copy (ms, summed over calls).
struct EmbeddingStats { double vision_ms = 0, text_ms = 0, total_ms = 0, build_ms = 0, set_ms = 0, run_ms = 0, get_ms = 0; int calls = 0; };

class Qwen3VlEmbedder {
 public:
  static std::unique_ptr<Qwen3VlEmbedder> Load(const EmbeddingFiles& files);
  ~Qwen3VlEmbedder();
  Qwen3VlEmbedder(const Qwen3VlEmbedder&) = delete;
  Qwen3VlEmbedder& operator=(const Qwen3VlEmbedder&) = delete;

  const QwenTokenizer& Tokenizer() const { return *tokenizer_; }
  // rgb: HWC uint8 896x448x3. Returns the L2-normalised 2048-d document vector.
  std::vector<float> EmbedImage(const uint8_t* rgb, EmbeddingStats* stats = nullptr);
  // chw: planar float32 3x448x896 already normalised with (x/255 - 0.5)/0.5 (GPU preprocessing output).
  std::vector<float> EmbedImageChw(const float* chw, EmbeddingStats* stats = nullptr);
  // Query text (UTF-8). High priority: waiting queries stop image calls at the next call boundary.
  std::vector<float> EmbedQuery(std::string_view text, EmbeddingStats* stats = nullptr);
  // Raw prompt ids (first token must be <|im_start|>); image run optional. Exposed for tests.
  std::vector<float> EmbedIds(const std::vector<int32_t>& ids, const uint8_t* rgb, bool priority, EmbeddingStats* stats = nullptr);
  std::vector<float> EmbedIdsChw(const std::vector<int32_t>& ids, const float* chw, bool priority, EmbeddingStats* stats = nullptr);
  bool Healthy() const;

 private:
  Qwen3VlEmbedder() = default;
  const std::vector<int32_t>& ImageIds() const;
  mutable std::once_flag image_ids_once_;
  mutable std::vector<int32_t> image_ids_;
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::unique_ptr<QwenTokenizer> tokenizer_;
};

}  // namespace ainvr::embedding
