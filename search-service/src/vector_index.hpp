#pragma once
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
struct Hit { std::string id; double score; std::string fingerprint{}; };

// Exact CPU retrieval baseline, not model inference. Authoritative records are
// persisted separately; this bounded projection can be rebuilt after restart.
class VectorIndex {
 public:
  VectorIndex(std::string model, size_t dimensions, size_t capacity)
      : model_(std::move(model)), dimensions_(dimensions), capacity_(capacity) {
    if (model_.empty() || dimensions_ == 0 || dimensions_ > 4096 ||
        capacity_ == 0 || capacity_ > 1000000 || dimensions_ > 64000000 / capacity_)
      throw std::invalid_argument("invalid_index_budget");
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
  size_t Size() const { return records_.size(); }
  std::vector<Hit> Query(const std::vector<float>& vector, const Scope& scope) const {
    if (scope.channels.empty() || scope.channels.size() > 100 ||
        scope.from_ms < 0 || scope.to_ms <= scope.from_ms ||
        scope.to_ms - scope.from_ms > int64_t(31) * 86400000 ||
        scope.limit == 0 || scope.limit > 100)
      throw std::invalid_argument("invalid_search_scope");
    auto query = Normalize(vector);
    // Structured keys avoid collisions from delimiters in opaque identities.
    using Key = std::vector<std::string>;
    std::map<Key, Hit> groups;
    for (const auto& [id, record] : records_) {
      if (!scope.channels.count(record.channel) || record.captured_ms < scope.from_ms ||
          record.captured_ms >= scope.to_ms) continue;
      double score = 0;
      for (size_t i = 0; i < dimensions_; ++i) score += double(query[i]) * record.vector[i];
      const Key key = record.scene ? Key{"scene", id} :
        Key{"object", record.channel, record.processor, record.session, record.track};
      auto found = groups.find(key);
      if (found == groups.end() || score > found->second.score ||
          (score == found->second.score && id < found->second.id))
        groups[key] = {id, score, record.fingerprint};
    }
    std::vector<Hit> hits;
    for (const auto& [_, hit] : groups) hits.push_back(hit);
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
    value.vector = Normalize(value.vector);
  }
  std::vector<float> Normalize(const std::vector<float>& input) const {
    return NormalizeVector(input, dimensions_);
  }
  std::string model_;
  size_t dimensions_, capacity_;
  std::map<std::string, Record> records_;
};
}  // namespace ainvr::search
