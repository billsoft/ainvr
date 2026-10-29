// Copyright AINVR. Control-plane contract; platform workers own hardware resources.
#pragma once
#include <functional>
#include <memory>
#include <set>
#include <string>
#include "../config/config.hpp"
#include "../config/search_producer_grant.hpp"
#include "../output/result_buffer.hpp"
#include "snapshot_sink.hpp"
namespace ai_service::output { class SearchSamplingOwner; class SearchSamplingSource; }

namespace ai_service::pipeline {
enum class ChannelState { kIdle, kStarting, kRunning, kError, kStopping, kReconnecting };
std::string ToString(ChannelState state);
class ChannelWorker {
 public:
  virtual ~ChannelWorker() = default;
  virtual void Start() = 0;
  // Check execution availability before persisting operator start intent.
  virtual void ValidateStart() const {}
  // Platform-specific snapshot resources; validates a proposed configuration
  // before the controller persists an update to an executing channel.
  virtual void ValidateSnapshotResources(const config::ChannelConfig&) const {}
  virtual void Stop() = 0;
  // Invalidate tracking before the next observation without reconnecting media
  // or rebuilding the model. False means the worker cannot honour the request.
  virtual bool SupportsAnalyticsReset() const { return false; }
  virtual bool ResetAnalytics(const std::string&) { return false; }
  virtual ChannelState State() const = 0;
  virtual void SetLicenseCheck(std::function<bool()> check) = 0;
  // Optional extension; unsupported/legacy workers remain inert. Inject before
  // Start, just like the existing licence callback, never while threads run.
  virtual void SetSearchProducerLeaseReader(config::SearchProducerLeaseReader) {}
  virtual void SetSearchSamplingSource(std::shared_ptr<output::SearchSamplingSource>) {}
  virtual void SetSnapshotSink(std::shared_ptr<SnapshotSink> sink) = 0;
  virtual std::shared_ptr<const config::ChannelConfig> Config() const = 0;
  virtual void ApplyHotPatch(const config::ChannelConfig&, const std::set<std::string>&) = 0;
  virtual nlohmann::json GetStats() const = 0;
  virtual ResultBuffer& GetResultBuffer() = 0;
};
}
