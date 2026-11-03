#pragma once
// Result refinement applied on top of raw cosine scores, after the vector index returns its candidates.
//  - near-duplicate collapse: consecutive samples of one scene (or one track) seconds apart are the same evidence; only the best is shown.
//    The samples themselves are all kept and stay available through history.
//  - relative window (optional): the dense Qwen3-VL-Embedding space (2048-d) has unrelated pairs at 0.15-0.25 and matches at 0.3-0.47, so an
//    absolute floor alone lets the whole "best available" tail through; hits further than the window below the best one are dropped.
//    The 768-d SigLIP space scores everything within ~0.05-0.14, where a window would be meaningless, so it is disabled there.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <utility>
#include <vector>
namespace ainvr::search {
struct RankRefineOptions {
  int64_t near_duplicate_ms = 5000;
  double relative_window = 0;   // 0 disables the window
};
inline RankRefineOptions RankRefineOptionsFor(size_t dimensions) {
  RankRefineOptions options;
  if (dimensions >= 1024) options.relative_window = 0.08;
  return options;
}
// Item needs .score (double, higher is better) and .sample.record with channel, track, captured_ms and scene.
template <class Item>
void RefineRanking(std::vector<Item>& items, const RankRefineOptions& options) {
  std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.score > b.score; });
  std::vector<Item> kept;
  for (auto& item : items) {
    const auto& r = item.sample.record;
    bool duplicate = false;
    for (const auto& other : kept) {
      const auto& o = other.sample.record;
      if (o.channel == r.channel && o.scene == r.scene && (r.scene || o.track == r.track) &&
          std::llabs(o.captured_ms - r.captured_ms) <= options.near_duplicate_ms) { duplicate = true; break; }
    }
    if (!duplicate) kept.push_back(std::move(item));
  }
  if (options.relative_window > 0 && !kept.empty()) {
    const double floor = kept.front().score - options.relative_window;
    kept.erase(std::remove_if(kept.begin(), kept.end(), [&](const Item& x) { return x.score < floor; }), kept.end());
  }
  items = std::move(kept);
}
}  // namespace ainvr::search
