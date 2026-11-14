#pragma once
// Query over the published shard files plus the newest rows still only in Mongo.
//
// Every query has a time range (at most 31 days) and a channel set, and the shards are
// cut by (channel, UTC day). So a query reads only the shards of its scope, straight
// from their memory mappings (int8, ~3.6 KB per four-view sample), and nothing is held
// resident per sample: memory does not grow with retention. This replaces a float32
// RAM projection that filled up (~41.7k samples on .190 against 100k in Mongo), had
// to be re-warmed from files and recovered from Mongo, and reported every query on a
// live board as partial.
//
// Rows newer than a shard's checkpoint (written since its last build, including
// replaced track slots) are read from Mongo at query time and override the shard row
// with the same id: for today and yesterday, and for a day without a shard. Older days
// with a shard read no tail: a late write there advances the discovery cursor and the
// shard is rebuilt within the refresh interval. Known edge: a row whose ordinal was
// allocated before, but committed after, the build that covered its day, and that is
// the last row of that day, stays invisible until another write rebuilds the day.
#include "history_mongo.hpp"
#include "index_int8.hpp"
#include "index_shard_files.hpp"
#include <chrono>
#include <ctime>
#include <deque>
#include <functional>
#include <iomanip>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <unordered_set>

namespace ainvr::search {
struct RankedSample { Sample sample; double score; std::vector<IndexEvidenceRef> evidence_refs{}; size_t view = 0; };
struct ProjectionResult {
  std::vector<RankedSample> items;
  // The scope could not be read completely (unknown days during startup, a capped
  // Mongo tail, or too many candidates vanished). The UI shows partial coverage.
  bool partial = false;
};
// What the projection reads and writes through: Mongo in production, a fake in tests.
class IndexAuthority {
 public:
  virtual ~IndexAuthority() = default;
  virtual void Put(const Sample& sample) = 0;
  virtual std::string ReplaceTrackSlot(const Sample& sample, size_t slot, const std::string& expected, const std::string& token) = 0;
  virtual HistoryBatch Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit) = 0;
  virtual std::map<std::string, Sample> ReadVisibleSamples(const std::string& model, const Scope& scope,
                                                           const std::vector<std::string>& ids) = 0;
};
class HistoryAuthority final : public IndexAuthority {
 public:
  explicit HistoryAuthority(HistoryMongo& history) : history_(history) {}
  void Put(const Sample& sample) override { history_.Put(sample); }
  std::string ReplaceTrackSlot(const Sample& s, size_t slot, const std::string& e, const std::string& t) override {
    return history_.ReplaceTrackSlot(s, slot, e, t);
  }
  HistoryBatch Scan(const std::string& m, const Scope& s, int64_t a, size_t l) override { return history_.Scan(m, s, a, l); }
  std::map<std::string, Sample> ReadVisibleSamples(const std::string& m, const Scope& s, const std::vector<std::string>& ids) override {
    return history_.ReadVisibleSamples(m, s, ids);
  }
 private:
  HistoryMongo& history_;
};

