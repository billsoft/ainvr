#pragma once
#include <cstddef>
#include <cstdint>
namespace ainvr::text {
// One native contract for the default complete-vocabulary so400m text tower.
// SentencePiece has another 100 USER_DEFINED sentinel pieces; they have no HBM
// embedding rows. Never infer this limit from SentencePiece's raw piece count.
inline constexpr int64_t kSiglipEmbeddingRows = 250000;
inline constexpr size_t kSiglipSequenceLength = 64;
inline constexpr int64_t kSiglipPadId = 1;
inline constexpr int64_t kSiglipEosId = 1;
inline constexpr const char* kSiglipNormalizationSpec =
    "text-hf4463-unicode13-icu70-ageguard-v1-sp-dummy0-unkprefix-eos1-pad1-embedding250000-s64x64-strict63";

// SigLIP2-base text tower (Gemma SentencePiece, 256000 embedding rows). The query is lowercased by the caller's
// contract (Python str.lower on Unicode 13, see search-service/tests/fixtures), encoded by SentencePiece without a
// dummy prefix or BOS, followed by EOS and padded with PAD. Special-token spellings in a query are literal text.
inline constexpr int64_t kSiglip2EmbeddingRows = 256000;
inline constexpr int64_t kSiglip2PadId = 0;
inline constexpr int64_t kSiglip2EosId = 1;
inline constexpr const char* kSiglip2NormalizationSpec =
    "text-gemma-lower-unicode13-icu70-ageguard-sp-dummy0-eos1-pad0-embedding256000-s64x64-strict63";
}  // namespace ainvr::text
