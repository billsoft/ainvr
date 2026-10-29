// AINVR. Metadata-only key-frame admission. No image work, models or storage.
#pragma once
#include "observation_evidence.hpp"
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <mutex>
#include <new>
#include <optional>
#include <utility>

namespace ai_service::output {
struct SearchSamplingBinding {
  std::string source_input_id, processor_id, stream_session_id;
  int width = 0, height = 0;
  bool operator==(const SearchSamplingBinding& other) const {
    return source_input_id == other.source_input_id && processor_id == other.processor_id &&
      stream_session_id == other.stream_session_id && width == other.width && height == other.height;
  }
};
struct SearchSamplingFrame {
  SearchSamplingBinding binding;
  int64_t source_pts_ns = -1, source_frame_index = -1, captured_ms = -1;
  std::string analytics_status;
};
struct SearchSamplingObject {
  std::string track_id, state, observation;
  int64_t last_observed_pts_ns = -1;
  bool public_detection = false, usable = false;
  // Supplied by a separately validated quality/change producer. Neither detector
  // confidence nor box overlap is silently converted into image quality here.
  std::optional<double> quality, change;
  std::string processor_id, stream_session_id;
  int64_t source_frame_index = -1;
  std::string probe_reference_fingerprint{};
};
struct SearchSamplingScene {
  bool usable = false, active = false;
  std::optional<double> change;
  std::string probe_reference_fingerprint{};
};
struct SearchSamplingConfig {
  size_t max_sources = 128, max_tracks = 4096, max_pending = 1;
  // Metadata count is not a raw-frame memory allowance. The owner must also
  // reserve frame bytes and shared hardware capacity before retaining pixels.
  int64_t object_interval_ns = 1000000000LL;
  // Experiment starting points from the design, not a validated accuracy claim.
  int64_t scene_active_interval_ns = 10000000000LL, scene_static_interval_ns = 60000000000LL;
  int64_t scene_change_interval_ns = 3000000000LL;
  double object_change_threshold = 0.25, scene_change_threshold = 0.25;
};
class SearchSamplingPolicy {
 public:
  // Owner lifetime includes its callbacks. Process-local monotonic operation
  // fences also reject callbacks accidentally retargeted to a replacement owner;
  // these are never a tracking/session identity or a durable request protocol.
  using Token = uint64_t;
  enum class Reason { First, Best, Change, SceneFirst, SceneInterval, SceneChange, ObjectProbe, SceneProbe };
  enum class Status { Proposed, Pending, NotEligible, NotDue, Unbound, StaleFrame, Capacity, Invalid, Busy };
  enum class Outcome { Committed, Failed, Unknown, NoChange, Abandoned };
  struct Candidate {
    Token token = 0;
    SearchSamplingFrame frame;
    std::string track_id;
    std::optional<size_t> slot;
    Reason reason = Reason::First;
    std::optional<double> quality, change;
    std::string expected_fingerprint;
    std::string probe_reference_fingerprint{};
    double probe_threshold=.25;
  };
  struct Proposal { Status status; std::optional<Candidate> candidate{}; };
  struct Slot {
    int64_t source_pts_ns = -1, source_frame_index = -1, captured_ms = -1;
    std::optional<double> quality, change;
    std::string fingerprint;
  };
  struct TrackSnapshot {
    std::array<std::optional<Slot>, 8> slots{};
    std::optional<double> best_quality;
    int64_t last_committed_pts_ns = -1;
    int64_t last_probe_attempt_pts_ns=-1,last_checked_pts_ns=-1;
    Token pending = 0;
    size_t Count() const { size_t n = 0; for (const auto& slot : slots) if (slot) ++n; return n; }
  };
  struct Counters { size_t sources = 0, tracks = 0, pending = 0; };
  static bool IsProbe(const Candidate& c){return c.reason==Reason::ObjectProbe||c.reason==Reason::SceneProbe;}
  static bool ProbeContractValid(const Candidate& c){return IsProbe(c)&&FingerprintValid(c.probe_reference_fingerprint)&&
    Measure(c.probe_threshold)&&(c.reason==Reason::ObjectProbe?
      (c.slot&&*c.slot>=2&&*c.slot<8&&!c.track_id.empty()):(!c.slot&&c.track_id.empty()));}

