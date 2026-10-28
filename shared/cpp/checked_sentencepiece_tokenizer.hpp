#pragma once
#include <cstdint>
#include <tokenizers_cpp.h>
#include <memory>
#include <stdexcept>
#include <string>

namespace ainvr::text {
// Codes never contain user text or model bytes.
class TokenizerError final : public std::runtime_error {
 public:
  explicit TokenizerError(const char* code) : std::runtime_error(code) {}
};

// Shared strict UTF-8 boundary. Unlike SentencePiece's permissive normalization,
// malformed input is an error, never replacement text.
void RequireUtf8(const std::string& text);

// Uses the existing Tokenizer abstraction, but checks every SentencePiece
// Status. No upstream factory with IgnoreError is used. The ModelProto override
// is private to this in-memory instance; the original model is never written.
std::unique_ptr<tokenizers::Tokenizer> CheckedSentencePiece(
    const std::string& model_blob, bool add_dummy_prefix);
}  // namespace ainvr::text