class IndexProjection {
 public:
  using Clock = std::function<int64_t()>;   // wall-clock milliseconds; UTC days decide which tails are read
  static constexpr size_t kTailBudget = 2000;   // Mongo rows (~12 KB vectors each) per query
  static constexpr size_t kTailPage = 128;
  IndexProjection(HistoryMongo& history, std::string model, size_t dimensions, size_t views = 1, Clock clock = {})
      : owned_(std::make_unique<HistoryAuthority>(history)), authority_(*owned_), model_(std::move(model)),
        dimensions_(dimensions), views_(views), clock_(std::move(clock)) { Validate(); }
  IndexProjection(IndexAuthority& authority, std::string model, size_t dimensions, size_t views = 1, Clock clock = {})
      : authority_(authority), model_(std::move(model)), dimensions_(dimensions), views_(views), clock_(std::move(clock)) { Validate(); }
  static int64_t UtcDay(int64_t ms) { return ms >= 0 ? ms / 86400000 : (ms - 86399999) / 86400000; }
  static std::optional<int64_t> ShardDay(const std::string& day) {
    std::tm date{}; std::istringstream input(day); input >> std::get_time(&date, "%Y-%m-%d");
    if (input.fail() || day.size() != 10) return std::nullopt;
    return int64_t(timegm(&date)) / 86400;
  }
  // The authorized sources. Until the shard catalog has been read once, a day without
  // an attached shard is unknown (partial), never assumed empty, and never read whole
  // from Mongo per query (that would bring back the read storm after every restart).
  void Start(const Scope& window) {
    if (window.channels.empty() || window.channels.size() > 1024) throw std::invalid_argument("invalid_index_sources");
    Scope part = window; part.channels.clear();
    for (const auto& source : window.channels) {
      part.channels.insert(source);
      if (part.channels.size() == 100) { VectorIndex::ValidateScope(part); part.channels.clear(); }
    }
    if (!part.channels.empty()) VectorIndex::ValidateScope(part);
    std::lock_guard<std::mutex> lock(mutex_);
    started_ = true; catalog_complete_ = false;
  }
  // The attached shards are the whole catalog: a day without one is read from Mongo.
  void MarkCatalogComplete() { std::lock_guard<std::mutex> lock(mutex_); catalog_complete_ = true; }
  void Rebuild(const Scope& window) { Start(window); MarkCatalogComplete(); }
  void Attach(std::shared_ptr<const ShardView> shard) {
    if (!shard || shard->identity.model_version != model_ || shard->dimensions != dimensions_ || shard->views != views_)
      throw std::invalid_argument("search_index_shard_mismatch");
    const auto day = ShardDay(shard->identity.utc_day);
    if (!day) throw std::invalid_argument("search_index_shard_mismatch");
    std::lock_guard<std::mutex> lock(mutex_);
    const auto previous = by_id_.find(shard->identity.id);
    if (previous != by_id_.end()) shards_.erase(previous->second);
    const std::pair<std::string, int64_t> key{shard->identity.channel_id, *day};
    const auto replaced = shards_.find(key);
    if (replaced != shards_.end()) { by_id_.erase(replaced->second->identity.id); Forget(replaced->second->identity.id); }
    Forget(shard->identity.id);
    shards_[key] = shard; by_id_[shard->identity.id] = key;
  }
  void Detach(const std::string& shard_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = by_id_.find(shard_id);
    if (found == by_id_.end()) return;
    shards_.erase(found->second); by_id_.erase(found); Forget(shard_id);
  }
  // Shards whose rows were found gone from Mongo (evicted by its byte budget, deleted,
  // expired): rebuilding them from Mongo drops those rows. Each shard is offered once
  // until a new revision is attached.
  std::vector<IndexShardIdentity> TakeRebuildRequests() {
    std::lock_guard<std::mutex> lock(mutex_); std::vector<IndexShardIdentity> out; out.swap(rebuilds_); return out;
  }
  // Attached shard id -> manifest hash, so an unchanged publication is not reopened.
  std::map<std::string, std::string> Attached() const {
    std::lock_guard<std::mutex> lock(mutex_); std::map<std::string, std::string> out;
    for (const auto& [_, shard] : shards_) out[shard->identity.id] = shard->publication.manifest_sha256;
    return out;
  }
  nlohmann::json Status() const {
    std::lock_guard<std::mutex> lock(mutex_); size_t records = 0, converted = 0, dead = 0;
    for (const auto& [_, shard] : shards_) { records += shard->count; converted += shard->converted; }
    for (const auto& [_, rows] : dead_) dead += size_t(std::count(rows->begin(), rows->end(), true));
    return {{"attached_shards", shards_.size()}, {"converted_shards", converted}, {"attached_records", records},
            {"dead_rows", dead}, {"catalog_complete", catalog_complete_}};
  }
  void Put(const Sample& sample) { authority_.Put(sample); }
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot, const std::string& expected, const std::string& token) {
    return authority_.ReplaceTrackSlot(sample, slot, expected, token);
  }
  ProjectionResult Query(const std::vector<float>& raw_query, const Scope& scope);

 private:
  struct Ref { int64_t at = 0; const char* id = nullptr; const ShardView* shard = nullptr; size_t row = 0; const Sample* tail = nullptr; };
  struct Group { double score = -3; bool exact = false; size_t view = 0; Ref best, first, last; };
  void Validate() const {
    if (model_.empty() || model_.size() > 128 || !views_ || views_ > 8 || !dimensions_ || dimensions_ > 4096 || dimensions_ % views_)
      throw std::invalid_argument("invalid_index_budget");
  }
  int64_t Now() const {
    return clock_ ? clock_() : std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  }
  static bool Before(const Ref& a, const Ref& b) {
    return a.at < b.at || (a.at == b.at && std::memcmp(a.id, b.id, 36) < 0);
  }
  static IndexEvidenceRef Evidence(const Ref& ref) {
    if (ref.tail) return {ref.tail->record.id, ref.tail->fingerprint, ref.at};
    return {ref.shard->Id(ref.row), ref.shard->Fingerprint(ref.row), ref.at};
  }
  std::unique_ptr<IndexAuthority> owned_;
  IndexAuthority& authority_;
  std::string model_;
  size_t dimensions_, views_;
  Clock clock_;
  using DeadRows = std::shared_ptr<const std::vector<bool>>;   // copy-on-write, indexed by shard row
  void Forget(const std::string& shard_id) { dead_.erase(shard_id); requested_.erase(shard_id); }   // mutex_ held
  // Rows of `shard` that verification found gone: skipped from now on, and the shard
  // offered for a rebuild once. Ignored if the shard was replaced meanwhile.
  void MarkGone(const ShardView* shard, const std::vector<size_t>& rows) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto& id = shard->identity.id;
    const auto attached = by_id_.find(id);
    if (attached == by_id_.end() || shards_.at(attached->second).get() != shard) return;
    auto next = std::make_shared<std::vector<bool>>(shard->count, false);
    if (const auto found = dead_.find(id); found != dead_.end()) *next = *found->second;
    for (const auto row : rows) if (row < next->size()) (*next)[row] = true;
    dead_[id] = next;
    if (requested_.insert(id).second) rebuilds_.push_back(shard->identity);
  }
  mutable std::mutex mutex_;
  bool started_ = false, catalog_complete_ = false;
  std::map<std::pair<std::string, int64_t>, std::shared_ptr<const ShardView>> shards_;
  std::map<std::string, std::pair<std::string, int64_t>> by_id_;
  std::map<std::string, DeadRows> dead_;
  std::set<std::string> requested_;
  std::vector<IndexShardIdentity> rebuilds_;
};

