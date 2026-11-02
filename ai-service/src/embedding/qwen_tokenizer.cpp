#include "embedding/qwen_tokenizer.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <sstream>

namespace ainvr::embedding {
namespace {
#include "embedding/qwen_unicode_tables.inc"
template <size_t N>
bool InRanges(const uint32_t (&table)[N][2], uint32_t cp) {
  size_t lo = 0, hi = N;
  while (lo < hi) {
    const size_t mid = (lo + hi) / 2;
    if (cp < table[mid][0]) hi = mid;
    else if (cp > table[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}
bool IsLetter(uint32_t cp) { return InRanges(kLetterRanges, cp); }
bool IsNumber(uint32_t cp) { return InRanges(kNumberRanges, cp); }
bool IsSpace(uint32_t cp) {
  return (cp >= 9 && cp <= 13) || cp == 32 || cp == 0x85 || cp == 0xA0 || cp == 0x1680 ||
         (cp >= 0x2000 && cp <= 0x200A) || cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000;
}
bool IsNewline(uint32_t cp) { return cp == '\r' || cp == '\n'; }

// Strict UTF-8 decode; `offsets` gets one byte offset per code point plus the end.
std::vector<uint32_t> Decode(std::string_view s, std::vector<size_t>& offsets) {
  std::vector<uint32_t> out;
  size_t i = 0;
  while (i < s.size()) {
    const unsigned char b = static_cast<unsigned char>(s[i]);
    uint32_t cp;
    size_t len;
    if (b < 0x80) { cp = b; len = 1; }
    else if (b >= 0xC2 && b <= 0xDF) { cp = b & 0x1F; len = 2; }
    else if (b >= 0xE0 && b <= 0xEF) { cp = b & 0x0F; len = 3; }
    else if (b >= 0xF0 && b <= 0xF4) { cp = b & 0x07; len = 4; }
    else throw TokenizerError("tokenizer_invalid_utf8");
    if (i + len > s.size()) throw TokenizerError("tokenizer_invalid_utf8");
    for (size_t k = 1; k < len; ++k) {
      const unsigned char c = static_cast<unsigned char>(s[i + k]);
      if ((c & 0xC0) != 0x80) throw TokenizerError("tokenizer_invalid_utf8");
      cp = (cp << 6) | (c & 0x3F);
    }
    if ((len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)))
      throw TokenizerError("tokenizer_invalid_utf8");
    offsets.push_back(i);
    out.push_back(cp);
    i += len;
  }
  offsets.push_back(s.size());
  return out;
}

std::string Utf8(uint32_t cp) {
  std::string s;
  if (cp < 0x80) s += char(cp);
  else if (cp < 0x800) { s += char(0xC0 | (cp >> 6)); s += char(0x80 | (cp & 0x3F)); }
  else { s += char(0xE0 | (cp >> 12)); s += char(0x80 | ((cp >> 6) & 0x3F)); s += char(0x80 | (cp & 0x3F)); }
  return s;
}

// End (exclusive) of the Qwen2 pre-tokenizer match starting at `i`:
// (?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
size_t Match(const std::vector<uint32_t>& c, size_t i) {
  const size_t n = c.size();
  auto lower = [&](size_t k) { return (c[k] >= 'A' && c[k] <= 'Z') ? c[k] + 32 : c[k]; };
  if (c[i] == '\'' && i + 1 < n) {
    const uint32_t a = lower(i + 1);
    if (a == 's' || a == 't' || a == 'm' || a == 'd') return i + 2;
    if (i + 2 < n) {
      const uint32_t b = lower(i + 2);
      if ((a == 'r' && b == 'e') || (a == 'v' && b == 'e') || (a == 'l' && b == 'l')) return i + 3;
    }
  }
  size_t j = i;
  if (!IsLetter(c[j]) && !IsNewline(c[j]) && !IsNumber(c[j]) && j + 1 < n && IsLetter(c[j + 1])) ++j;
  if (IsLetter(c[j])) {
    while (j < n && IsLetter(c[j])) ++j;
    return j;
  }
  if (IsNumber(c[i])) return i + 1;
  j = i;
  if (c[j] == ' ') ++j;
  size_t k = j;
  while (k < n && !IsSpace(c[k]) && !IsLetter(c[k]) && !IsNumber(c[k])) ++k;
  if (k > j) {
    while (k < n && IsNewline(c[k])) ++k;
    return k;
  }
  if (IsSpace(c[i])) {
    size_t e = i;
    while (e < n && IsSpace(c[e])) ++e;
    for (size_t p = e; p > i; --p)
      if (IsNewline(c[p - 1])) return p;
    if (e == n) return e;
    if (e - 1 > i) return e - 1;
    return e;
  }
  return i + 1;
}
}  // namespace

QwenTokenizer::QwenTokenizer(const std::string& vocab_json, const std::string& merges_txt) {
  try {
    const auto json = nlohmann::json::parse(vocab_json);
    vocab_.reserve(json.size() * 2);
    for (auto it = json.begin(); it != json.end(); ++it) vocab_.emplace(it.key(), it.value().get<int32_t>());
  } catch (const nlohmann::json::exception&) { throw TokenizerError("tokenizer_vocab_invalid"); }
  std::istringstream lines(merges_txt);
  std::string line;
  int32_t rank = 0;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line.rfind("#version", 0) == 0) continue;  // header only: merges such as '# ,' are real
    ranks_.emplace(line, rank++);
  }
  if (vocab_.size() < 100000 || ranks_.size() < 100000) throw TokenizerError("tokenizer_vocab_invalid");
  // GPT-2 bytes_to_unicode.
  std::vector<int> printable;
  for (int b = '!'; b <= '~'; ++b) printable.push_back(b);
  for (int b = 0xA1; b <= 0xAC; ++b) printable.push_back(b);
  for (int b = 0xAE; b <= 0xFF; ++b) printable.push_back(b);
  bool has[256] = {};
  for (int b : printable) { has[b] = true; byte_char_[b] = Utf8(uint32_t(b)); }
  uint32_t extra = 0;
  for (int b = 0; b < 256; ++b) if (!has[b]) byte_char_[b] = Utf8(256 + extra++);
}

void QwenTokenizer::Word(const std::string& bytes, std::vector<int32_t>& out) const {
  std::vector<std::string> parts;
  parts.reserve(bytes.size());
  for (unsigned char b : bytes) parts.push_back(byte_char_[b]);
  while (parts.size() > 1) {
    int32_t best = INT32_MAX;
    size_t at = 0;
    for (size_t k = 0; k + 1 < parts.size(); ++k) {
      const auto it = ranks_.find(parts[k] + ' ' + parts[k + 1]);
      if (it != ranks_.end() && it->second < best) { best = it->second; at = k; }
    }
    if (best == INT32_MAX) break;
    parts[at] += parts[at + 1];
    parts.erase(parts.begin() + at + 1);
  }
  for (const auto& piece : parts) {
    const auto it = vocab_.find(piece);
    if (it == vocab_.end()) throw TokenizerError("tokenizer_piece_unknown");
    out.push_back(it->second);
  }
}

std::vector<int32_t> QwenTokenizer::Encode(std::string_view utf8) const {
  if (utf8.size() > 65536) throw TokenizerError("tokenizer_input_too_large");
  std::vector<size_t> offsets;
  const auto cps = Decode(utf8, offsets);
  std::vector<int32_t> out;
  size_t i = 0;
  while (i < cps.size()) {
    const size_t end = Match(cps, i);
    Word(std::string(utf8.substr(offsets[i], offsets[end] - offsets[i])), out);
    i = end;
  }
  return out;
}

namespace {
void Append(std::vector<int32_t>& out, const std::vector<int32_t>& more) { out.insert(out.end(), more.begin(), more.end()); }
}  // namespace

std::vector<int32_t> BuildQueryIds(const QwenTokenizer& tokenizer, std::string_view text, size_t max_tokens) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) text.remove_suffix(1);
  if (text.empty()) throw TokenizerError("tokenizer_query_empty");
  if (text.size() > 4096) throw TokenizerError("tokenizer_input_too_large");
  std::vector<int32_t> ids{kImStart};
  Append(ids, tokenizer.Encode(std::string("system\n") + kQueryInstruction));
  ids.push_back(kImEnd);
  Append(ids, tokenizer.Encode("\n"));
  ids.push_back(kImStart);
  Append(ids, tokenizer.Encode(std::string("user\n") + std::string(text)));
  ids.push_back(kImEnd);
  Append(ids, tokenizer.Encode("\n"));
  ids.push_back(kImStart);
  Append(ids, tokenizer.Encode("assistant\n"));
  ids.push_back(kEndOfText);
  if (ids.size() > max_tokens) throw TokenizerError("tokenizer_query_too_long");
  return ids;
}

std::vector<int32_t> BuildImageIds(const QwenTokenizer& tokenizer, size_t image_tokens) {
  std::vector<int32_t> ids{kImStart};
  Append(ids, tokenizer.Encode(std::string("system\n") + kDocumentInstruction));
  ids.push_back(kImEnd);
  Append(ids, tokenizer.Encode("\n"));
  ids.push_back(kImStart);
  Append(ids, tokenizer.Encode("user\n"));
  ids.push_back(kVisionStart);
  ids.insert(ids.end(), image_tokens, kImagePad);
  ids.push_back(kVisionEnd);
  ids.push_back(kImEnd);
  Append(ids, tokenizer.Encode("\n"));
  ids.push_back(kImStart);
  Append(ids, tokenizer.Encode("assistant\n"));
  ids.push_back(kEndOfText);
  return ids;
}

}  // namespace ainvr::embedding
