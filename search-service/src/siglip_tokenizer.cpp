#include "siglip_tokenizer.hpp"
#include <unicode/uchar.h>
#include <unicode/ustring.h>
#include <unicode/utf8.h>
#include <unicode/utf16.h>
#include <unicode/uversion.h>
#include <algorithm>
#include <cstring>
#include <vector>

namespace ainvr::search {
namespace {
using ainvr::text::TokenizerError;
constexpr size_t kMaxInputBytes = 4096;
constexpr auto kEmbeddingRows = ainvr::text::kSiglipEmbeddingRows;
const std::string kUnderline = "\xE2\x96\x81";
bool Space(UChar32 cp) { return u_isWhitespace(cp) || u_isUWhiteSpace(cp); }
void AppendUtf8(std::string& out, UChar32 cp) {
  char encoded[4]; int32_t n = 0; UBool error = false;
  U8_APPEND(encoded, n, 4, cp, error);
  if (error) throw TokenizerError("tokenizer_invalid_utf8");
  out.append(encoded, size_t(n));
}
std::string Trim(const std::string& value, bool left, bool right) {
  int32_t from = 0, end = int32_t(value.size());
  if (left) while (from < end) {
    auto next = from; UChar32 cp; U8_NEXT(value.data(), next, end, cp);
    if (!Space(cp)) break;
    from = next;
  }
  if (right) while (end > from) {
    auto previous = end; UChar32 cp; U8_PREV(value.data(), from, previous, cp);
    if (!Space(cp)) break;
    end = previous;
  }
  return value.substr(size_t(from), size_t(end - from));
}
std::string Canonicalize(const std::string& text) {
  // HF removes ASCII string.punctuation only, before SP's NFKC. In particular,
  // full-width punctuation is not removed here and can form sentinel pieces.
  constexpr const char* punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  std::string out; bool pending_space = false;
  int32_t at = 0; const auto length = int32_t(text.size());
  while (at < length) {
    UChar32 cp; U8_NEXT(text.data(), at, length, cp);
    if (cp > 0 && cp < 128 && std::strchr(punctuation, char(cp))) continue;
    if (Space(cp)) { if (!out.empty()) pending_space = true; continue; }
    if (pending_space) out += ' ';
    pending_space = false; AppendUtf8(out, cp);
  }
  return out;
}
void LowerScalar(std::string& out, UChar32 cp) {
  UVersionInfo age{}; u_charAge(cp, age);
  // HF4.46.3 was exported with Python3.10/Unicode13. Its lazy regex lowercases
  // one scalar at a time. Later-assigned characters were unchanged in that
  // runtime; retain them, rather than applying newer casing or rejecting them.
  if (age[0] > 13) { AppendUtf8(out, cp); return; }
  UChar input[2]; int32_t n = 0; U16_APPEND_UNSAFE(input, n, cp);
  UChar lowered[16]; UErrorCode status = U_ZERO_ERROR;
  const auto count = u_strToLower(lowered, 16, input, n, "", &status);
  if (U_FAILURE(status) || count < 0 || count > 16)
    throw TokenizerError("tokenizer_normalization_failed");
  int32_t at = 0;
  while (at < count) { UChar32 next; U16_NEXT(lowered, at, count, next); AppendUtf8(out, next); }
}
}  // namespace

SiglipTextTokenizer::SiglipTextTokenizer(const std::string& blob, const std::string& package) {
  if (package != "siglip-so400m-i18n-full-int8")
    throw TokenizerError("tokenizer_package_unsupported");
  UVersionInfo icu{}, unicode{}; u_getVersion(icu); u_getUnicodeVersion(unicode);
  if (icu[0] != 70 || unicode[0] != 14)
    throw TokenizerError("tokenizer_unicode_version_unsupported");
  tokenizer_ = ainvr::text::CheckedSentencePiece(blob, false);
  if (tokenizer_->GetVocabSize() != 250100 || tokenizer_->TokenToId("</s>") != ainvr::text::kSiglipEosId ||
      tokenizer_->TokenToId("<unk>") != 2)
    throw TokenizerError("tokenizer_model_incompatible");
  unk_prefix_tokens_ = tokenizer_->Encode("<unk>").size();
  if (!unk_prefix_tokens_ || unk_prefix_tokens_ > 16)
    throw TokenizerError("tokenizer_model_incompatible");
}

std::string SiglipTextTokenizer::NormalizeForTokenization(const std::string& text) {
  if (text.size() > kMaxInputBytes) throw TokenizerError("tokenizer_input_too_large");
  ainvr::text::RequireUtf8(text);
  std::string out = kUnderline;
  int32_t at = 0; const auto length = int32_t(text.size());
  while (at < length) {
    UChar32 cp; U8_NEXT(text.data(), at, length, cp);
    if (cp == 0x2581) out += ' '; else LowerScalar(out, cp);
  }
  return out;
}

SiglipTokenIds SiglipTextTokenizer::Encode64(const std::string& text) {
  const auto normalized = NormalizeForTokenization(text);
  struct Part { std::string text; int32_t special = -1; };
  std::vector<Part> parts;
  size_t at = 0;
  while (at < normalized.size()) {
    const auto eos = normalized.find("</s>", at), unk = normalized.find("<unk>", at);
    const auto next = std::min(eos, unk);
    if (next == std::string::npos) { parts.push_back({normalized.substr(at), -1}); break; }
    if (next > at) parts.push_back({normalized.substr(at, next - at), -1});
    const bool is_eos = next == eos;
    parts.push_back({{}, is_eos ? int32_t(ainvr::text::kSiglipEosId) : 2});
    at = next + (is_eos ? 4 : 5);
  }
  // HF AddedToken(lstrip=true,rstrip=true) strips adjacent whitespace prior to
  // per-segment canonicalization. The leading underline itself is not space.
  for (size_t i = 0; i < parts.size(); ++i) if (parts[i].special >= 0) {
    if (i && parts[i - 1].special < 0) parts[i - 1].text = Trim(parts[i - 1].text, false, true);
    if (i + 1 < parts.size() && parts[i + 1].special < 0) parts[i + 1].text = Trim(parts[i + 1].text, true, false);
  }
  std::vector<int32_t> ids;
  for (const auto& part : parts) {
    if (part.special >= 0) { ids.push_back(part.special); continue; }
    if (part.text.empty()) continue;
    auto encoded = tokenizer_->Encode("<unk>" + Canonicalize(part.text));
    if (encoded.size() >= unk_prefix_tokens_) encoded.erase(encoded.begin(), encoded.begin() + unk_prefix_tokens_);
    ids.insert(ids.end(), encoded.begin(), encoded.end());
  }
  if (ids.size() > 1 && tokenizer_->IdToToken(ids[0]) == kUnderline && (ids[1] == ainvr::text::kSiglipEosId || ids[1] == 2))
    ids.erase(ids.begin());
  for (const auto id : ids) if (id < 0 || id >= kEmbeddingRows)
    throw TokenizerError("tokenizer_embedding_token_out_of_range");
  if (ids.empty() || ids.back() != ainvr::text::kSiglipEosId) ids.push_back(int32_t(ainvr::text::kSiglipEosId));
  if (ids.size() > ainvr::text::kSiglipSequenceLength) throw TokenizerError("tokenizer_query_too_long");
  SiglipTokenIds result; result.ids.fill(ainvr::text::kSiglipPadId); result.tokens = ids.size();
  std::copy(ids.begin(), ids.end(), result.ids.begin());
  return result;
}
}  // namespace ainvr::search
