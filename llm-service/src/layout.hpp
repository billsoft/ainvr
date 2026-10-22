#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace ainvr::llm {
constexpr int kHidden = 2560, kHeadDim = 128, kHeads = 8, kCapacity = 1024;
struct Chunk { int start, rows, profile; };
inline std::vector<Chunk> PrefillPlan(int length) {
  if (length < 1 || length > kCapacity) throw std::invalid_argument("context length");
  std::vector<Chunk> out;
  int start = 0;
  while (start < length - 1) {
    int rows = std::min(256, length - 1 - start);
    if (start + 256 > kCapacity) throw std::invalid_argument("prefill exceeds context");
    out.push_back({start, rows, 256}); start += rows;
  }
  out.push_back({length - 1, 1, 1});
  return out;
}
inline std::vector<std::array<int, 3>> Positions(const std::vector<int>& ids) {
  PrefillPlan(static_cast<int>(ids.size()));
  auto first = std::find(ids.begin(), ids.end(), 151655);
  if (first == ids.end()) throw std::invalid_argument("missing image tokens");
  int start = static_cast<int>(first - ids.begin());
  if (start + 392 > static_cast<int>(ids.size())) throw std::invalid_argument("image token count");
  std::vector<std::array<int, 3>> out(ids.size());
  for (int j = 0; j < static_cast<int>(ids.size()); ++j) {
    bool image = j >= start && j < start + 392;
    if ((ids[j] == 151655) != image) throw std::invalid_argument("image token layout");
    if (image) out[j] = {start, start + (j-start)/28, start + (j-start)%28};
    else { int p = j < start ? j : start + 28 + j-start-392; out[j] = {p,p,p}; }
  }
  return out;
}
inline void FillRope(const std::vector<std::array<int,3>>& positions, const Chunk& chunk,
                     const float* ct, const float* st, float* cos, float* sin) {
  std::fill(cos, cos + chunk.profile * 128, 1.f);
  std::fill(sin, sin + chunk.profile * 128, 0.f);
  for (int row=0; row<chunk.rows; ++row) for (int col=0; col<128; ++col) {
    int i=col%64, axis=(i<60 && i%3!=0) ? i%3 : 0;
    int p=positions.at(chunk.start+row)[axis];
    if(p<0 || p>=1024) throw std::invalid_argument("rope position exceeds table");
    cos[row*128+col]=ct[p*64+i]; sin[row*128+col]=st[p*64+i];
  }
}
inline void FillMask(const Chunk& c, float* mask) {
  std::fill(mask, mask+c.profile*1024, -96.f);
  for(int r=0;r<c.profile;++r) {
    if(r>=c.rows) { mask[r*1024+1024-c.profile]=0; continue; }
    std::fill(mask+r*1024+1024-c.profile-c.start, mask+r*1024+1024-c.profile+r+1, 0.f);
  }
}
inline double Score(float yes, float no, double temperature) {
  if(!std::isfinite(yes)||!std::isfinite(no)||!std::isfinite(temperature)||temperature<0.05||temperature>10)
    throw std::invalid_argument("invalid score inputs");
  double d=(double(yes)-double(no))/temperature;
  return d>=0 ? 1/(1+std::exp(-d)) : std::exp(d)/(1+std::exp(d));
}
} // namespace ainvr::llm
