#pragma once
#include "checked_sentencepiece_tokenizer.hpp"
#include "../../shared/cpp/siglip_text_contract.hpp"
#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace ainvr::search {
inline constexpr const char* kSiglipTextSpec = ainvr::text::kSiglipNormalizationSpec;
inline constexpr const char* kSiglip2TextSpec = ainvr::text::kSiglip2NormalizationSpec;

struct SiglipTokenIds {
  std::array<int64_t, ainvr::text::kSiglipSequenceLength> ids{};
  size_t tokens = 0;  // Includes final EOS; excludes padding.
};

// Only the checked, complete so400m and SigLIP2-base packages are supported here (no pruned packages). Model bytes must
// come from VerifiedPackage's held descriptor, never an HTTP-provided path.
class SiglipTextTokenizer {
 public:
  explicit SiglipTextTokenizer(const std::string& model_blob,
      const std::string& package_id = "siglip2-base-full-int8");
  SiglipTokenIds Encode64(const std::string& text);
  // Exposed for software parity tests. No token truncation or replacement.
  static std::string NormalizeForTokenization(const std::string& text);
  // SigLIP2 (Gemma): Python str.lower() equivalent, Unicode 13 behaviour. Exposed for parity tests.
  static std::string NormalizeForGemma(const std::string& text);
 private:
  std::unique_ptr<tokenizers::Tokenizer> tokenizer_;
  size_t unk_prefix_tokens_ = 0;
  bool gemma_ = false;
};
}  // namespace ainvr::search