  explicit SearchSamplingPolicy(SearchSamplingConfig config = {}): config_(config) {
    if (!config.max_sources || config.max_sources > 1024 || !config.max_tracks || config.max_tracks > 65536 ||
        !config.max_pending || config.max_pending > config.max_sources + config.max_tracks ||
        config.object_interval_ns < 0 || config.scene_active_interval_ns <= 0 || config.scene_static_interval_ns <= 0 ||
        config.scene_change_interval_ns <= 0 || !Measure(config.object_change_threshold) || !Measure(config.scene_change_threshold))
      throw std::invalid_argument("invalid_search_sampling_config");
  }
  SearchSamplingPolicy(const SearchSamplingPolicy&) = delete;
  SearchSamplingPolicy& operator=(const SearchSamplingPolicy&) = delete;

  // Timing/threshold hot updates preserve committed slots, pending CAS tokens,
  // source identity and capacity. A normal grant refresh must not forget first.
  bool UpdateTiming(const SearchSamplingConfig& config) {
    if (config.object_interval_ns < 0 || config.scene_active_interval_ns <= 0 ||
        config.scene_static_interval_ns <= 0 || config.scene_change_interval_ns <= 0 ||
        !Measure(config.object_change_threshold) || !Measure(config.scene_change_threshold)) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    config_.object_interval_ns = config.object_interval_ns;
    config_.scene_active_interval_ns = config.scene_active_interval_ns;
    config_.scene_static_interval_ns = config.scene_static_interval_ns;
    config_.scene_change_interval_ns = config.scene_change_interval_ns;
    config_.object_change_threshold = config.object_change_threshold;
    config_.scene_change_threshold = config.scene_change_threshold;
    return true;
  }

