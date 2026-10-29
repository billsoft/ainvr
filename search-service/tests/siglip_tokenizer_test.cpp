#include "siglip_tokenizer.hpp"
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <unicode/utf8.h>
#include <array>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <functional>

using ainvr::search::SiglipTextTokenizer;
namespace {
void Require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::string Read(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("fixture_file_missing");
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
std::string Hex(const unsigned char* bytes, size_t length) {
  std::ostringstream result; result << std::hex << std::setfill('0');
  for (size_t i = 0; i < length; ++i) result << std::setw(2) << unsigned(bytes[i]);
  return result.str();
}
std::string Hash(const std::string& bytes) {
  unsigned char hash[EVP_MAX_MD_SIZE]; unsigned int size = 0;
  Require(EVP_Digest(bytes.data(), bytes.size(), hash, &size, EVP_sha256(), nullptr) == 1, "digest_failed");
  return Hex(hash, size);
}
void Error(const std::function<void()>& fn, const std::string& expected) {
  try { fn(); } catch (const ainvr::text::TokenizerError& e) {
    Require(e.what() == expected, "wrong_tokenizer_error"); return;
  }
  throw std::runtime_error("expected_tokenizer_error");
}
void UnicodeDigest() {
  auto ctx = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  Require(ctx && EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) == 1, "digest_failed");
  size_t scalars = 0;
  for (uint32_t cp = 0; cp < 0x110000; ++cp) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    char input[4]; int32_t count = 0; UBool invalid = false;
    U8_APPEND(input, count, 4, cp, invalid); Require(!invalid, "scalar_invalid");
    const auto normalized = SiglipTextTokenizer::NormalizeForTokenization(std::string(input, size_t(count))).substr(3);
    unsigned char header[8];
    const auto size = uint32_t(normalized.size());
    for (size_t i = 0; i < 4; ++i) { header[i] = (cp >> (24 - 8*i)) & 255; header[i+4] = (size >> (24-8*i)) & 255; }
    Require(EVP_DigestUpdate(ctx.get(), header, 8) == 1 &&
      EVP_DigestUpdate(ctx.get(), normalized.data(), normalized.size()) == 1, "digest_failed");
    ++scalars;
  }
  unsigned char hash[EVP_MAX_MD_SIZE]; unsigned int size = 0;
  Require(EVP_DigestFinal_ex(ctx.get(), hash, &size) == 1, "digest_failed");
  std::cout << nlohmann::json{{"valid_scalars", scalars}, {"sha256", Hex(hash, size)}} << '\n';
}
// Same framing as make_gemma_tokenizer_golden.py: every valid scalar, lowercased on its own.
void GemmaUnicodeDigest() {
  auto ctx = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  Require(ctx && EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) == 1, "digest_failed");
  size_t scalars = 0;
  for (uint32_t cp = 0; cp < 0x110000; ++cp) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    char input[4]; int32_t count = 0; UBool invalid = false;
    U8_APPEND(input, count, 4, cp, invalid); Require(!invalid, "scalar_invalid");
    const auto lowered = SiglipTextTokenizer::NormalizeForGemma(std::string(input, size_t(count)));
    unsigned char header[8];
    const auto size = uint32_t(lowered.size());
    for (size_t i = 0; i < 4; ++i) { header[i] = (cp >> (24 - 8*i)) & 255; header[i+4] = (size >> (24-8*i)) & 255; }
    Require(EVP_DigestUpdate(ctx.get(), header, 8) == 1 &&
      EVP_DigestUpdate(ctx.get(), lowered.data(), lowered.size()) == 1, "digest_failed");
    ++scalars;
  }
  unsigned char hash[EVP_MAX_MD_SIZE]; unsigned int size = 0;
  Require(EVP_DigestFinal_ex(ctx.get(), hash, &size) == 1, "digest_failed");
  std::cout << nlohmann::json{{"valid_scalars", scalars}, {"sha256", Hex(hash, size)}} << '\n';
}
// SigLIP2 (Gemma) golden rows: lower -> SentencePiece -> eos -> pad, >64 is an error.
void GemmaGolden(const std::string& bytes, const nlohmann::json& golden, const std::string& package) {
  SiglipTextTokenizer tokenizer(bytes, package);
  size_t originals = 0, boundaries = 0, ids = 0, rejected = 0;
  for (const auto& row : golden.at("rows")) {
    const auto text = row.at("text").get<std::string>();
    Require(SiglipTextTokenizer::NormalizeForGemma(text) == row.at("normalized").get<std::string>(), "normalization_parity_failed");
    if (row.at("expected_error").is_null()) {
      const auto actual = tokenizer.Encode64(text);
      Require(nlohmann::json(actual.ids) == row.at("ids"), "token_parity_failed");
      Require(actual.tokens == row.at("raw_ids").size() + 1, "length_parity_failed");
      ids += actual.ids.size();
    } else {
      Error([&] { tokenizer.Encode64(text); }, row.at("expected_error").get<std::string>());
      ++rejected;
    }
    if (row.at("group") == "original") ++originals; else ++boundaries;
  }
  for (const auto& bad : {std::string("\xc0\xaf", 2), std::string("\xed\xa0\x80",3), std::string("\xf4\x90\x80\x80",4),
        std::string("\xf0\x9f",2), std::string("\x80",1)})
    Error([&] { tokenizer.Encode64(bad); }, "tokenizer_invalid_utf8");
  Error([&] { tokenizer.Encode64(std::string(4097, 'a')); }, "tokenizer_input_too_large");
  Error([&] { SiglipTextTokenizer wrong(bytes, "siglip2-base-pruned-int8"); }, "tokenizer_package_unsupported");
  Error([&] { SiglipTextTokenizer wrong("not a protobuf model", package); }, "tokenizer_model_invalid");
  // A query can never inject a special id: the spelling is ordinary text.
  const auto literal = tokenizer.Encode64("<eos> <pad>");
  Require(literal.tokens > 2 && literal.ids[0] != 1 && literal.ids[0] != 0, "special_token_injection");
  std::cout << nlohmann::json{{"original_rows", originals}, {"boundary_rows", boundaries},
    {"matching_padded_tokens", ids}, {"expected_rejections", rejected},
    {"spec", ainvr::search::kSiglip2TextSpec}} << '\n';
}
}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--unicode-digest") { UnicodeDigest(); return 0; }
    if (argc == 2 && std::string(argv[1]) == "--unicode-digest-gemma") { GemmaUnicodeDigest(); return 0; }
    if (argc != 3 && argc != 4) throw std::runtime_error("usage_model_and_golden_required");
    const std::string package = argc == 4 ? argv[3] : "siglip-so400m-i18n-full-int8";
    const auto bytes = Read(argv[1]); const auto golden = nlohmann::json::parse(Read(argv[2]));
    Require(Hash(bytes) == golden.at("model_sha256").get<std::string>(), "model_hash_changed");
    if (package == "siglip2-base-full-int8") { GemmaGolden(bytes, golden, package); return 0; }
    SiglipTextTokenizer tokenizer(bytes, package);
    size_t originals = 0, boundaries = 0, ids = 0, rejected = 0;
    for (const auto& row : golden.at("rows")) {
      const auto text = row.at("text").get<std::string>();
      Require(SiglipTextTokenizer::NormalizeForTokenization(text) == row.at("normalized").get<std::string>(), "normalization_parity_failed");
      if (row.at("expected_error").is_null()) {
        const auto actual = tokenizer.Encode64(text);
        Require(nlohmann::json(actual.ids) == row.at("ids"), "token_parity_failed");
        Require(actual.tokens == row.at("raw_ids").size(), "length_parity_failed");
        ids += actual.ids.size();
      } else {
        Error([&] { tokenizer.Encode64(text); }, row.at("expected_error").get<std::string>());
        ++rejected;
      }
      if (row.at("group") == "original") ++originals; else ++boundaries;
    }
    for (const auto& bad : {std::string("\xc0\xaf", 2), std::string("\xed\xa0\x80",3),
          std::string("\xf4\x90\x80\x80",4), std::string("\xf0\x9f",2), std::string("\x80",1)})
      Error([&] { tokenizer.Encode64(bad); }, "tokenizer_invalid_utf8");
    Error([&] { tokenizer.Encode64(std::string(4097, 'a')); }, "tokenizer_input_too_large");
    Error([&] { SiglipTextTokenizer wrong(bytes, "siglip-so400m-i18n-pruned-int8"); }, "tokenizer_package_unsupported");
    Error([&] { ainvr::text::CheckedSentencePiece("", false); }, "tokenizer_model_invalid");
    Error([&] { ainvr::text::CheckedSentencePiece("not a protobuf model", false); }, "tokenizer_model_invalid");
    auto raw = ainvr::text::CheckedSentencePiece(bytes, false);
    Require(raw->GetVocabSize() == 250100, "wrong_sp_vocab");
    Require(raw->TokenToId("<unk>") == 2 && raw->TokenToId("not-an-existing-token-xyz") == -1, "token_lookup_contract");
    Require(raw->IdToToken(-1).empty() && raw->IdToToken(250100).empty(), "id_lookup_contract");
    Error([&] { raw->Decode({-1}); }, "tokenizer_token_out_of_range");
    Error([&] { raw->Decode({250100}); }, "tokenizer_token_out_of_range");
    Require(!raw->Decode(raw->Encode("person")).empty(), "checked_decode_failed");
    std::cout << nlohmann::json{{"original_rows", originals}, {"boundary_rows", boundaries},
      {"matching_padded_tokens", ids}, {"expected_rejections", rejected},
      {"spec", ainvr::search::kSiglipTextSpec}} << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
