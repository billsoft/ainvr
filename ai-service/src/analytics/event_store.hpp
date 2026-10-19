// AINVR analytics events: immutable identity, durable insert, bounded queries.
#pragma once
#include <nlohmann/json.hpp>
#include <memory>
#include <string>
#include <optional>
#include <vector>
namespace ai_service::analytics {
class EventStore {
 public:
  EventStore(const std::string& uri,const std::string& database,const std::string& collection);
  ~EventStore();
  EventStore(const EventStore&)=delete;
  EventStore& operator=(const EventStore&)=delete;
  void Put(const nlohmann::json& event);
  nlohmann::json List(const std::string& channel,int limit=50);
  struct Evidence {
    std::string image_id;
    int width=0,height=0;
    std::vector<uint8_t> jpeg;
  };
  // Original target crop only. No latest-image or enhanced-image fallback.
  std::optional<Evidence> LoadEvidence(const nlohmann::json& event);
  // Stages are review/notification. Caller must validate policy and evidence
  // before queuing. Lease tokens are unique per attempt, never worker IDs.
  void AdvanceNotifications(const std::string& channel);
  bool QueueJob(const std::string& event_id,const std::string& stage);
  nlohmann::json ReadyJobs(const std::string& channel,const std::string& stage,
                           double now,int limit=20);
  bool ClaimJob(const std::string& event_id,const std::string& stage,
                const std::string& lease_token,double now,double lease_seconds);
  bool FinishJob(const std::string& event_id,const std::string& stage,
                 const std::string& lease_token,double now,
                 const std::string& outcome,const nlohmann::json& result);
 private:
  bool UpdateJob(const nlohmann::json& filter,const nlohmann::json& update);
  struct State;
  std::unique_ptr<State> state_;
};
}
