// AINVR. Qwen2/Qwen3 byte-level BPE tokenizer (vocab.json + merges.txt) and the fixed
// Qwen3-VL-Embedding prompt templates. Plain text only: user text is never parsed for
// special-token strings. Golden-tested against HuggingFace tokenizers.
#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace ainvr::embedding {

struct TokenizerError : std::runtime_error { using std::runtime_error::runtime_error; };

inline constexpr int32_t kEndOfText = 151643, kImStart = 151644, kImEnd = 151645,
    kVisionStart = 151652, kVisionEnd = 151653, kImagePad = 151655;
inline constexpr const char* kDocumentInstruction = "Represent the user's input.";
inline constexpr const char* kQueryInstruction = "Retrieve images or text relevant to the user's query.";

class QwenTokenizer {
 public:
  QwenTokenizer(const std::string& vocab_json, const std::string& merges_txt);
  // Pre-tokenizes (Qwen2 pattern) and applies BPE. Throws TokenizerError on invalid UTF-8.
  std::vector<int32_t> Encode(std::string_view utf8) const;
  size_t VocabSize() const { return vocab_.size(); }
 private:
  void Word(const std::string& bytes, std::vector<int32_t>& out) const;
  std::unordered_map<std::string, int32_t> vocab_;
  std::unordered_map<std::string, int32_t> ranks_;
  std::string byte_char_[256];
};

// Chat-template prompts of the embedding model (system instruction, user content, assistant
// generation prompt, trailing <|endoftext|>). A query of any text; `max_tokens` bounds the whole
// prompt and throws TokenizerError("tokenizer_query_too_long") above it.
std::vector<int32_t> BuildQueryIds(const QwenTokenizer&, std::string_view text, size_t max_tokens);
// Image document prompt with `image_tokens` image-pad placeholders.
std::vector<int32_t> BuildImageIds(const QwenTokenizer&, size_t image_tokens);

}  // namespace ainvr::embedding
