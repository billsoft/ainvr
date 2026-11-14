#pragma once
// int8 vectors for the published shard files. Each view of a record is unit-norm
// (NormalizeViews) and quantized symmetrically with its own scale, about 4x smaller
// than float32. Measured on .190 vectors: an int8 coarse pass over 200 candidate
// groups followed by exact float rescoring returns the same top 20 as float32.
#include "vector_index.hpp"
#include <openssl/sha.h>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace ainvr::search {
using GroupKey = std::array<unsigned char, 16>;
// One grouping rule for shard rows and rows read from Mongo: an object track, or a
// single scene sample. Both sides must use this function or one group splits in two.
inline GroupKey RecordGroup(const Record& record) {
  const std::string key = record.scene ? "scene\n" + record.id
      : "object\n" + record.channel + "\n" + record.processor + "\n" + record.session + "\n" + record.track;
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(key.data()), key.size(), digest);
  GroupKey out{}; std::memcpy(out.data(), digest, out.size()); return out;
}
// `normalized` holds `views` unit-norm blocks. Writes views*per int8 values and views scales.
inline void QuantizeViews(const std::vector<float>& normalized, size_t views, int8_t* out, float* scales) {
  if (!views || normalized.empty() || normalized.size() % views) throw std::invalid_argument("vector_dimensions");
  const size_t per = normalized.size() / views;
  for (size_t v = 0; v < views; ++v) {
    const float* block = normalized.data() + v * per;
    float peak = 0;
    for (size_t i = 0; i < per; ++i) peak = std::max(peak, std::fabs(block[i]));
    const float scale = peak > 0 ? peak / 127.0f : 0.0f;
    scales[v] = scale;
    for (size_t i = 0; i < per; ++i) {
      const long q = scale > 0 ? std::lrint(block[i] / scale) : 0;
      out[v * per + i] = int8_t(std::max(-127L, std::min(127L, q)));
    }
  }
}
// Approximate cosine of a unit-norm query view against a record's best view.
inline float CoarseBestView(const int8_t* record, const float* scales, size_t views, size_t per,
                            const float* query, size_t* best_view) {
  float best = -2; size_t chosen = 0;
  for (size_t v = 0; v < views; ++v) {
    const int8_t* block = record + v * per;
    float sum = 0;
    for (size_t i = 0; i < per; ++i) sum += float(block[i]) * query[i];
    const float score = sum * scales[v];
    if (score > best) { best = score; chosen = v; }
  }
  if (best_view) *best_view = chosen;
  return best;
}
// Exact score with the same accumulation as the float projection it replaces.
inline double ExactBestView(const std::vector<float>& normalized, size_t views, const std::vector<float>& query,
                            size_t* best_view) {
  const size_t per = query.size();
  if (!views || normalized.size() != per * views) throw std::invalid_argument("vector_dimensions");
  double best = -2; size_t chosen = 0;
  for (size_t v = 0; v < views; ++v) {
    double sum = 0;
    for (size_t i = 0; i < per; ++i) sum += double(query[i]) * normalized[v * per + i];
    if (sum > best) { best = sum; chosen = v; }
  }
  if (best_view) *best_view = chosen;
  return best;
}
}  // namespace ainvr::search
