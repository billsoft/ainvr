#pragma once
#include "history_mongo.hpp"
#include <mutex>
#include <chrono>
namespace ainvr::search {
struct RankedSample { Sample sample; double score; std::vector<IndexEvidenceRef> evidence_refs{}; };
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
  uint64_t CacheEpoch() {std::lock_guard<std::mutex> lock(mutex_);return cache_epoch_;}
  std::optional<uint64_t> Resident(const std::vector<Record>& rows) {
    std::lock_guard<std::mutex> lock(mutex_);
    if(!index_)return std::nullopt;
    for(const auto& row:rows)if(index_->Fingerprint(row.id)!=std::optional<std::string>(row.fingerprint))return std::nullopt;
    return cache_epoch_;
  }
  // Production starts a bounded derived working set. Large histories never
  // block readiness on a full Mongo scan or falsely claim complete coverage.
  // This internal authorized source window can span 1024 sources; each user
  // query keeps its existing 100-source/31-day limit.
  void Start(const Scope& window) {
    if (window.channels.empty() || window.channels.size() > 1024)
      throw std::invalid_argument("invalid_index_sources");
    Scope part = window; part.channels.clear();
    for (const auto& source : window.channels) {
      part.channels.insert(source);
      if (part.channels.size() == 100) { VectorIndex::ValidateScope(part); part.channels.clear(); }
    }
    if (!part.channels.empty()) VectorIndex::ValidateScope(part);
    std::lock_guard<std::mutex> lock(mutex_);
    ++cache_epoch_;index_ = std::make_unique<VectorIndex>(model_, dimensions_, capacity_);
    window_ = window; maintenance_cursor_.clear();
    writes_since_maintenance_ = 0; recovery_scope_ = {}; recovery_checkpoint_ = 0;
    recovery_exhausted_=false;recovery_revision_=0;
  }
  size_t Warm(const std::vector<Record>& records) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!index_ || records.size() > 100000) throw std::runtime_error("search_index_not_loaded");
    size_t inserted = 0;
    for (const auto& row : records) {
      if (row.model != model_ || !window_.channels.count(row.channel) || row.captured_ms < window_.from_ms ||
          row.captured_ms >= window_.to_ms || row.fingerprint.empty()) continue;
      // A file is a cache, never allowed to overwrite a newer live CAS. Query
      // revalidates every candidate against Mongo before returning evidence.
      if (index_->Fingerprint(row.id)) continue;
      if (index_->Size() >= capacity_) break;
      index_->Upsert(row); ++inserted;
    }
    return inserted;
  }
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
    ++cache_epoch_;index_ = std::move(next); window_ = window;
    maintenance_cursor_.clear(); writes_since_maintenance_ = 0;
    recovery_scope_ = {}; recovery_checkpoint_ = 0;
    recovery_exhausted_=false;recovery_revision_=0;
  }
  void Put(const Sample& sample) {
    history_.Put(sample);  // Authority first; a crashed projection is rebuildable.
    std::lock_guard<std::mutex> lock(mutex_);
    if (!index_ || sample.record.model != model_ || !window_.channels.count(sample.record.channel) || sample.record.captured_ms < window_.from_ms)
      return;
    // The live producer owns this window; coverage is tracked independently.
    window_.to_ms = std::max(window_.to_ms, sample.record.captured_ms + 1);
    try {
      MaintainForWrite(sample.record.id);
      auto saved = history_.Get(sample.record.id, false);
      if (!saved) { recovery_exhausted_=false;recovery_checkpoint_=0;return; }
      index_->Upsert(saved->record);
    } catch (...) {
      // Mongo already acknowledged the immutable write. A rebuildable cache
      // must never turn that success into a failed producer ACK/retry loop.
      recovery_exhausted_=false;recovery_checkpoint_=0;
    }
  }
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot,
                               const std::string& expected_fingerprint,
                               const std::string& replacement_token) {
    auto fingerprint = history_.ReplaceTrackSlot(sample, slot, expected_fingerprint, replacement_token);
    std::lock_guard<std::mutex> lock(mutex_);
    if (!index_ || sample.record.model != model_ || !window_.channels.count(sample.record.channel) || sample.record.captured_ms < window_.from_ms)
      return fingerprint;
    window_.to_ms = std::max(window_.to_ms, sample.record.captured_ms + 1);
    try {
      MaintainForWrite(sample.record.id);
      // Another acknowledged slot replacement may overtake this thread before
      // it acquires the cache lock. Project the current authority, never its
      // older local body; the caller still receives its own write receipt.
      auto saved=history_.Get(sample.record.id,false);
      if(!saved){recovery_exhausted_=false;return fingerprint;}
      index_->ReplaceTrackSlot(std::move(saved->record),index_->Fingerprint(sample.record.id).value_or(""));
    } catch (...) { recovery_exhausted_=false;recovery_checkpoint_=0; } // The authority CAS/fingerprint is final.
    return fingerprint;
  }
  ProjectionResult Query(const std::vector<float>& query, const Scope& scope) {
    std::unique_lock<std::mutex> lock(mutex_);
    VectorIndex::ValidateScope(scope); // Invalid scopes cannot sweep/evict cache.
    if (!index_) throw std::runtime_error("search_index_not_loaded");
    // Sweep the whole bounded projection, including sources/times which no
    // user will ever query again. One batch, never N roundtrips per sample.
    try { Maintain(); } catch (...) { recovery_exhausted_=false;recovery_checkpoint_=0; }
    const auto recovery_deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(50);
    try {
      for(int page=0;page<8;++page){
        const auto previous=recovery_checkpoint_;Recover(scope);
        if(recovery_exhausted_||recovery_checkpoint_==previous||std::chrono::steady_clock::now()>=recovery_deadline)break;
      }
    } catch (...) { recovery_exhausted_=false; }
    ProjectionResult out;
    const auto stamp=history_.ProjectionStamp();
    out.partial=!recovery_exhausted_||!stamp.settled||stamp.revision!=recovery_revision_;
    Scope candidates = scope; candidates.limit = 100;
    // Remove stale references without ever showing expired/deleted evidence.
    // Bound work under a mass expiration; a subsequent request can continue.
    for (int attempt = 0; attempt < 3; ++attempt) {
      out.items.clear(); bool removed = false;
      const auto hits = index_->Query(query, candidates);
      std::vector<std::string> ids;for(const auto& hit:hits)ids.push_back(hit.id);
      // The history owner provides one visibility snapshot. Do not retain the
      // projection lock across Mongo I/O and block acknowledged live writes.
      lock.unlock();
      std::map<std::string,Sample> rows;
      try { rows=history_.ReadVisibleSamples(model_,scope,ids); }
      catch(...) { lock.lock();throw; }
      lock.lock();
      for (const auto& hit : hits) {
        auto row = rows.find(hit.id);
        if (row==rows.end() || hit.fingerprint.empty() || row->second.fingerprint != hit.fingerprint) {
          // A crash or an authority write may replace the image before this
          // projection updates. Never pair the old score with that new image.
          if(index_->Fingerprint(hit.id)==std::optional<std::string>(hit.fingerprint)){index_->Remove(hit.id);++cache_epoch_;}
          removed = true; out.partial = true; recovery_exhausted_=false;recovery_checkpoint_=0;continue;
        }
        out.items.push_back({std::move(row->second), hit.score, hit.evidence_refs});
        if (out.items.size() >= scope.limit) break;
      }
      if (!removed || out.items.size() >= scope.limit || hits.size() < candidates.limit) {
        const auto current=history_.ProjectionStamp();
        out.partial=out.partial||!current.settled||current.revision!=recovery_revision_;
        return out;
      }
    }
    out.partial = true;
    return out;
  }
 private:
  static constexpr size_t kMaintenanceBatch = 32;
  void Maintain(const std::string& refreshing_id = "") {
    const auto references = index_->ScanReferences(maintenance_cursor_, kMaintenanceBatch);
    if (references.empty()) return;
    std::vector<std::string> ids; ids.reserve(references.size());
    // A just-committed local write is refreshed immediately by the caller.
    // Do not mistake its temporary old cache fingerprint for an unknown gap.
    for (const auto& ref : references) if (ref.id != refreshing_id) ids.push_back(ref.id);
    if (ids.empty()) return;
    const auto visible = history_.ReadVisibleFingerprints(model_, ids);
    for (const auto& ref : references) {
      if (ref.id == refreshing_id) continue;
      const auto current = visible.find(ref.id);
      if (ref.fingerprint.empty() || current == visible.end() || current->second != ref.fingerprint) {
        index_->Remove(ref.id); ++cache_epoch_;recovery_exhausted_=false;recovery_checkpoint_=0;
      }
    }
  }
  void MaintainForWrite(const std::string& id) {
    if (++writes_since_maintenance_ >= kMaintenanceBatch ||
        (index_->Size() >= capacity_ && !index_->Fingerprint(id))) {
      writes_since_maintenance_ = 0; Maintain(id);
    }
  }
  void Recover(const Scope& scope) {
    const bool same=scope.channels==recovery_scope_.channels&&scope.from_ms==recovery_scope_.from_ms&&scope.to_ms==recovery_scope_.to_ms;
    if(!same){recovery_checkpoint_=0;recovery_exhausted_=false;}
    recovery_scope_=scope;
    const auto before=history_.ProjectionStamp();
    if(recovery_exhausted_&&before.settled&&before.revision==recovery_revision_)return;
    if (index_->Size() >= capacity_) {
      // A working set is not the source of truth. Make bounded room for the
      // requested scope instead of pinning still-valid old scopes forever.
      // Only derived RAM entries leave; immutable Mongo facts remain intact.
      const auto references = index_->ScanReferences(maintenance_cursor_, kMaintenanceBatch);
      for (const auto& ref : references)
        if (!scope.channels.count(ref.channel) || ref.captured_ms < scope.from_ms || ref.captured_ms >= scope.to_ms)
          {index_->Remove(ref.id);++cache_epoch_;recovery_checkpoint_=0;recovery_exhausted_=false;}
    }
    // Even a full cache may already contain all rows. Allow one metadata-free
    // bounded scan to prove exhaustion; never evict required rows to certify it.
    // Keep exactly one bounded recovery cursor, not a second ingestion queue.
    // Any changed source/time boundary resets it; an older append ordinal can
    // become eligible when the time window changes. Recovery never certifies
    // complete coverage after a cache gap.
    const auto batch = history_.Scan(model_, scope, recovery_checkpoint_, kMaintenanceBatch);
    for (const auto& sample : batch.samples) {
      const auto previous = index_->Fingerprint(sample.record.id);
      if (!previous && index_->Size() >= capacity_) {recovery_exhausted_=false;return;}
      if (previous && *previous != sample.fingerprint) {index_->Remove(sample.record.id);++cache_epoch_;}
      index_->Upsert(sample.record);
    }
    recovery_checkpoint_ = batch.checkpoint;
    recovery_revision_=batch.stamp.revision;
    recovery_exhausted_=batch.exhausted&&batch.stamp.settled;
  }
  HistoryMongo& history_;
  std::string model_;
  size_t dimensions_, capacity_;
  std::mutex mutex_;
  std::unique_ptr<VectorIndex> index_;
  Scope window_;
  std::string maintenance_cursor_;
  size_t writes_since_maintenance_ = 0;
  Scope recovery_scope_;
  int64_t recovery_checkpoint_ = 0;
  uint64_t recovery_revision_=0;
  uint64_t cache_epoch_=0;
  bool recovery_exhausted_=false;
};
}  // namespace ainvr::search
