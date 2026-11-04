#pragma once
#include "model_shape.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace ainvr::llm {
struct Chunk { int start, rows, profile; };
// Every helper takes the package's ModelShape; the default is the 4B v1 shape so v1 callers and tests are unchanged.
inline std::vector<Chunk> PrefillPlan(int length, const ModelShape& s = ModelShape{}) {
  if (length < 1 || length > s.context) throw std::invalid_argument("context length");
  std::vector<Chunk> out;
  int start = 0;
  while (start < length - 1) {
    int rows = std::min(s.prefill, length - 1 - start);
    if (start + s.prefill > s.context) throw std::invalid_argument("prefill exceeds context");
    out.push_back({start, rows, s.prefill}); start += rows;
  }
  out.push_back({length - 1, 1, 1});
  return out;
}
inline std::vector<std::array<int, 3>> Positions(const std::vector<int>& ids, const ModelShape& s = ModelShape{}) {
  PrefillPlan(static_cast<int>(ids.size()), s);
  auto first = std::find(ids.begin(), ids.end(), s.image_token_id);
  if (first == ids.end()) throw std::invalid_argument("missing image tokens");
  int start = static_cast<int>(first - ids.begin());
  if (start + s.image_tokens > static_cast<int>(ids.size())) throw std::invalid_argument("image token count");
  const int span = std::max(s.image_grid_w, s.image_tokens / s.image_grid_w);  // text resumes after the larger grid side
  std::vector<std::array<int, 3>> out(ids.size());
  for (int j = 0; j < static_cast<int>(ids.size()); ++j) {
    bool image = j >= start && j < start + s.image_tokens;
    if ((ids[j] == s.image_token_id) != image) throw std::invalid_argument("image token layout");
    if (image) out[j] = {start, start + (j-start)/s.image_grid_w, start + (j-start)%s.image_grid_w};
    else { int p = j < start ? j : start + span + j-start-s.image_tokens; out[j] = {p,p,p}; }
  }
  return out;
}
inline void FillRope(const std::vector<std::array<int,3>>& positions, const Chunk& chunk,
                     const float* ct, const float* st, float* cos, float* sin, const ModelShape& s = ModelShape{}) {
  const int d = s.head_dim, pairs = s.rope_pairs();
  std::fill(cos, cos + chunk.profile * d, 1.f);
  std::fill(sin, sin + chunk.profile * d, 0.f);
  for (int row=0; row<chunk.rows; ++row) for (int col=0; col<d; ++col) {
    int i=col%pairs, axis=(i%3==1 && i<3*s.mrope_hw[0]) ? 1 : (i%3==2 && i<3*s.mrope_hw[1]) ? 2 : 0;
    int p=positions.at(chunk.start+row)[axis];
    if(p<0 || p>=s.context) throw std::invalid_argument("rope position exceeds table");
    cos[row*d+col]=ct[p*pairs+i]; sin[row*d+col]=st[p*pairs+i];
  }
}
inline void FillMask(const Chunk& c, float* mask, const ModelShape& s = ModelShape{}) {
  const int cap = s.context;
  std::fill(mask, mask+c.profile*cap, s.mask_min);
  for(int r=0;r<c.profile;++r) {
    if(r>=c.rows) { mask[r*cap+cap-c.profile]=0; continue; }
    std::fill(mask+r*cap+cap-c.profile-c.start, mask+r*cap+cap-c.profile+r+1, 0.f);
  }
}
inline double Score(float yes, float no, double temperature) {
  if(!std::isfinite(yes)||!std::isfinite(no)||!std::isfinite(temperature)||temperature<0.05||temperature>10)
    throw std::invalid_argument("invalid score inputs");
  double d=(double(yes)-double(no))/temperature;
  return d>=0 ? 1/(1+std::exp(-d)) : std::exp(d)/(1+std::exp(d));
}
} // namespace ainvr::llm
