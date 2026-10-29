#pragma once
#include "history_mongo.hpp"
#include "index_job_client.hpp"
#include <chrono>
#include <functional>
#include <optional>
namespace ainvr::search {
struct IndexBuildOptions {
  size_t max_records = 10000, batch_size = 512, max_batches = 256;
  uint64_t max_vector_bytes = 64ULL * 1024 * 1024;
  std::chrono::seconds max_duration{90};
};
struct IndexBuildOutcome {
  enum class State { Idle, Published, Cancelled, Stale, Capacity, Invalid, Unavailable, NeedsReconcile };
  State state = State::Unavailable;
  std::optional<IndexBuildLease> lease;
  std::optional<ShardPublication> publication;
};
// One serial caller per runtime generation. No extra queue, database, inference,
// scheduler or hidden retry. SearchJobs retains the only durable task lease.
class IndexBuildWorker {
 public:
  using Cancelled = std::function<bool()>;
  using Clock = std::function<std::chrono::steady_clock::time_point()>;
#ifndef AINVR_INDEX_BUILDER_TESTING
  IndexBuildWorker(HistoryMongo&, IndexShardFiles&, IndexJobPort&, IndexJobContext,
      size_t dimensions, IndexBuildOptions options = {}, Clock clock = {});
#endif
#ifdef AINVR_INDEX_BUILDER_TESTING
  using Scan = std::function<HistoryBatch(const std::string&, const Scope&, int64_t, size_t)>;
  IndexBuildWorker(Scan, IndexShardFiles&, IndexJobPort&, IndexJobContext,
      size_t dimensions, IndexBuildOptions options = {}, Clock clock = {});
#endif
  IndexBuildOutcome RunOne(const std::string& worker, const std::string& kind = "index", Cancelled cancelled = {});
  // Consult publication authority after an ambiguous response; never re-encode,
  // rescan or silently resubmit. No image/vector buffer is held in this outcome.
  IndexBuildOutcome Reconcile(const IndexBuildOutcome&, Cancelled cancelled = {});
 private:
  using Reader = std::function<HistoryBatch(const std::string&, const Scope&, int64_t, size_t)>;
  void Validate();
  bool SameJob(const IndexJob&) const;
  bool SameBuild(const IndexJob&, const IndexBuildLease&) const;
  Reader scan_;
  IndexShardFiles& files_;
  IndexJobPort& jobs_;
  IndexJobContext context_;
  size_t dimensions_, capacity_ = 0;
  IndexBuildOptions options_;
  Clock clock_;
};
} // namespace ainvr::search
