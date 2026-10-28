#include "checked_sentencepiece_tokenizer.hpp"
#include <sentencepiece_model.pb.h>
#include <sentencepiece_processor.h>
#include <unicode/utf8.h>
#include <limits>

namespace ainvr::text {
void RequireUtf8(const std::string& text) {
  if (text.size() > size_t(std::numeric_limits<int32_t>::max()))
    throw TokenizerError("tokenizer_input_too_large");
  int32_t at = 0;
  const auto length = int32_t(text.size());
  while (at < length) {
    UChar32 codepoint;
    U8_NEXT(text.data(), at, length, codepoint);
    if (codepoint < 0) throw TokenizerError("tokenizer_invalid_utf8");
  }
}
namespace {
constexpr size_t kMaxModelBytes = 64 * 1024 * 1024;
constexpr size_t kMaxTextBytes = 64 * 1024;
constexpr size_t kMaxDecodeTokens = 64 * 1024;
class Checked final : public tokenizers::Tokenizer {
 public:
  Checked(const std::string& blob, bool dummy) {
    if (blob.empty() || blob.size() > kMaxModelBytes)
      throw TokenizerError("tokenizer_model_invalid");
    auto model = std::make_unique<sentencepiece::ModelProto>();
    if (!model->ParseFromString(blob) || model->pieces_size() <= 0)
      throw TokenizerError("tokenizer_model_invalid");
    model->mutable_normalizer_spec()->set_add_dummy_prefix(dummy);
    if (!processor_.Load(std::move(model)).ok() || processor_.GetPieceSize() <= 0)
      throw TokenizerError("tokenizer_model_invalid");
  }
  std::vector<int32_t> Encode(const std::string& text) override {
    if (text.size() > kMaxTextBytes) throw TokenizerError("tokenizer_input_too_large");
    RequireUtf8(text);
    std::vector<int> ids;
    if (!processor_.Encode(text, &ids).ok()) throw TokenizerError("tokenizer_encode_failed");
    for (const auto id : ids) CheckId(id);
    return {ids.begin(), ids.end()};
  }
  std::string Decode(const std::vector<int32_t>& ids) override {
    if (ids.size() > kMaxDecodeTokens) throw TokenizerError("tokenizer_input_too_large");
    for (const auto id : ids) CheckId(id);
    const std::vector<int> native(ids.begin(), ids.end());
    std::string result;
    if (!processor_.Decode(native, &result).ok()) throw TokenizerError("tokenizer_decode_failed");
    RequireUtf8(result);
    return result;
  }
  size_t GetVocabSize() override { return size_t(processor_.GetPieceSize()); }
  std::string IdToToken(int32_t id) override {
    return id < 0 || id >= processor_.GetPieceSize() ? "" : processor_.IdToPiece(id);
  }
  int32_t TokenToId(const std::string& token) override {
    if (token.size() > kMaxTextBytes) throw TokenizerError("tokenizer_input_too_large");
    RequireUtf8(token);
    const auto id = processor_.PieceToId(token);
    return processor_.IdToPiece(id) == token ? id : -1;
  }
 private:
  void CheckId(int32_t id) const {
    if (id < 0 || id >= processor_.GetPieceSize()) throw TokenizerError("tokenizer_token_out_of_range");
  }
  sentencepiece::SentencePieceProcessor processor_;
};
}  // namespace
std::unique_ptr<tokenizers::Tokenizer> CheckedSentencePiece(const std::string& blob, bool dummy) {
  return std::make_unique<Checked>(blob, dummy);
}
}  // namespace ainvr::text
