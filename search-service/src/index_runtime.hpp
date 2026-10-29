#pragma once
#include "index_build_worker.hpp"
#include "http_service.hpp"
#include "migration_artifacts.hpp"
#include <atomic>
#include <memory>
namespace ainvr::search {
// CPU control/derived-file maintenance only. The caller owns history, engine
// and the immutable config generation; Stop drains before either is destroyed.
class ManagedIndexRuntime {
 public:
  ManagedIndexRuntime(const nlohmann::json& bootstrap, HistoryMongo&, MatchEngine&,
      std::unique_ptr<IndexShardFiles>, IndexJobContext, size_t dimensions,
      std::shared_ptr<std::atomic<bool>> admitted);
  ManagedIndexRuntime(const nlohmann::json& bootstrap,HistoryMongo&,MatchEngine*,
      std::unique_ptr<IndexShardFiles>,IndexJobContext,size_t dimensions,
      std::shared_ptr<std::atomic<bool>> admitted);
  nlohmann::json ActivateMigration(const MigrationWriteProof&,const MigrationWriteGrant&);
  ~ManagedIndexRuntime();
  ManagedIndexRuntime(const ManagedIndexRuntime&) = delete;
  ManagedIndexRuntime& operator=(const ManagedIndexRuntime&) = delete;
  void Stop();
  nlohmann::json Status() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace ainvr::search
