// AINVR. Typed projection owned by the existing AI configuration client.
#pragma once
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>
#include <nlohmann/json_fwd.hpp>
#include "../../../search-service/src/model_pin.hpp"

namespace ai_service::config {
using SearchProducerClock = std::function<std::chrono::steady_clock::time_point()>;
struct SearchProducerLimits {
  int64_t producer_queue = 0, producer_bytes = 0, image_max_bytes = 0, retention_days = 0;
};
struct SearchProducerSampling {
  std::string mode;
  std::vector<std::string> channel_ids;
  bool object = false, scene = false;
  int64_t object_interval_ms = 0, scene_active_interval_ms = 0, scene_static_interval_ms = 0,
          scene_change_min_interval_ms = 0, track_slots = 8;
};
struct SearchProducerSource {
  std::string channel_id, input_stream_id, processor_id, recording_channel_id, input_path, output_path;
  bool object = false, scene = false;
};
struct SearchProducerGrant {
  std::string endpoint, api_token, revision, package_id;
  SearchProducerLimits limits;
  SearchProducerSampling sampling;
  // The frame's channel_id is a processor ID, NOT an AINVR output UUID.
  std::map<std::string, SearchProducerSource> sources;
  // One canonical identity, shared with the native service. Absent only for
  // legacy standalone fixtures; production receives the actual ACKed PG pin.
  std::optional<ainvr::search::RuntimeModelPin> expected_model{};
};
struct ParsedSearchProducerGrant {
  std::shared_ptr<const SearchProducerGrant> grant;
  std::string content_fingerprint, reason;
  std::chrono::milliseconds valid_for{0};
};
// Strict disjoint active/inactive contract; never returns credentials for an
// inactive response. Errors are fixed codes and never include input contents.
ParsedSearchProducerGrant ParseSearchProducerGrant(const nlohmann::json& document);
class SearchProducerGrantAuthority;
struct SearchProducerLease {
  std::shared_ptr<const SearchProducerGrant> grant;
  std::chrono::steady_clock::time_point valid_until;
  uint64_t fence = 0;
  // Retained snapshots must recheck before preparation and before submission.
  // Revocation, expiry, Stop and destruction also invalidate old lease copies.
  bool IsCurrent() const;
 private:
  std::weak_ptr<SearchProducerGrantAuthority> authority_;
  friend class SearchProducerGrantAuthority;
};
// Non-networking reader injected once through ChannelManager. Returning a
// revocable lease, rather than copying payloads, preserves authority lifetime.
using SearchProducerLeaseReader = std::function<std::optional<SearchProducerLease>()>;
// Shared revocation state only: no HTTP, poller, scheduler, model or disk I/O.
class SearchProducerGrantAuthority : public std::enable_shared_from_this<SearchProducerGrantAuthority> {
 public:
  explicit SearchProducerGrantAuthority(SearchProducerClock clock = {});
  void Start();
  void Stop();
  void Invalidate();
  bool Install(const ParsedSearchProducerGrant& parsed, std::chrono::steady_clock::time_point request_started);
  std::optional<SearchProducerLease> Read();
  bool IsCurrent(const SearchProducerLease& lease);
  std::chrono::steady_clock::time_point Now() const;
 private:
  void ClearLocked();
  bool FreshLocked();
  SearchProducerClock clock_;
  std::mutex mutex_;
  bool accepting_ = false;
  uint64_t fence_ = 0;
  std::chrono::steady_clock::time_point valid_until_{};
  std::shared_ptr<const SearchProducerGrant> grant_;
  // Hash only: disabled/pending never retains a secret or source mapping.
  // Remembering the last revision prevents a later same-revision mutation from
  // becoming accepted merely because an earlier bad response cleared the grant.
  std::string last_revision_, last_content_fingerprint_;
};
}  // namespace ai_service::config
