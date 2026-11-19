#pragma once
// Result refinement applied on top of raw cosine scores, after the vector index returns its candidates.
//  - near-duplicate collapse: consecutive samples of one scene (or one track) seconds apart are the same evidence; only the best is shown.
//    The samples themselves are all kept and stay available through history.
//  - relative window (optional): the dense Qwen3-VL-Embedding space (2048-d) has unrelated pairs at 0.15-0.25 and matches at 0.3-0.47, so an
//    absolute floor alone lets the whole "best available" tail through; hits further than the window below the best one are dropped.
//    The 768-d SigLIP space scores everything within ~0.05-0.14, where a window would be meaningless, so it is disabled there.
#include <algorithm>
#include <set>
#include <string>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <memory>
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
// Track IDs are scoped to a processor and stream session, never a channel alone.
template <class Record>
bool SameRankEvidence(const Record& a, const Record& b, int64_t scene_window_ms) {
  if (a.channel != b.channel || a.processor != b.processor || a.session != b.session || a.scene != b.scene) return false;
  return a.scene ? std::llabs(a.captured_ms - b.captured_ms) <= scene_window_ms : a.track == b.track;
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
      if (SameRankEvidence(o, r, options.near_duplicate_ms) &&
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
// Picture query with a description: the picture ranking and the description ranking are fused by weighted reciprocal
// rank. Picture-to-picture and text-to-picture cosines live on different scales, so raw scores are never added. The
// fused score is scaled so that first place in both lists scores 1; ties keep the picture ranking's order.
// Each modality can choose a different best frame of one track. Fuse by evidence identity,
// not that frame's ID. Keep the picture representative and its original bounded evidence refs;
// do not replace its fingerprint/geometry with metadata from the other modality.
template <class Item>
std::vector<Item> FuseRankings(const std::vector<Item>& by_picture, const std::vector<Item>& by_text, double picture_weight, size_t limit) {
  constexpr double k = 20;
  std::vector<Item> fused;
  std::vector<double> scores;
  const auto add = [&](const std::vector<Item>& items, double weight) {
    std::set<size_t> voted;
    for (size_t rank = 0; rank < items.size(); ++rank) {
      const double share = weight * (k + 1) / (k + 1 + double(rank));
      auto found = std::find_if(fused.begin(), fused.end(), [&](const Item& other) {
        return SameRankEvidence(other.sample.record, items[rank].sample.record, RankRefineOptions{}.near_duplicate_ms);
      });
      const auto position = size_t(found - fused.begin());
      if (found == fused.end()) { fused.push_back(items[rank]); scores.push_back(0); }
      // At most one (the highest ranked) contribution per modality and evidence group.
      if (voted.insert(position).second) scores[position] += share;
    }
  };
  add(by_picture, picture_weight);
  add(by_text, 1 - picture_weight);
  for (size_t i = 0; i < fused.size(); ++i) fused[i].score = scores[i];
  std::stable_sort(fused.begin(), fused.end(), [](const Item& a, const Item& b) { return a.score > b.score; });
  if (fused.size() > limit) fused.resize(limit);
  return fused;
}
// A space that stores scene samples and detector crops ranks the two kinds apart (their cosines live on different
// scales: a crop is mostly the object, a scene view mostly background) and fuses the rankings by weighted reciprocal
// rank. A crop and a scene sample of the same channel captured within `merge_ms` are one result: the crop is the
// evidence (what matched) and the scene sample its context (where it was), attached as `context`.
struct SceneObjectFusion {
  // Starting points, NOT calibrated: the 2026-11-19 offline set has detector crops only. Set both from a labelled
  // set of real scene frames before relying on them.
  double object_weight = 0.6;
  int64_t merge_ms = 3000;
};
// Item needs .score, .sample.record (channel, captured_ms) and `std::shared_ptr<const Item> context`.
template <class Item>
std::vector<Item> FuseSceneAndObjects(const std::vector<Item>& scenes, const std::vector<Item>& objects,
                                      const SceneObjectFusion& options, size_t limit) {
  constexpr double k = 20;
  std::vector<Item> fused; std::vector<double> scores; std::vector<bool> merged;
  for (size_t rank = 0; rank < objects.size(); ++rank) {
    fused.push_back(objects[rank]); fused.back().context.reset();
    scores.push_back(options.object_weight * (k + 1) / (k + 1 + double(rank))); merged.push_back(false);
  }
  const size_t crops = fused.size();
  for (size_t rank = 0; rank < scenes.size(); ++rank) {
    const auto& scene = scenes[rank]; const auto& at = scene.sample.record;
    const double share = (1 - options.object_weight) * (k + 1) / (k + 1 + double(rank));
    // The nearest crop of that channel in time, which has no context yet, takes this scene sample.
    size_t best = crops;
    for (size_t i = 0; i < crops; ++i) {
      const auto& crop = fused[i].sample.record;
      const auto gap = std::llabs(crop.captured_ms - at.captured_ms);
      if (merged[i] || crop.channel != at.channel || gap > options.merge_ms) continue;
      if (best == crops || gap < std::llabs(fused[best].sample.record.captured_ms - at.captured_ms)) best = i;
    }
    if (best < crops) {
      fused[best].context = std::make_shared<const Item>(scene); merged[best] = true; scores[best] += share; continue;
    }
    fused.push_back(scene); scores.push_back(share); merged.push_back(false);
  }
  // The fused value only orders the list. Each item keeps its own cosine as `score`: the page shows it as the
  // similarity and the minimum-similarity filter applies to it (a crop's cosine for a merged crop).
  std::vector<size_t> order(fused.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return scores[a] > scores[b]; });
  std::vector<Item> out;
  for (size_t i = 0; i < order.size() && out.size() < limit; ++i) out.push_back(std::move(fused[order[i]]));
  return out;
}
}  // namespace ainvr::search
