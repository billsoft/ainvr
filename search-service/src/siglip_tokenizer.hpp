#pragma once
#include "checked_sentencepiece_tokenizer.hpp"
#include "../../shared/cpp/siglip_text_contract.hpp"
#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace ainvr::search {
inline constexpr const char* kSiglipTextSpec = ainvr::text::kSiglipNormalizationSpec;

struct SiglipTokenIds {
  std::array<int64_t, ainvr::text::kSiglipSequenceLength> ids{};
  size_t tokens = 0;  // Includes final EOS; excludes padding.
};

// Only the checked, complete so400m package is supported here. Model bytes must
// come from VerifiedPackage's held descriptor, never an HTTP-provided path.
class SiglipTextTokenizer {
 public:
  explicit SiglipTextTokenizer(const std::string& model_blob,
      const std::string& package_id = "siglip-so400m-i18n-full-int8");
  SiglipTokenIds Encode64(const std::string& text);
  // Exposed for software parity tests. No token truncation or replacement.
  static std::string NormalizeForTokenization(const std::string& text);
 private:
  std::unique_ptr<tokenizers::Tokenizer> tokenizer_;
  size_t unk_prefix_tokens_ = 0;
};
}  // namespace ainvr::search