inline ProjectionResult IndexProjection::Query(const std::vector<float>& raw_query, const Scope& scope) {
  VectorIndex::ValidateScope(scope);
  const size_t per = dimensions_ / views_;
  std::map<std::pair<std::string, int64_t>, std::shared_ptr<const ShardView>> shards; bool complete = false;
  std::map<const ShardView*, DeadRows> dead;
  const int64_t first_day = UtcDay(scope.from_ms), last_day = UtcDay(scope.to_ms - 1);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_) throw std::runtime_error("search_index_not_loaded");
    complete = catalog_complete_;
    for (const auto& channel : scope.channels)
      for (auto day = first_day; day <= last_day; ++day) {
        const auto found = shards_.find({channel, day});
        if (found == shards_.end()) continue;
        shards[found->first] = found->second;
        if (const auto rows = dead_.find(found->second->identity.id); rows != dead_.end()) dead[found->second.get()] = rows->second;
      }
  }
  const auto query = NormalizeVector(raw_query, per);
  ProjectionResult out;
  std::map<GroupKey, Group> groups;
  const auto note = [&](const GroupKey& key, double score, bool exact, size_t view, const Ref& ref) {
    auto [entry, fresh] = groups.try_emplace(key);
    auto& group = entry->second;
    if (fresh) { group.score = score; group.exact = exact; group.view = view; group.best = group.first = group.last = ref; return; }
    if (score > group.score || (score == group.score && std::memcmp(ref.id, group.best.id, 36) < 0)) {
      group.score = score; group.exact = exact; group.view = view; group.best = ref;
    }
    if (Before(ref, group.first)) group.first = ref;
    if (Before(group.last, ref)) group.last = ref;
  };
  // 1. Rows only in Mongo: exact scores, and they override shard rows with the same id.
  std::deque<Sample> tail; std::set<std::pair<std::string, int64_t>> tail_days; std::unordered_set<std::string> tail_ids;
  const int64_t today = UtcDay(Now());
  for (const auto& channel : scope.channels) {
    for (auto day = first_day; day <= last_day; ++day) {
      const auto shard = shards.find({channel, day});
      if (shard == shards.end() && !complete) { out.partial = true; continue; }
      if (shard != shards.end() && day < today - 1) continue;
      Scope part{{channel}, std::max(scope.from_ms, day * 86400000), std::min(scope.to_ms, (day + 1) * 86400000), scope.limit};
      int64_t after = shard != shards.end() ? shard->second->identity.checkpoint : 0;
      for (;;) {
        if (tail.size() >= kTailBudget) { out.partial = true; break; }
        auto batch = authority_.Scan(model_, part, after, std::min(kTailPage, kTailBudget - tail.size()));
        for (auto& sample : batch.samples) {
          if (sample.record.model != model_ || sample.record.channel != channel ||
              sample.record.captured_ms < part.from_ms || sample.record.captured_ms >= part.to_ms) continue;
          std::vector<float> normalized;
          try { normalized = NormalizeViews(sample.record.vector, dimensions_, views_); } catch (...) { continue; }
          size_t view = 0; const double score = ExactBestView(normalized, views_, query, &view);
          tail.push_back(std::move(sample)); const auto& kept = tail.back();
          tail_ids.insert(kept.record.id); tail_days.insert({channel, day});
          note(RecordGroup(kept.record), score, true, view, Ref{kept.record.captured_ms, kept.record.id.data(), nullptr, 0, &kept});
        }
        if (batch.exhausted || batch.samples.empty() || batch.checkpoint == after) break;
        after = batch.checkpoint;
      }
    }
  }
  // 2. Shard rows: an int8 coarse pass, rows already overridden by the tail skipped.
  for (const auto& [key, shard] : shards) {
    const auto& v = *shard;
    const bool check = tail_days.count(key) > 0;
    const auto gone = dead.find(&v); const std::vector<bool>* skip = gone == dead.end() ? nullptr : gone->second.get();
    for (size_t row = 0; row < v.count; ++row) {
      const int64_t at = v.captured_ms[row];
      if (at < scope.from_ms || at >= scope.to_ms) continue;
      if (skip && (*skip)[row]) continue;
      if (check && tail_ids.count(v.Id(row))) continue;
      size_t view = 0;
      const float score = CoarseBestView(v.vectors + row * v.dimensions, v.scales + row * v.views, v.views, v.per, query.data(), &view);
      GroupKey group; std::memcpy(group.data(), v.groups + 16 * row, group.size());
      note(group, score, false, view, Ref{at, v.ids + 36 * row, &v, row, nullptr});
    }
  }
  // 3. The best groups by coarse score; shard winners are re-read and scored exactly.
  // Rows found gone are skipped and the next batch verified, at most three batches
  // (rows of a shard Mongo evicted since its build fail verification).
  std::vector<Group*> ranked; ranked.reserve(groups.size());
  for (auto& [_, group] : groups) ranked.push_back(&group);
  std::sort(ranked.begin(), ranked.end(), [](const Group* a, const Group* b) {
    return a->score != b->score ? a->score > b->score : std::memcmp(a->best.id, b->best.id, 36) < 0;
  });
  // Verification reads whole Mongo documents (the JPEG included, ~150 KB on .190), so
  // the batch is what the float projection verified before: 100 groups. Measured on
  // .190 vectors: int8 top 100 + exact rescoring keeps 99.9% of the exact top 20.
  const size_t batch = std::max<size_t>(100, 3 * scope.limit);
  struct Final { Group* group; Sample sample; };
  std::vector<Final> finals; size_t next = 0;
  std::map<const ShardView*, std::vector<size_t>> gone_rows;
  for (int round = 0; round < 3 && next < ranked.size() && finals.size() < scope.limit; ++round) {
    const size_t end = std::min(ranked.size(), next + batch);
    std::map<std::string, Sample> verified; std::vector<std::string> ids;
    for (size_t i = next; i < end; ++i) if (!ranked[i]->exact) ids.push_back(ranked[i]->best.shard->Id(ranked[i]->best.row));
    for (size_t at = 0; at < ids.size(); at += 100) {
      auto rows = authority_.ReadVisibleSamples(model_, scope, std::vector<std::string>(ids.begin() + std::ptrdiff_t(at),
          ids.begin() + std::ptrdiff_t(std::min(ids.size(), at + 100))));
      for (auto& [id, sample] : rows) verified.emplace(id, std::move(sample));
    }
    for (size_t i = next; i < end; ++i) {
      auto* group = ranked[i];
      if (group->exact) { finals.push_back({group, *group->best.tail}); continue; }
      const auto found = verified.find(group->best.shard->Id(group->best.row));
      // Expired, evicted, deleted or replaced since the shard was built: never pair the
      // old score with a newer image, and skip that row from now on.
      if (found == verified.end() || found->second.fingerprint != group->best.shard->Fingerprint(group->best.row)) {
        gone_rows[group->best.shard].push_back(group->best.row); continue;
      }
      std::vector<float> normalized;
      try { normalized = NormalizeViews(found->second.record.vector, dimensions_, views_); } catch (...) { continue; }
      group->score = ExactBestView(normalized, views_, query, &group->view); group->exact = true;
      finals.push_back({group, std::move(found->second)});
    }
    next = end;
  }
  std::sort(finals.begin(), finals.end(), [](const Final& a, const Final& b) {
    return a.group->score != b.group->score ? a.group->score > b.group->score : a.sample.record.id < b.sample.record.id;
  });
  for (const auto& [shard, rows] : gone_rows) MarkGone(shard, rows);
  if (finals.size() < scope.limit && next < ranked.size()) out.partial = true;
  for (auto& final : finals) {
    if (out.items.size() >= scope.limit) break;
    auto& group = *final.group;
    std::vector<IndexEvidenceRef> refs{Evidence(group.best)};
    for (const auto* ref : {&group.first, &group.last}) {
      auto evidence = Evidence(*ref);
      if (std::none_of(refs.begin(), refs.end(), [&](const auto& item) { return item.id == evidence.id; })) refs.push_back(std::move(evidence));
    }
    refs[0].fingerprint = final.sample.fingerprint;
    out.items.push_back({std::move(final.sample), group.score, std::move(refs), group.view});
  }
  return out;
}
}  // namespace ainvr::search
