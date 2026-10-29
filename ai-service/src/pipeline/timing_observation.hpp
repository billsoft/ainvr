// Copyright AINVR. API-only diagnostics; never attach these to FrameResult.
#pragma once
#include "../utils/timing.hpp"
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <nlohmann/json.hpp>

namespace ai_service::pipeline {
struct TimingFrameIdentity {
  int64_t frame_index = 0, frame_pts_ns = -1;
  double captured_wall = 0;
  int64_t source_epoch = 0;
  std::optional<int64_t> stream_generation = std::nullopt;
};
enum class TimingStage : size_t {
  PrepareDispatch, AsyncResultWait, DispatchToResultReady,
  Preprocess, Inference,
  OutputDecode, HostPostprocess, Analytics, ObservationStage, EventOutboxStage,
  SeiStamp, SearchSamplingOffer, ReviewFrameOffer, SnapshotOffer,
  HostFrameWall, CallerFrameWall, Count
};
inline constexpr size_t kTimingStageCount = static_cast<size_t>(TimingStage::Count);
inline constexpr std::array<const char*, kTimingStageCount> kTimingStageNames{
  "prepare_dispatch", "async_result_wait", "dispatch_to_result_ready",
  "preprocess", "inference",
  "output_decode", "host_postprocess", "analytics", "observation_stage", "event_outbox_stage",
  "sei_stamp", "search_sampling_offer", "review_frame_offer", "snapshot_offer",
  "host_frame_wall", "caller_frame_wall"};
inline bool HasDiagnosticWindow(TimingStage stage) {
  // Reuse the original API's identical windows instead of adding samples twice.
  return stage != TimingStage::SeiStamp && stage != TimingStage::SnapshotOffer &&
      stage != TimingStage::CallerFrameWall && stage != TimingStage::Preprocess &&
      stage != TimingStage::Inference;
}
struct TimingStageSnapshot {
  size_t count = 0;
  uint64_t sample_count_since_start = 0;
  uint64_t over_250ms = 0, over_1000ms = 0; // stall counters since start
  double mean_ms = 0, p50_ms = 0, p95_ms = 0, latest_ms = 0, max_since_start_ms = 0;
  TimingFrameIdentity latest_frame, slowest_frame;
};
struct PreparedTimingObservation {
  TimingFrameIdentity frame;
  double result_timestamp_wall = 0;
  double preprocess_ms = 0, inference_ms = 0, output_decode_ms = 0, host_postprocess_ms = 0;
};
struct TimingObservationSnapshot {
  std::array<TimingStageSnapshot, kTimingStageCount> stages;
  std::optional<PreparedTimingObservation> latest;
};

// The worker's existing stats_mutex protects this fixed set of scalar records
// and TimingStats windows. It owns no files, worker threads, or work queues.
class TimingObservation {
 public:
  void Observe(TimingStage stage, double milliseconds, TimingFrameIdentity frame) noexcept {
    if (static_cast<size_t>(stage) >= stages_.size() || !std::isfinite(milliseconds) || milliseconds < 0) return;
    auto& value = stages_[static_cast<size_t>(stage)];
    try {
      if (HasDiagnosticWindow(stage)) value.window.Add(milliseconds);
    } catch (...) { return; } // Diagnostics cannot fail an inference/publication.
    if (value.sample_count_since_start == 0 || milliseconds > value.max_since_start_ms) {
      value.max_since_start_ms = milliseconds;
      value.slowest_frame = frame;
    }
    ++value.sample_count_since_start;
    if (milliseconds > 250.0) ++value.over_250ms;
    if (milliseconds > 1000.0) ++value.over_1000ms;
    value.latest_ms = milliseconds;
    value.latest_frame = frame;
  }
  void Prepared(PreparedTimingObservation observation) noexcept { latest_ = observation; }
  TimingObservationSnapshot Snapshot() const {
    TimingObservationSnapshot snapshot;
    snapshot.latest = latest_;
    for (size_t i = 0; i < stages_.size(); ++i) {
      const auto& stage = stages_[i];
      auto& out = snapshot.stages[i];
      out = static_cast<const TimingStageSnapshot&>(stage);
      out.count = stage.window.Count();
      out.mean_ms = stage.window.Mean();
      out.p50_ms = stage.window.P50();
      out.p95_ms = stage.window.P95();
    }
    return snapshot;
  }
 private:
  struct Stage : TimingStageSnapshot { utils::TimingStats window{200}; };
  std::array<Stage, kTimingStageCount> stages_;
  std::optional<PreparedTimingObservation> latest_;
};

inline nlohmann::json TimingFrameJson(const TimingFrameIdentity& frame) {
  return {{"frame_index", std::to_string(frame.frame_index)},
    {"frame_pts_ns", std::to_string(frame.frame_pts_ns)}, {"captured_wall", frame.captured_wall},
    {"source_epoch", std::to_string(frame.source_epoch)},
    {"stream_generation", frame.stream_generation ? nlohmann::json(std::to_string(*frame.stream_generation)) : nlohmann::json(nullptr)}};
}
inline nlohmann::json TimingWindowsJson(const TimingObservationSnapshot& snapshot) {
  nlohmann::json result = nlohmann::json::object();
  const auto rounded = [](double v) { return std::round(v * 100.0) / 100.0; };
  for (size_t i = 0; i < kTimingStageCount; ++i) {
    if (!HasDiagnosticWindow(static_cast<TimingStage>(i))) continue;
    const auto& stage = snapshot.stages[i];
    result[kTimingStageNames[i]] = {{"count", stage.count}, {"mean_ms", rounded(stage.mean_ms)},
      {"p50_ms", rounded(stage.p50_ms)}, {"p95_ms", rounded(stage.p95_ms)}};
  }
  return result;
}
inline nlohmann::json TimingObservationJson(const TimingObservationSnapshot& snapshot) {
  nlohmann::json result = {{"schema_version", "1.0"}, {"window_size", 200},
    {"scope", "worker_api_only"}, {"clock", "steady_clock_durations; system_clock_wall_timestamps"},
    {"legacy_result_timing_ms", "preprocess/inference/postprocess are rolling_200_sample_means; other legacy fields unchanged"},
    {"result_timestamp_semantics", "FrameResult.timestamp assigned after host postprocess; not capture time"},
    {"latest_semantics", "last SDK result reaching FrameResult construction; not publication confirmation"},
    {"stage_semantics", {{"prepare_dispatch", "RunFrame or RunFrameAsync call wall time; async dispatch belongs to the newly submitted frame"},
      {"async_result_wait", "future.get wall time for the frame being collected; absent on synchronous calls"},
      {"dispatch_to_result_ready", "dispatch start to ready result, including overlapped pipeline residency; not exclusive wait"},
      {"preprocess", "SDK-reported prepared.preprocess_ms; legacy timing window reused"},
      {"inference", "SDK-reported prepared.inference_ms; not host dispatch/get wait; legacy timing window reused"},
      {"host_postprocess", "both exported and tracking-candidate host postprocess; excludes SDK output_decode"},
      {"analytics", "analytics reset/init, tracking Apply and event/archive linking"},
      {"observation_stage", "only synchronous ObservationJournal::Stage calls, including failures; excludes skipped calls"},
      {"event_outbox_stage", "event policy metadata, synchronous Submit calls and outbox status snapshot; not delivery worker time"},
      {"review_frame_offer", "synchronous review cache Offer only; not background review model time"},
      {"host_frame_wall", "InferOneFrame host wall time, after SDK result readiness; includes synchronous downstream work"},
      {"caller_frame_wall", "same interval as legacy infer_total; includes async pipeline residency"},
      {"sei_stamp", "legacy publication-lock, result append, SEI stamp and search binding interval"},
      {"optional_stages", "only executed stages have samples; failures also contribute; overlapping stages are not additive"}}},
    {"latest", nullptr}, {"stages", nlohmann::json::object()}};
  for (size_t i = 0; i < kTimingStageCount; ++i) {
    const auto& stage = snapshot.stages[i];
    result["stages"][kTimingStageNames[i]] = {{"sample_count_since_start", stage.sample_count_since_start},
      {"over_250ms", stage.over_250ms}, {"over_1000ms", stage.over_1000ms},
      {"latest_ms", stage.sample_count_since_start ? nlohmann::json(stage.latest_ms) : nlohmann::json(nullptr)},
      {"latest_frame", stage.sample_count_since_start ? TimingFrameJson(stage.latest_frame) : nlohmann::json(nullptr)},
      {"max_since_start_ms", stage.sample_count_since_start ? nlohmann::json(stage.max_since_start_ms) : nlohmann::json(nullptr)},
      {"slowest_frame", stage.sample_count_since_start ? TimingFrameJson(stage.slowest_frame) : nlohmann::json(nullptr)}};
  }
  if (snapshot.latest) {
    const auto& value = *snapshot.latest;
    result["latest"] = {{"frame", TimingFrameJson(value.frame)},
      {"result_timestamp_wall", value.result_timestamp_wall},
      {"actual_ms", {{"preprocess", value.preprocess_ms}, {"inference", value.inference_ms},
        {"output_decode", value.output_decode_ms}, {"host_postprocess", value.host_postprocess_ms}}}};
  }
  return result;
}

// A scope always reports duration, including exception unwinding/early return.
template<class Observer, class Clock = std::chrono::steady_clock>
class ScopedTimingObservation {
 public:
  explicit ScopedTimingObservation(Observer observer)
    : observer_(std::move(observer)), start_(Clock::now()) {}
  ~ScopedTimingObservation() noexcept {
    try { observer_(std::chrono::duration<double, std::milli>(Clock::now() - start_).count()); }
    catch (...) {} // Diagnostic allocation/locking failures cannot change business behavior.
  }
  ScopedTimingObservation(const ScopedTimingObservation&) = delete;
  ScopedTimingObservation& operator=(const ScopedTimingObservation&) = delete;
 private:
  Observer observer_;
  typename Clock::time_point start_;
};
} // namespace ai_service::pipeline
