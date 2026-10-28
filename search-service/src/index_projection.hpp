#pragma once
#include "history_mongo.hpp"
#include <mutex>
namespace ainvr::search {
struct RankedSample { Sample sample; double score; };
struct ProjectionResult {
  std::vector<RankedSample> items;
  // A resource-limited or not fully loaded window cannot report a definitive
  // negative. This is propagated to the UI's partial-coverage state.
  bool partial = false;
};
class IndexProjection {
 public:
  IndexProjection(HistoryMongo& history, std::string model, size_t dimensions, size_t capacity)
    : history_(history), model_(std::move(model)), dimensions_(dimensions), capacity_(capacity) {}
  void Rebuild(const Scope& window) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto next = std::make_unique<VectorIndex>(model_, dimensions_, capacity_);
    int64_t checkpoint = 0;
    for (;;) {
      const auto batch = history_.Scan(model_, window, checkpoint, 512);
      for (const auto& sample : batch.samples) next->Upsert(sample.record);
      if (batch.checkpoint == checkpoint) break;
      checkpoint = batch.checkpoint;
    }
    // Admission failures leave the previously usable projection intact.
    index_ = std::move(next); window_ = window; partial_ = false;
  }
  void Put(const Sample& sample) {
    std::lock_guard<std::mutex> lock(mutex_);
    history_.Put(sample);  // Authority first; a crashed projection is rebuildable.
    auto saved = history_.Get(sample.record.id, false);
    if (!saved) throw std::runtime_error("search_sample_not_visible");
    if (!index_ || sample.record.model != model_ || !window_.channels.count(sample.record.channel) || sample.record.captured_ms < window_.from_ms)
      return;
    // The live producer owns this window; coverage is tracked independently.
    window_.to_ms = std::max(window_.to_ms, sample.record.captured_ms + 1);
    try { index_->Upsert(saved->record); }
    catch (...) { partial_ = true; throw; }
  }
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot,
                               const std::string& expected_fingerprint,
                               const std::string& replacement_token) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto fingerprint = history_.ReplaceTrackSlot(sample, slot, expected_fingerprint, replacement_token);
    if (!index_ || sample.record.model != model_ || !window_.channels.count(sample.record.channel) || sample.record.captured_ms < window_.from_ms)
      return fingerprint;
    window_.to_ms = std::max(window_.to_ms, sample.record.captured_ms + 1);
    auto projected = sample.record; projected.fingerprint = fingerprint;
    try { index_->ReplaceTrackSlot(std::move(projected), index_->Fingerprint(sample.record.id).value_or("")); }
    catch (...) { partial_ = true; throw; }
    return fingerprint;
  }
  ProjectionResult Query(const std::vector<float>& query, const Scope& scope) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (scope.limit == 0 || scope.limit > 100) throw std::invalid_argument("invalid_search_limit");
    if (!index_) throw std::runtime_error("search_index_not_loaded");
    ProjectionResult out;
    out.partial = partial_ || scope.from_ms < window_.from_ms || scope.to_ms > window_.to_ms;
    for (const auto& channel : scope.channels) if (!window_.channels.count(channel)) out.partial = true;
    Scope candidates = scope; candidates.limit = 100;
    // Remove stale references without ever showing expired/deleted evidence.
    // Bound work under a mass expiration; a subsequent request can continue.
    for (int attempt = 0; attempt < 3; ++attempt) {
      out.items.clear(); bool removed = false;
      const auto hits = index_->Query(query, candidates);
      for (const auto& hit : hits) {
        auto row = history_.Get(hit.id, false);
        if (!row || hit.fingerprint.empty() || row->fingerprint != hit.fingerprint) {
          // A crash or an authority write may replace the image before this
          // projection updates. Never pair the old score with that new image.
          index_->Remove(hit.id); removed = true; out.partial = true; partial_ = true; continue;
        }
        out.items.push_back({std::move(*row), hit.score});
        if (out.items.size() >= scope.limit) break;
      }
      if (!removed || out.items.size() >= scope.limit || hits.size() < candidates.limit) return out;
    }
    out.partial = true;
    return out;
  }
 private:
  HistoryMongo& history_;
  std::string model_;
  size_t dimensions_, capacity_;
  std::mutex mutex_;
  std::unique_ptr<VectorIndex> index_;
  Scope window_;
  bool partial_ = true;
};
}  // namespace ainvr::search
