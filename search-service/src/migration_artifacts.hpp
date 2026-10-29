// One bounded derived-artifact work item on ManagedIndexRuntime's thread.
// PG remains the sole job/lease/config authority; no inference or new queue.
#pragma once
#include "migration_coverage.hpp"
#include "index_build_worker.hpp"
#include <atomic>
#include <memory>
namespace ainvr::search {
class MigrationArtifactsRuntime {
 public:
  MigrationArtifactsRuntime(const nlohmann::json& bootstrap,HistoryMongo&,IndexShardFiles&,
      IndexJobContext,std::shared_ptr<std::atomic<bool>> admitted);
  ~MigrationArtifactsRuntime();
  // Caller has just obtained this exact PG artifacts grant. Does not scan.
  nlohmann::json Activate(const MigrationWriteProof&,const MigrationWriteGrant&);
  // Exactly one serial owner; one metadata page or one bounded index stage.
  void Step();
  // Same serial owner. At most eight 32-row operations and 20ms between
  // operations; individual bounded Mongo/PG I/O retains its own deadlines.
  size_t Pump();
  bool WantsFastSteps()const;
  void Stop();
 private:
  struct Impl;std::unique_ptr<Impl> impl_;
};
}  // namespace ainvr::search
