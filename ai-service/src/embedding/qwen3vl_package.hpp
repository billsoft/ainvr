// AINVR. Artifact names of the Qwen3-VL-Embedding-2B model package (relative to the verified model root).
#pragma once
namespace ainvr::embedding {
// Relative artifact names inside the verified model package.
inline constexpr const char* kVisionHbm[4] = {"hbm/qwen3vl-emb-vis-0.hbm", "hbm/qwen3vl-emb-vis-1.hbm", "hbm/qwen3vl-emb-vis-2.hbm", "hbm/qwen3vl-emb-vis-3.hbm"};
inline constexpr const char* kTextHbm[4] = {"hbm/qwen3vl-emb-txt-0.hbm", "hbm/qwen3vl-emb-txt-1.hbm", "hbm/qwen3vl-emb-txt-2.hbm", "hbm/qwen3vl-emb-txt-3.hbm"};
inline constexpr const char* kHeadHbm = "hbm/qwen3vl-emb-head.hbm";
inline constexpr const char* kEmbedTable = "data/qwen3vl-embed-tokens-bf16.bin";
inline constexpr const char* kVisionRope = "data/qwen3vl-vision-rope.f32";
inline constexpr const char* kPrefixKv = "data/qwen3vl-prefix-kv.f32";
inline constexpr const char* kVocabJson = "tokenizers/qwen3vl-vocab.json";
inline constexpr const char* kMergesTxt = "tokenizers/qwen3vl-merges.txt";
inline constexpr int kVocabRows = 151936;
}  // namespace ainvr::embedding