  // Called by the worker's synchronous lifecycle boundary, never inferred from
  // a newly received frame. A late frame cannot roll a new session back.
  // One owner/model-input space per policy: changing the embedding package,
  // tokenizer or preprocessing contract requires ResetSource/rebuilding the
  // owner. Never carry old-space slot fingerprints into the new space; this
  // lifecycle rule does not create or replace an analytics tracking identity.
  bool BindSource(const SearchSamplingBinding& binding) {
    if (!BindingValid(binding)) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    const auto key = Key(binding); auto found = sources_.find(key);
    if (found != sources_.end() && found->second.binding == binding) return true;
    if (found == sources_.end() && sources_.size() >= config_.max_sources) return false;
    Source source; source.binding = binding;
    if (found != sources_.end()) RemovePending(found->second);
    sources_.insert_or_assign(key, std::move(source));
    return true;
  }
  void ResetSource(const std::string& source_input_id, const std::string& processor_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = sources_.find({source_input_id, processor_id});
    if (found == sources_.end()) return;
    RemovePending(found->second); sources_.erase(found);
  }
  // The authoritative tracker owner retires expired IDs. Live/unknown states
  // are never evicted merely to make a capacity number look available.
  bool RetireTrack(const SearchSamplingBinding& binding, const std::string& track_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto source = Bound(binding); if (!source) return false;
    const auto found = source->tracks.find(track_id); if (found == source->tracks.end()) return false;
    if (found->second.pending) pending_.erase(found->second.pending);
    source->tracks.erase(found); --tracks_;
    return true;
  }
  Proposal ProposeObject(const SearchSamplingFrame& frame, const SearchSamplingObject& object) {
    if (!OptionalMeasure(object.quality) || !OptionalMeasure(object.change) || !Identity(object.track_id)||
        (!object.probe_reference_fingerprint.empty()&&!FingerprintValid(object.probe_reference_fingerprint))) return {Status::Invalid};
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock); if (!lock.owns_lock()) return {Status::Busy};
    Source* source = nullptr; const auto validity = AcceptFrame(frame, source);
    if (validity != Status::Proposed) return {validity};
    if (frame.analytics_status != "active" || !object.usable || !object.public_detection ||
        object.state != "confirmed" || object.observation != "detected" || object.last_observed_pts_ns != frame.source_pts_ns ||
        object.processor_id != frame.binding.processor_id || object.stream_session_id != frame.binding.stream_session_id ||
        object.source_frame_index != frame.source_frame_index)
      return {Status::NotEligible};
    auto found = source->tracks.find(object.track_id);
    if (found != source->tracks.end() && found->second.pending) return {Status::Pending};
    const TrackSnapshot empty;
    const auto& track = found == source->tracks.end() ? empty : found->second;
    if (track.last_committed_pts_ns >= 0 && (frame.source_pts_ns <= track.last_committed_pts_ns ||
        frame.source_pts_ns - track.last_committed_pts_ns < config_.object_interval_ns)) return {Status::NotDue};
    Candidate candidate; candidate.frame = frame; candidate.track_id = object.track_id;
    candidate.quality = object.quality; candidate.change = object.change;
    if (!track.slots[0]) { candidate.slot = 0; candidate.reason = Reason::First; }
    else if (object.quality && (!track.best_quality || *object.quality > *track.best_quality)) {
      candidate.slot = 1; candidate.reason = Reason::Best;
    } else if ((object.change && *object.change >= config_.object_change_threshold)||
        (!object.probe_reference_fingerprint.empty()&&(track.last_probe_attempt_pts_ns<0||
          (frame.source_pts_ns>track.last_probe_attempt_pts_ns&&frame.source_pts_ns-track.last_probe_attempt_pts_ns>=config_.object_interval_ns)))) {
      size_t slot = 2;
      while (slot < 8 && track.slots[slot]) ++slot;
      if (slot == 8) {
        slot = 2;
        for (size_t n = 3; n < 8; ++n)
          if (track.slots[n]->source_pts_ns < track.slots[slot]->source_pts_ns) slot = n;
      }
      candidate.slot = slot;
      candidate.reason=object.change&&*object.change>=config_.object_change_threshold?Reason::Change:Reason::ObjectProbe;
      if(IsProbe(candidate)){candidate.change.reset();candidate.probe_reference_fingerprint=object.probe_reference_fingerprint;candidate.probe_threshold=config_.object_change_threshold;}
    } else return {Status::NotDue};
    if (pending_.size() >= config_.max_pending ||
        (found == source->tracks.end() && tracks_ >= config_.max_tracks))
      return {Status::Capacity};
    if (track.slots[*candidate.slot]) candidate.expected_fingerprint = track.slots[*candidate.slot]->fingerprint;
    candidate.token = NewToken(); if (!candidate.token) return {Status::Capacity};
    bool created = false;
    try {
      // Prepare all potentially allocating copies before exposing a reservation.
      Proposal proposal{Status::Proposed, candidate}; Pending pending{candidate, false};
      if (found == source->tracks.end()) {
        found = source->tracks.emplace(object.track_id, TrackSnapshot{}).first; ++tracks_; created = true;
      }
      pending_.emplace(candidate.token, std::move(pending));
      found->second.pending = candidate.token;
      if(IsProbe(candidate))found->second.last_probe_attempt_pts_ns=frame.source_pts_ns;
      return proposal;
    } catch (const std::bad_alloc&) {
      if (created) { source->tracks.erase(found); --tracks_; }
      return {Status::Capacity};
    }
  }
  Proposal ProposeScene(const SearchSamplingFrame& frame, const SearchSamplingScene& scene) {
    if (!OptionalMeasure(scene.change)||(!scene.probe_reference_fingerprint.empty()&&!FingerprintValid(scene.probe_reference_fingerprint))) return {Status::Invalid};
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock); if (!lock.owns_lock()) return {Status::Busy};
    Source* source = nullptr; const auto validity = AcceptFrame(frame, source);
    if (validity != Status::Proposed) return {validity};
    if (!scene.usable || (frame.analytics_status != "active" && frame.analytics_status != "detection_only")) return {Status::NotEligible};
    if(frame.source_pts_ns<=source->scene_retired_pts_ns||frame.source_frame_index<=source->scene_retired_frame_index)
      return {Status::NotDue};
    if (source->scene_pending) return {Status::Pending};
    Reason reason = Reason::SceneFirst;
    if (source->scene_committed_pts_ns >= 0) {
      if (frame.source_pts_ns <= source->scene_committed_pts_ns) return {Status::NotDue};
      const auto elapsed = frame.source_pts_ns - source->scene_committed_pts_ns;
      const auto interval = scene.active ? config_.scene_active_interval_ns : config_.scene_static_interval_ns;
      if (elapsed >= interval) reason = Reason::SceneInterval;
      else if (scene.change && *scene.change >= config_.scene_change_threshold && elapsed >= config_.scene_change_interval_ns)
        reason = Reason::SceneChange;
      else if(!scene.probe_reference_fingerprint.empty()&&elapsed>=config_.scene_change_interval_ns&&
          (source->scene_probe_attempt_pts_ns<0||(frame.source_pts_ns>source->scene_probe_attempt_pts_ns&&
            frame.source_pts_ns-source->scene_probe_attempt_pts_ns>=config_.scene_change_interval_ns)))reason=Reason::SceneProbe;
      else return {Status::NotDue};
    }
    if (pending_.size() >= config_.max_pending) return {Status::Capacity};
    Candidate candidate; candidate.token = NewToken(); if (!candidate.token) return {Status::Capacity};
    candidate.frame = frame;
    candidate.reason = reason; candidate.change = scene.change;
    if(IsProbe(candidate)){candidate.change.reset();candidate.probe_reference_fingerprint=scene.probe_reference_fingerprint;candidate.probe_threshold=config_.scene_change_threshold;}
    try {
      Proposal proposal{Status::Proposed, candidate}; Pending pending{candidate, false};
      pending_.emplace(candidate.token, std::move(pending));
      source->scene_pending = candidate.token;
      if(IsProbe(candidate))source->scene_probe_attempt_pts_ns=frame.source_pts_ns;
      return proposal;
    } catch (const std::bad_alloc&) { return {Status::Capacity}; }
  }
  // Committed means Mongo has acknowledged the matching image/vector/metadata.
  // Failed means definitely not committed (admission/encoding/authoritative
  // rejection). A timeout is Unknown, never Failed. Retain the exact frame/job
  // externally, then Retry with the same token/body; this class owns no pixels.
  // Abandoned cancels ONLY an uncertain scene's local metadata, without saying
  // whether it committed. Its capture identity can never be proposed again.
  // An uncertain object must retire its whole track, preserving the slot fence.
  // The job must retain that frame AND its matching Detection/crop transform;
  // looking up the latest box for track_id after admission is not permitted.
  bool Resolve(Token token, Outcome outcome, const std::string& fingerprint = "") {
    if ((outcome != Outcome::Committed && outcome != Outcome::Failed && outcome != Outcome::Unknown&&outcome!=Outcome::NoChange&&outcome!=Outcome::Abandoned) ||
        (outcome == Outcome::Committed && !FingerprintValid(fingerprint)) ||
        (outcome != Outcome::Committed && !fingerprint.empty())) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    auto found = pending_.find(token); if (found == pending_.end()) return false;
    const auto& candidate = found->second.candidate;
    if(outcome==Outcome::Abandoned&&(!found->second.unknown||candidate.slot))return false;
    if(outcome==Outcome::NoChange&&(!IsProbe(candidate)||found->second.unknown))return false;
    if (outcome == Outcome::Committed && !candidate.expected_fingerprint.empty() &&
        candidate.expected_fingerprint == fingerprint) return false;
    auto source = Bound(candidate.frame.binding); if (!source) return false;
    if (outcome == Outcome::Unknown) { found->second.unknown = true; return true; }
    if (candidate.slot) {
      auto track = source->tracks.find(candidate.track_id);
      if (track == source->tracks.end() || track->second.pending != token) return false;
      if (outcome == Outcome::Committed) {
        Slot committed{candidate.frame.source_pts_ns, candidate.frame.source_frame_index,
          candidate.frame.captured_ms, candidate.quality, candidate.change, fingerprint};
        track->second.slots[*candidate.slot] = std::move(committed);
        track->second.last_committed_pts_ns = candidate.frame.source_pts_ns;
        if (candidate.quality && (!track->second.best_quality || *candidate.quality > *track->second.best_quality))
          track->second.best_quality = candidate.quality;
      }
      if(IsProbe(candidate)&&(outcome==Outcome::Committed||outcome==Outcome::NoChange))track->second.last_checked_pts_ns=candidate.frame.source_pts_ns;
      track->second.pending = 0;
      if (track->second.Count() == 0) { source->tracks.erase(track); --tracks_; }
    } else {
      if (source->scene_pending != token) return false;
      if (outcome == Outcome::Committed) source->scene_committed_pts_ns = candidate.frame.source_pts_ns;
      if(outcome==Outcome::Abandoned){
        source->scene_retired_pts_ns=std::max(source->scene_retired_pts_ns,candidate.frame.source_pts_ns);
        source->scene_retired_frame_index=std::max(source->scene_retired_frame_index,candidate.frame.source_frame_index);
      }
      if(IsProbe(candidate)&&(outcome==Outcome::Committed||outcome==Outcome::NoChange))source->scene_checked_pts_ns=candidate.frame.source_pts_ns;
      source->scene_pending = 0;
    }
    pending_.erase(found);
    return true;
  }
  std::optional<Candidate> Retry(Token token) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = pending_.find(token);
    if (found == pending_.end() || !found->second.unknown) return std::nullopt;
    return found->second.candidate;
  }
  std::optional<TrackSnapshot> Inspect(const SearchSamplingBinding& binding, const std::string& track_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto source = sources_.find(Key(binding));
    if (source == sources_.end() || !(source->second.binding == binding)) return std::nullopt;
    const auto found = source->second.tracks.find(track_id);
    return found == source->second.tracks.end() ? std::nullopt : std::optional<TrackSnapshot>(found->second);
  }
  Counters Usage() const {
    std::lock_guard<std::mutex> lock(mutex_); return {sources_.size(), tracks_, pending_.size()};
  }
  // Read the existing shared analytics schema instead of generating identities
  // or trying to associate detections a second time.
  static std::optional<SearchSamplingFrame> FrameFromResult(const FrameResult& result,
      const std::string& source_input_id, int64_t captured_ms) {
    try {
      const auto& analytics = result.model_extra.at("analytics");
      SearchSamplingFrame frame{{source_input_id, result.channel_id, analytics.at("stream_session_id").get<std::string>(),
        result.frame_width, result.frame_height}, result.frame_pts_ns, result.frame_index, captured_ms,
        analytics.at("status").get<std::string>()};
      if (!BindingValid(frame.binding) || frame.source_pts_ns < 0 || frame.source_frame_index < 0 || captured_ms < 0) return std::nullopt;
      return frame;
    } catch (...) { return std::nullopt; }
  }
  static std::optional<SearchSamplingObject> ObjectFromResult(const FrameResult& result,
      const std::string& track_id, bool usable, std::optional<double> quality = {}, std::optional<double> change = {}) {
    try {
      const auto& tracks = result.model_extra.at("analytics").at("tracks");
      if (!tracks.is_array() || tracks.size() > 1000 || result.detections.size() > 1000 || !Identity(track_id)) return std::nullopt;
      std::optional<SearchSamplingObject> found;
      for (const auto& track : tracks) if (track.at("track_id") == track_id) {
        if (found) return std::nullopt;
        const auto public_count = std::count_if(result.detections.begin(), result.detections.end(),
          [&](const Detection& detection) { return detection.track_id == track_id; });
        found = SearchSamplingObject{track_id, track.at("state"), track.at("observation"),
          EvidenceInteger(track.at("last_observed_pts_ns").get<std::string>()), public_count == 1, usable, quality, change,
          result.channel_id, result.model_extra.at("analytics").at("stream_session_id").get<std::string>(), result.frame_index};
      }
      return found;
    } catch (...) { return std::nullopt; }
  }
 private:
  using SourceKey = std::pair<std::string, std::string>;
  struct Source {
    SearchSamplingBinding binding;
    int64_t highest_pts_ns = -1, highest_frame_index = -1, scene_committed_pts_ns = -1;
    int64_t scene_probe_attempt_pts_ns=-1,scene_checked_pts_ns=-1;
    int64_t scene_retired_pts_ns=-1,scene_retired_frame_index=-1;
    std::map<std::string, TrackSnapshot> tracks;
    Token scene_pending = 0;
  };
  struct Pending { Candidate candidate; bool unknown; };
  static Token NewToken() noexcept {
    auto token = next_token_.load(std::memory_order_relaxed);
    while (token != std::numeric_limits<Token>::max())
      if (next_token_.compare_exchange_weak(token, token + 1, std::memory_order_relaxed)) return token;
    return 0; // Never wrap and accept an earlier operation's acknowledgement.
  }
  static SourceKey Key(const SearchSamplingBinding& binding) { return {binding.source_input_id, binding.processor_id}; }
  static bool Identity(const std::string& value) {
    try { EvidenceIdentity(value); return value.size() <= 256; } catch (...) { return false; }
  }
  static bool BindingValid(const SearchSamplingBinding& binding) {
    return Identity(binding.source_input_id) && Identity(binding.processor_id) && Identity(binding.stream_session_id) &&
      binding.width > 0 && binding.height > 0 && binding.width <= 16384 && binding.height <= 16384;
  }
  static bool Measure(double value) { return std::isfinite(value) && value >= 0 && value <= 1; }
  static bool OptionalMeasure(const std::optional<double>& value) { return !value || Measure(*value); }
  static bool FingerprintValid(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
      return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
  }
  Source* Bound(const SearchSamplingBinding& binding) {
    const auto found = sources_.find(Key(binding));
    return found == sources_.end() || !(found->second.binding == binding) ? nullptr : &found->second;
  }
  Status AcceptFrame(const SearchSamplingFrame& frame, Source*& source) {
    if (!BindingValid(frame.binding) || frame.source_pts_ns < 0 || frame.source_frame_index < 0 || frame.captured_ms < 0)
      return Status::Invalid;
    source = Bound(frame.binding); if (!source) return Status::Unbound;
    if (frame.source_pts_ns < source->highest_pts_ns || frame.source_frame_index < source->highest_frame_index ||
        ((frame.source_pts_ns == source->highest_pts_ns) != (frame.source_frame_index == source->highest_frame_index)))
      return Status::StaleFrame;
    // Equal PTS/index is allowed for multiple objects and scene on one frame.
    source->highest_pts_ns = frame.source_pts_ns; source->highest_frame_index = frame.source_frame_index;
    return Status::Proposed;
  }
  void RemovePending(Source& source) {
    for (const auto& [_, track] : source.tracks) if (track.pending) pending_.erase(track.pending);
    if (source.scene_pending) pending_.erase(source.scene_pending);
    tracks_ -= source.tracks.size();
  }
  SearchSamplingConfig config_;
  mutable std::mutex mutex_;
  std::map<SourceKey, Source> sources_;
  std::map<Token, Pending> pending_;
  size_t tracks_ = 0;
  inline static std::atomic<Token> next_token_{1};
};
}  // namespace ai_service::output
