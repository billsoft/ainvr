// Copyright AINVR. Derived, process-local query embeddings; never search results.
#pragma once
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <iterator>
#include <list>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ainvr::search {

// One instance belongs to one immutable MatchEngine model/tokenizer space.
// The caller holds MatchEngine's inference mutex, checks encoder Healthy()
// BEFORE every lookup, and still performs an authorized scoped query on a hit.
// Keys are the exact already-validated/normalized query bytes. No trimming,
// lowercasing or Unicode rewriting is repeated here. Token/UTF-8 validation is
// the encoder's contract; only successfully encoded normalized vectors enter.
class BoundedTextEmbeddingCache {
 public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;
  static constexpr size_t kMaxEntries = 256;
  static constexpr size_t kMaxQueryBytes = 1024;  // Native HTTP query boundary.
  static constexpr size_t kMaxDimensions = 4096; // Existing vector boundary.
  static constexpr size_t kMaxBytes = 4 * 1024 * 1024;
  static constexpr auto kTtl = std::chrono::minutes(5);

  BoundedTextEmbeddingCache(std::string model, size_t dimensions)
      : model_(std::move(model)), dimensions_(dimensions) {
    if (model_.empty() || model_.size() > 128 || dimensions_ == 0 || dimensions_ > kMaxDimensions)
      throw std::invalid_argument("invalid_text_embedding_cache");
  }
  BoundedTextEmbeddingCache(const BoundedTextEmbeddingCache&) = delete;
  BoundedTextEmbeddingCache& operator=(const BoundedTextEmbeddingCache&) = delete;

  // The explicit clock parameter is a deterministic software-test seam. TTL
  // is fixed from insertion, not extended by reads, and uses monotonic time.
  std::optional<std::vector<float>> Get(const std::string& query, TimePoint now = Clock::now()) {
    if (!ValidQuery(query)) return std::nullopt;
    Expire(now);
    const auto found = Find(query);
    if (found == entries_.end()) return std::nullopt;
    // Cache allocation failure is a miss, not a failed authoritative operation.
    try {
      auto vector = found->vector;
      entries_.splice(entries_.begin(), entries_, found);
      return vector;
    } catch (const std::bad_alloc&) {
      return std::nullopt;
    }
  }

  bool PutNormalized(const std::string& query, const std::vector<float>& vector,
                     TimePoint now = Clock::now()) {
    if (!ValidQuery(query) || !ValidVector(vector) || now > TimePoint::max() - kTtl) return false;
    try {
      Entry candidate{query, vector, now + kTtl, 0};
      candidate.bytes = EntryBytes(candidate);
      if (candidate.bytes > kMaxBytes) return false;
      Expire(now);
      const auto old = Find(query);
      if (old != entries_.end()) Erase(old);
      while (!entries_.empty() && (entries_.size() >= kMaxEntries || bytes_ > kMaxBytes - candidate.bytes))
        Erase(std::prev(entries_.end()));
      // Publish accounting only after successful node allocation.
      entries_.push_front(std::move(candidate));
      bytes_ += entries_.front().bytes;
      return true;
    } catch (const std::bad_alloc&) {
      // Optional derived cache must not turn a successful BPU query into 503.
      return false;
    }
  }

  void Clear() { entries_.clear(); bytes_ = 0; }
  size_t Size() const { return entries_.size(); }
  size_t RetainedBytes() const { return bytes_; }
  const std::string& ModelVersion() const { return model_; }
  size_t Dimensions() const { return dimensions_; }

 private:
  struct Entry {
    std::string query;
    std::vector<float> vector;
    TimePoint expires;
    size_t bytes;
  };
  // Payload uses actual retained capacities, plus a conservative fixed charge
  // for the object/list node/allocator metadata. A count limit additionally
  // bounds all container metadata. No duplicated map key or unbounded queue.
  static constexpr size_t kEntryMetadataBytes = 256;
  static_assert(sizeof(Entry) + 2 * sizeof(void*) <= kEntryMetadataBytes);
  static size_t EntryBytes(const Entry& entry) {
    return kEntryMetadataBytes + entry.query.capacity() + 1 + entry.vector.capacity() * sizeof(float);
  }
  static bool ValidQuery(const std::string& query) {
    if (query.empty() || query.size() > kMaxQueryBytes) return false;
    bool content = false;
    for (const unsigned char c : query) {
      if ((c < 32 && c != 9 && c != 10 && c != 13) || c == 127) return false;
      if (c != ' ' && c != 9 && c != 10 && c != 13) content = true;
    }
    return content;
  }
  bool ValidVector(const std::vector<float>& vector) const {
    if (vector.size() != dimensions_) return false;
    double square = 0;
    for (const auto value : vector) {
      if (!std::isfinite(value)) return false;
      square += double(value) * value;
    }
    // Do not silently normalize failed/zero/raw model output in a cache layer.
    return std::isfinite(square) && std::abs(square - 1.0) <= 1e-4;
  }
  std::list<Entry>::iterator Find(const std::string& query) {
    return std::find_if(entries_.begin(), entries_.end(), [&](const auto& entry) { return entry.query == query; });
  }
  void Erase(std::list<Entry>::iterator at) {
    bytes_ -= at->bytes;
    entries_.erase(at);
  }
  void Expire(TimePoint now) {
    for (auto at = entries_.begin(); at != entries_.end();) {
      if (at->expires <= now) { bytes_ -= at->bytes; at = entries_.erase(at); }
      else ++at;
    }
  }

  const std::string model_;
  const size_t dimensions_;
  std::list<Entry> entries_;
  size_t bytes_ = 0;
};
} // namespace ainvr::search
