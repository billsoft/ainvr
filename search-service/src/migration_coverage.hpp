// Derived retained-evidence coverage, never a task/lease or inference engine.
#pragma once
#include "history_mongo.hpp"
#include "model_pin.hpp"
namespace ainvr::search {
struct MigrationCoverageDefinition {
  std::string payload_fingerprint;
  RuntimeModelPin source,target;
  Scope scope;
  int64_t source_high_watermark=0,minimum_target_checkpoint=0,expires_ms=0;
  size_t max_records=1000000;
};
struct MigrationCoverageObservation {
  HistoryMetadataRow source;
  std::optional<HistoryMetadataRow> target;
  bool source_current=false;
};
struct MigrationCoverageBatch {
  std::vector<MigrationCoverageObservation> rows;
  int64_t checkpoint=0;
  bool exhausted=false;
};
class MigrationCoveragePass {
 public:
  explicit MigrationCoveragePass(MigrationCoverageDefinition);
  // Entire batch validation precedes commit. One caller, no internal queue.
  void Observe(const MigrationCoverageBatch&,int64_t now_ms);
  int64_t Checkpoint()const{return checkpoint_;}
  bool Complete()const{return complete_;}
  const MigrationCoverageDefinition& Definition()const{return definition_;}
  // Small portable cursor/hash-chain state, not encoded evidence. The storage
  // owner enforces TTL/count/byte budgets and PG authorization before mutations.
  nlohmann::json State()const;
  static MigrationCoveragePass Restore(MigrationCoverageDefinition,const nlohmann::json&);
  // Completed immutable header with at most 32 partitions and <=32KiB wire.
  nlohmann::json Page(const std::optional<std::string>& after=std::nullopt)const;
 private:
  struct Partition{int64_t checkpoint=0;uint64_t records=0;};
  nlohmann::json Header()const;
  std::string Identity()const;
  MigrationCoverageDefinition definition_;
  std::map<std::string,Partition> partitions_;
  int64_t checkpoint_=0,target_checkpoint_=0;
  uint64_t required_=0,matched_=0,unavailable_=0;
  std::string digest_;
  bool complete_=false;
};
}  // namespace ainvr::search
