// Copyright AINVR.
#pragma once
#include <cstdint>
#include <nlohmann/json.hpp>
#include <memory>
#include <optional>
#include <string>
#include <vector>
namespace ainvr {
class ArchiveMongo {
 public:
  ArchiveMongo(const std::string& uri,const std::string& database,const std::string& collection);
  ~ArchiveMongo();
  ArchiveMongo(const ArchiveMongo&)=delete;
  ArchiveMongo& operator=(const ArchiveMongo&)=delete;
  // Journaled acknowledged upsert keyed by the immutable record ObjectId.
  // Exceptions leave ownership/retry responsibility with the caller.
  void Put(const std::vector<uint8_t>& bson);
  std::optional<std::vector<uint8_t>> Get(const std::string& image_id);
  std::optional<std::vector<uint8_t>> GetImage(const std::string& image_id,bool original=false);
  nlohmann::json Overview(int64_t max_count);
  int64_t Count();
  nlohmann::json Heatmap(std::optional<double> from_ts={},std::optional<double> to_ts={},int bucket_s=300);
  nlohmann::json ListPage(std::optional<std::string> cursor,int limit=20,
    double min_confidence=0,std::optional<double> from_ts={},std::optional<double> to_ts={});
  // Per-channel collection. Owner serializes with writes, replay and deletion.
  int64_t TrimHistory(int64_t max_count);
  // Rules must come from a validated, durably flushed HistoryDeletions journal.
  // Serialize with replay and deletion-intent mutation at the channel owner.
  int64_t ApplyDeletionRules(const std::string& rules_json);
 private:
  struct State;std::unique_ptr<State> state_;
};
}  // namespace ainvr
