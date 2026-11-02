// AINVR. Host-side (CPU, data layout only) glue for Qwen3-VL-Embedding-2B on the S100P BPU:
// pixel patchify, MRoPE position ids and interleaved cos/sin, prefill plan, mask/pad layout.
// Port of the validated emb_host_v1.py; numerics compared against it by qwen3vl_host_test.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace ainvr::embedding {

inline constexpr int kImageHeight = 448, kImageWidth = 896, kPatch = 16, kMerge = 2, kTemporal = 2;
inline constexpr int kGridH = kImageHeight / kPatch, kGridW = kImageWidth / kPatch;       // 28 x 56
inline constexpr int kPatches = kGridH * kGridW;                                           // 1568
inline constexpr int kPatchDim = 3 * kTemporal * kPatch * kPatch;                          // 1536
inline constexpr int kImageTokens = kPatches / (kMerge * kMerge);                          // 392
inline constexpr int kHidden = 2048, kKvHeads = 8, kHeadDim = 128, kCap = 1024, kPrefill = 256;
inline constexpr int kLayers = 28, kGroupLayers = 7, kGroups = 4, kDeepStacks = 3;
inline constexpr int kMaxPromptTokens = 768;   // start + prefill rows must fit the 1024 KV window
inline constexpr float kMaskMin = -96.0f;

// chw: normalised planar float32 3x448x896, (x/255 - 0.5)/0.5 -> out[1568 * 1536], layout identical to Qwen2VLImageProcessor.
void PatchifyChw(const float* chw, float* out);
// rgb: HWC uint8 896x448x3, normalised exactly like the reference processor.
void Patchify(const uint8_t* rgb, float* out);

// [3][L] MRoPE positions (axis-major). Image tokens (a single run of kImageTokens) get grid positions.
std::vector<int64_t> RopeIndex(const std::vector<int32_t>& ids);

// cos/sin [L][128] float32 for positions from RopeIndex.
void MropeCosSin(const std::vector<int64_t>& pos, size_t length, std::vector<float>& cos, std::vector<float>& sin);

struct Chunk { int start, rows, profile; };
// Tokens [p0, L-1) in `profile`-row chunks, then the last (pooled) token as a 1-row call.
std::vector<Chunk> PrefillPlan(int length, int profile, int p0);

// Mask [P][1024] for a chunk at `start` with q real rows; pad rows (>=q) duplicate row q-1.
void BuildMask(int start, int q, int P, float* mask);

}  // namespace ainvr::embedding
