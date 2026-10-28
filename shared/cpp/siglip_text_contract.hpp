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
}  // namespace ainvr::text
