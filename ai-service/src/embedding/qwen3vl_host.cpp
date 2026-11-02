#include "embedding/qwen3vl_host.hpp"
#include "embedding/qwen_tokenizer.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace ainvr::embedding {

void Patchify(const uint8_t* rgb, float* out) {
  std::vector<float> chw(size_t(3) * kImageHeight * kImageWidth);
  const float scale = 1.0f / 255.0f;
  for (int y = 0; y < kImageHeight; ++y)
    for (int x = 0; x < kImageWidth; ++x)
      for (int c = 0; c < 3; ++c)
        chw[(size_t(c) * kImageHeight + y) * kImageWidth + x] = (float(rgb[(size_t(y) * kImageWidth + x) * 3 + c]) * scale - 0.5f) / 0.5f;
  PatchifyChw(chw.data(), out);
}

void PatchifyChw(const float* chw, float* out) {
  // Patch index = ((a * 28 + b) * 2 + m1) * 2 + m2; feature = ((c * 2 + t) * 16 + py) * 16 + px.
  const int blocks_h = kGridH / kMerge, blocks_w = kGridW / kMerge;
  for (int a = 0; a < blocks_h; ++a)
    for (int b = 0; b < blocks_w; ++b)
      for (int m1 = 0; m1 < kMerge; ++m1)
        for (int m2 = 0; m2 < kMerge; ++m2) {
          float* row = out + size_t(((a * blocks_w + b) * kMerge + m1) * kMerge + m2) * kPatchDim;
          const int y0 = (a * kMerge + m1) * kPatch, x0 = (b * kMerge + m2) * kPatch;
          for (int c = 0; c < 3; ++c)
            for (int py = 0; py < kPatch; ++py) {
              const float* src = chw + (size_t(c) * kImageHeight + (y0 + py)) * kImageWidth + x0;
              float* dst0 = row + ((c * kTemporal + 0) * kPatch + py) * kPatch;
              float* dst1 = row + ((c * kTemporal + 1) * kPatch + py) * kPatch;
              for (int px = 0; px < kPatch; ++px) {
                dst0[px] = src[px];
                dst1[px] = src[px];
              }
            }
        }
}

std::vector<int64_t> RopeIndex(const std::vector<int32_t>& ids) {
  const size_t L = ids.size();
  std::vector<int64_t> pos(3 * L);
  const auto first = std::find(ids.begin(), ids.end(), kImagePad);
  if (first == ids.end()) {
    for (int a = 0; a < 3; ++a)
      for (size_t i = 0; i < L; ++i) pos[a * L + i] = int64_t(i);
    return pos;
  }
  const size_t start = size_t(first - ids.begin());
  const size_t gh = kGridH / kMerge, gw = kGridW / kMerge, n = gh * gw;
  if (start + n > L || std::count(ids.begin(), ids.end(), kImagePad) != std::ptrdiff_t(n) ||
      !std::all_of(ids.begin() + start, ids.begin() + start + n, [](int32_t t) { return t == kImagePad; }))
    throw std::invalid_argument("embedding_image_tokens_invalid");
  for (int a = 0; a < 3; ++a)
    for (size_t i = 0; i < start; ++i) pos[a * L + i] = int64_t(i);
  for (size_t h = 0; h < gh; ++h)
    for (size_t w = 0; w < gw; ++w) {
      const size_t i = start + h * gw + w;
      pos[0 * L + i] = int64_t(start);
      pos[1 * L + i] = int64_t(start + h);
      pos[2 * L + i] = int64_t(start + w);
    }
  const int64_t next = int64_t(start + std::max(gh, gw) - 1) + 1;   // max over all axes of the grid block
  for (int a = 0; a < 3; ++a)
    for (size_t i = start + n; i < L; ++i) pos[a * L + i] = next + int64_t(i - start - n);
  return pos;
}

void MropeCosSin(const std::vector<int64_t>& pos, size_t L, std::vector<float>& cos, std::vector<float>& sin) {
  constexpr int half = kHeadDim / 2;
  float inv[half];
  for (int d = 0; d < half; ++d) inv[d] = 1.0f / std::pow(5000000.0f, float(2 * d) / float(kHeadDim));
  cos.assign(L * kHeadDim, 0.0f);
  sin.assign(L * kHeadDim, 0.0f);
  for (size_t i = 0; i < L; ++i) {
    for (int d = 0; d < half; ++d) {
      int axis = 0;                       // interleaved sections (T, H, W, T, H, W, ...), tail is T
      if (d % 3 == 1 && d < 60) axis = 1;
      else if (d % 3 == 2 && d < 60) axis = 2;
      const float f = float(pos[size_t(axis) * L + i]) * inv[d];
      const float c = std::cos(f), s = std::sin(f);
      cos[i * kHeadDim + d] = cos[i * kHeadDim + half + d] = c;
      sin[i * kHeadDim + d] = sin[i * kHeadDim + half + d] = s;
    }
  }
}

std::vector<Chunk> PrefillPlan(int length, int profile, int p0) {
  std::vector<Chunk> out;
  int s = p0;
  while (length - 1 - s > 0) {
    const int q = std::min(profile, length - 1 - s);
    out.push_back({s, q, profile});
    s += q;
  }
  out.push_back({length - 1, 1, 1});
  return out;
}

void BuildMask(int start, int q, int P, float* mask) {
  std::fill(mask, mask + size_t(P) * kCap, kMaskMin);
  for (int r = 0; r < q; ++r) {
    float* row = mask + size_t(r) * kCap;
    std::fill(row + (kCap - P - start), row + (kCap - P), 0.0f);
    for (int c = 0; c <= r; ++c) row[kCap - P + c] = 0.0f;
  }
  for (int r = q; r < P; ++r) std::memcpy(mask + size_t(r) * kCap, mask + size_t(q - 1) * kCap, kCap * sizeof(float));
}

}  // namespace ainvr::embedding
