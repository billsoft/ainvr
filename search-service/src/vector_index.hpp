#pragma once
#include "index_limits.hpp"
#include "../../shared/cpp/search_views.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace ainvr::search {
inline std::vector<float> NormalizeVector(const std::vector<float>& input, size_t dimensions) {
  if (input.size() != dimensions || dimensions == 0 || dimensions > 4096)
    throw std::invalid_argument("vector_dimensions");
  double square = 0;
  for (float v : input) {
    if (!std::isfinite(v)) throw std::invalid_argument("vector_not_finite");
    square += double(v) * v;
  }
  if (square <= 1e-24 || !std::isfinite(square)) throw std::invalid_argument("vector_zero_norm");
  std::vector<float> out; out.reserve(input.size());
  const double norm = std::sqrt(square);
  for (float v : input) out.push_back(float(v / norm));
  return out;
}
// A scene record is `views` blocks, each unit-norm on its own (see shared/cpp/search_views.hpp).
inline std::vector<float> NormalizeViews(const std::vector<float>& input, size_t dimensions, size_t views) {
  if (views == 0 || dimensions == 0 || dimensions % views || input.size() != dimensions) throw std::invalid_argument("vector_dimensions");
  const size_t per = dimensions / views;
  std::vector<float> out; out.reserve(dimensions);
  for (size_t v = 0; v < views; ++v) {
    const auto begin = input.begin() + std::ptrdiff_t(v * per);
    const auto block = NormalizeVector(std::vector<float>(begin, begin + std::ptrdiff_t(per)), per);
    out.insert(out.end(), block.begin(), block.end());
  }
  return out;
}
struct Record {
  std::string id, channel, processor, session, track, model;
  int64_t captured_ms = 0;
  bool scene = false;
  std::vector<float> vector;
  std::string fingerprint{};
};
struct Scope {
  std::set<std::string> channels;
  int64_t from_ms = 0, to_ms = 0;
  size_t limit = 20;
};
struct IndexEvidenceRef { std::string id, fingerprint; int64_t captured_ms = 0; };
struct Hit { std::string id; double score; std::string fingerprint{}; std::vector<IndexEvidenceRef> evidence_refs{}; size_t view = 0; };
struct IndexReference { std::string id, fingerprint, channel; int64_t captured_ms; };

// Exact CPU retrieval baseline, not model inference. Authoritative records are
// persisted separately; this bounded projection can be rebuilt after restart.
class VectorIndex {
 public:
  // `dimensions` is the stored record length. With views > 1 a record is `views` unit-norm blocks of
  // dimensions/views floats; a query is one block and a record scores as its best block.
  VectorIndex(std::string model, size_t dimensions, size_t capacity, size_t views = 1)
      : model_(std::move(model)), dimensions_(dimensions), capacity_(capacity), views_(views) {
    if (model_.empty() || dimensions_ == 0 || dimensions_ > 4096 || views_ == 0 || views_ > 8 || dimensions_ % views_ ||
        capacity_ == 0 || capacity_ > 1000000 || dimensions_ > kMaxIndexFloats / capacity_)
      throw std::invalid_argument("invalid_index_budget");
    view_dimensions_ = dimensions_ / views_;
  }
  void Upsert(Record value) {
    Validate(value);
    auto old = records_.find(value.id);
    if (old != records_.end()) {
      const auto& before = old->second;
      if (before.channel != value.channel || before.processor != value.processor ||
          before.session != value.session || before.track != value.track ||
          before.captured_ms != value.captured_ms || before.scene != value.scene ||
          before.vector != value.vector || before.fingerprint != value.fingerprint)
        throw std::invalid_argument("record_identity_conflict");
      return;
    }
    if (records_.size() >= capacity_) throw std::runtime_error("index_capacity");
    records_.emplace(value.id, std::move(value));
  }
  // Only an authority-acknowledged generation may enter this mutable path.
  // Validation completes before replacing the map value; failures keep it intact.
  void ReplaceTrackSlot(Record value, const std::string& expected_fingerprint) {
    Validate(value);
    if (value.scene || value.fingerprint.size() != 64 ||
        !std::all_of(value.fingerprint.begin(), value.fingerprint.end(),
          [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }))
      throw std::invalid_argument("invalid_slot_generation");
    auto old = records_.find(value.id);
    if (old == records_.end()) {
      if (!expected_fingerprint.empty()) throw std::runtime_error("index_slot_conflict");
      if (records_.size() >= capacity_) throw std::runtime_error("index_capacity");
      records_.emplace(value.id, std::move(value));
      return;
    }
    const auto& before = old->second;
    if (before.fingerprint != expected_fingerprint || before.scene || before.channel != value.channel ||
        before.processor != value.processor || before.session != value.session || before.track != value.track)
      throw std::runtime_error("index_slot_conflict");
    if (before.fingerprint == value.fingerprint &&
        (before.captured_ms != value.captured_ms || before.vector != value.vector))
      throw std::invalid_argument("record_identity_conflict");
    old->second = std::move(value);
  }
  std::optional<std::string> Fingerprint(const std::string& id) const {
    const auto found = records_.find(id);
    if (found == records_.end()) return std::nullopt;
    return found->second.fingerprint;
  }
  void Remove(const std::string& id) { records_.erase(id); }
  std::optional<IndexReference> Reference(const std::string& id) const {
    const auto found = records_.find(id);
    if (found == records_.end()) return std::nullopt;
    return IndexReference{found->first, found->second.fingerprint, found->second.channel, found->second.captured_ms};
  }
  size_t Size() const { return records_.size(); }
  // Bounded global maintenance cursor, independent of any query scope. Copy
  // only identity/digest; never materialize vectors just to check liveness.
  std::vector<IndexReference> ScanReferences(std::string& cursor, size_t limit) const {
    if (!limit || limit > 64) throw std::invalid_argument("invalid_index_scan_limit");
    std::vector<IndexReference> out;
    const auto count = std::min(limit, records_.size()); out.reserve(count);
    if (!count) { cursor.clear(); return out; }
    auto entry = records_.upper_bound(cursor);
    for (size_t i = 0; i < count; ++i) {
      if (entry == records_.end()) entry = records_.begin();
      out.push_back({entry->first, entry->second.fingerprint, entry->second.channel, entry->second.captured_ms}); ++entry;
    }
    cursor = out.back().id;
    return out;
  }
  // Transfer a completed bounded projection into the immutable file writer.
  // Rvalue-only: no second vector-store abstraction or copied payload retained.
  std::vector<Record> ReleaseRecords() && {
    std::vector<Record> out; out.reserve(records_.size());
    for (auto& entry : records_) out.push_back(std::move(entry.second));
    records_.clear();
    return out;
  }
  static void ValidateScope(const Scope& scope) {
    if (scope.channels.empty() || scope.channels.size() > 100 ||
        scope.from_ms < 0 || scope.to_ms <= scope.from_ms ||
        scope.to_ms - scope.from_ms > int64_t(31) * 86400000 ||
        scope.limit == 0 || scope.limit > 100)
      throw std::invalid_argument("invalid_search_scope");
  }
  std::vector<Hit> Query(const std::vector<float>& vector, const Scope& scope) const {
    ValidateScope(scope);
    auto query = Normalize(vector);
    // Structured keys avoid collisions from delimiters in opaque identities.
    using Key = std::vector<std::string>;
    struct Group { Hit hit; IndexEvidenceRef first, last; };
    std::map<Key, Group> groups;
    for (const auto& [id, record] : records_) {
      if (!scope.channels.count(record.channel) || record.captured_ms < scope.from_ms ||
          record.captured_ms >= scope.to_ms) continue;
      double score = -2; size_t best_view = 0;
      for (size_t v = 0; v < views_; ++v) {
        const float* block = record.vector.data() + v * view_dimensions_;
        double s = 0;
        for (size_t i = 0; i < view_dimensions_; ++i) s += double(query[i]) * block[i];
        if (s > score) { score = s; best_view = v; }
      }
      const Key key = record.scene ? Key{"scene", id} :
        Key{"object", record.channel, record.processor, record.session, record.track};
      const IndexEvidenceRef ref{id, record.fingerprint, record.captured_ms};
      auto found = groups.find(key);
      if (found == groups.end()) { groups.emplace(key, Group{{id, score, record.fingerprint, {}, best_view}, ref, ref}); continue; }
      auto& group = found->second;
      if (score > group.hit.score || (score == group.hit.score && id < group.hit.id)) group.hit = {id, score, record.fingerprint, {}, best_view};
      if (record.captured_ms < group.first.captured_ms || (record.captured_ms == group.first.captured_ms && id < group.first.id)) group.first = ref;
      if (record.captured_ms > group.last.captured_ms || (record.captured_ms == group.last.captured_ms && id > group.last.id)) group.last = ref;
    }
    std::vector<Hit> hits;
    for (auto& [_, group] : groups) {
      auto& hit = group.hit;
      const auto& match = records_.at(hit.id);
      hit.evidence_refs.push_back({hit.id, hit.fingerprint, match.captured_ms});
      for (const auto& ref : {group.first, group.last})
        if (std::none_of(hit.evidence_refs.begin(), hit.evidence_refs.end(), [&](const auto& item) { return item.id == ref.id; })) hit.evidence_refs.push_back(ref);
      hits.push_back(std::move(hit));
    }
    std::sort(hits.begin(), hits.end(), [](const auto& a, const auto& b) {
      return a.score == b.score ? a.id < b.id : a.score > b.score;
    });
    if (hits.size() > scope.limit) hits.resize(scope.limit);
    return hits;
  }
 private:
  void Validate(Record& value) const {
    if (value.model != model_) throw std::invalid_argument("model_version_mismatch");
    for (const auto* s : {&value.id, &value.channel, &value.processor, &value.session, &value.track})
      if (s->size() > 256) throw std::invalid_argument("identity_too_long");
    if (value.id.empty() || value.channel.empty() || value.captured_ms < 0 ||
        (!value.scene && (value.processor.empty() || value.session.empty() || value.track.empty())))
      throw std::invalid_argument("invalid_record_identity");
    // Each view block is normalised on its own, so a record never trades one view's weight for another's.
    if (value.vector.size() != dimensions_) throw std::invalid_argument("vector_dimensions");
    for (size_t v = 0; v < views_; ++v) {
      const auto begin = value.vector.begin() + std::ptrdiff_t(v * view_dimensions_);
      const auto block = NormalizeVector(std::vector<float>(begin, begin + std::ptrdiff_t(view_dimensions_)), view_dimensions_);
      std::copy(block.begin(), block.end(), value.vector.begin() + std::ptrdiff_t(v * view_dimensions_));
    }
  }
  // Queries are one view block (the text vector), whatever the stored record length is.
  std::vector<float> Normalize(const std::vector<float>& input) const {
    return NormalizeVector(input, view_dimensions_);
  }
  std::string model_;
  size_t dimensions_, capacity_, views_ = 1, view_dimensions_ = 0;
  std::map<std::string, Record> records_;
};
}  // namespace ainvr::search
