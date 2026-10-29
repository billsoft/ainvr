// Copyright AINVR. Pure diagnostics contract; no decoder, inference or disk IO.
#include "pipeline/timing_observation.hpp"
#include <gtest/gtest.h>
#include <limits>
#include <stdexcept>
using namespace ai_service::pipeline;
namespace {
TimingFrameIdentity Identity(int64_t index = 1) { return {index, 9007199254740993LL + index, 1793232000.125, 7, 9}; }
struct ManualClock {
  using duration = std::chrono::nanoseconds;
  using time_point = std::chrono::time_point<ManualClock>;
  inline static time_point value{};
  static time_point now() { return value; }
};
}
TEST(TimingObservation, EmptyOptionalStagesAreUnavailableRatherThanMeasuredZero) {
  TimingObservation observation;
  const auto snapshot = observation.Snapshot();
  const auto api = TimingObservationJson(snapshot);
  EXPECT_EQ(api.at("schema_version"), "1.0");
  EXPECT_EQ(api.at("scope"), "worker_api_only");
  EXPECT_TRUE(api.at("latest").is_null());
  EXPECT_EQ(api.at("stages").size(), kTimingStageCount);
  for (const auto& stage : api.at("stages")) {
    EXPECT_EQ(stage.at("sample_count_since_start"), 0);
    EXPECT_TRUE(stage.at("latest_ms").is_null());
    EXPECT_TRUE(stage.at("max_since_start_ms").is_null());
    EXPECT_TRUE(stage.at("slowest_frame").is_null());
  }
}
TEST(TimingObservation, ActualPreparedFrameIsSeparateFromLegacyRollingMeansAndWallTimestamp) {
  TimingObservation observation;
  ai_service::utils::TimingStats legacy(200);
  legacy.Add(1); legacy.Add(2); legacy.Add(90);
  observation.Prepared({Identity(), 1793232002.191, 90, 15, 3, 4});
  const auto latest = TimingObservationJson(observation.Snapshot()).at("latest");
  EXPECT_EQ(legacy.Mean(), 31);
  EXPECT_EQ(latest.at("actual_ms").at("preprocess"), 90);
  EXPECT_EQ(latest.at("actual_ms").at("inference"), 15);
  EXPECT_EQ(latest.at("actual_ms").at("output_decode"), 3);
  EXPECT_EQ(latest.at("actual_ms").at("host_postprocess"), 4);
  EXPECT_EQ(latest.at("frame").at("captured_wall"), 1793232000.125);
  EXPECT_EQ(latest.at("result_timestamp_wall"), 1793232002.191);
  EXPECT_EQ(latest.at("frame").at("frame_pts_ns"), "9007199254740994");
  EXPECT_EQ(latest.at("frame").at("source_epoch"), "7");
  EXPECT_EQ(latest.at("frame").at("stream_generation"), "9");
  auto unknown = Identity(); unknown.stream_generation.reset();
  EXPECT_TRUE(TimingFrameJson(unknown).at("stream_generation").is_null());
}
TEST(TimingObservation, RareStallRetainsMaximumAndExactFrameAfterWindowEvictionUntilStartReset) {
  TimingObservation observation;
  observation.Observe(TimingStage::ObservationStage, 2066.125, Identity(17));
  for (int n = 0; n < 201; ++n) observation.Observe(TimingStage::ObservationStage, 10, Identity(100 + n));
  const auto snapshot = observation.Snapshot();
  const auto window = TimingWindowsJson(snapshot).at("observation_stage");
  EXPECT_EQ(window.at("count"), 200);
  EXPECT_EQ(window.at("p95_ms"), 10);
  const auto peak = TimingObservationJson(snapshot).at("stages").at("observation_stage");
  EXPECT_EQ(peak.at("sample_count_since_start"), 202);
  EXPECT_EQ(peak.at("max_since_start_ms"), 2066.125);
  EXPECT_EQ(peak.at("slowest_frame").at("frame_index"), "17");
  EXPECT_EQ(peak.at("latest_frame").at("frame_index"), "300");
  observation = TimingObservation{}; // Same reset used by Start().
  EXPECT_TRUE(TimingObservationJson(observation.Snapshot()).at("stages").at("observation_stage").at("slowest_frame").is_null());
  EXPECT_EQ(TimingWindowsJson(observation.Snapshot()).at("observation_stage").at("count"), 0);
}
TEST(TimingObservation, WindowsReuseExistingPercentileAndRoundingContract) {
  TimingObservation observation;
  ai_service::utils::TimingStats expected(200);
  for (double ms : {1.123, 4.567, 2.348, 9.123}) {
    observation.Observe(TimingStage::Analytics, ms, Identity()); expected.Add(ms);
  }
  EXPECT_EQ(TimingWindowsJson(observation.Snapshot()).at("analytics"), expected.ToDict());
  observation.Observe(TimingStage::SeiStamp, 32, Identity());
  observation.Observe(TimingStage::SnapshotOffer, 42, Identity());
  observation.Observe(TimingStage::CallerFrameWall, 52, Identity());
  observation.Observe(TimingStage::Preprocess, 62, Identity());
  observation.Observe(TimingStage::Inference, 72, Identity());
  const auto snapshot = observation.Snapshot();
  const auto windows = TimingWindowsJson(snapshot);
  EXPECT_FALSE(windows.contains("sei_stamp"));
  EXPECT_FALSE(windows.contains("snapshot_offer"));
  EXPECT_FALSE(windows.contains("caller_frame_wall"));
  EXPECT_FALSE(windows.contains("preprocess"));
  EXPECT_FALSE(windows.contains("inference"));
  EXPECT_EQ(TimingObservationJson(snapshot).at("stages").at("sei_stamp").at("max_since_start_ms"), 32);
}
TEST(TimingObservation, ScopeRecordsExceptionAndUsesElapsedSteadyClockInsteadOfSdkTiming) {
  TimingObservation observation;
  ManualClock::value = {};
  auto record = [&](double ms) { observation.Observe(TimingStage::AsyncResultWait, ms, Identity(2)); };
  EXPECT_THROW(( [&] {
    ScopedTimingObservation<decltype(record), ManualClock> timer(record);
    ManualClock::value += std::chrono::milliseconds(2066);
    throw std::runtime_error("test-only failed get");
  }() ), std::runtime_error);
  const auto stage = TimingObservationJson(observation.Snapshot()).at("stages").at("async_result_wait");
  EXPECT_EQ(stage.at("latest_ms"), 2066);
  EXPECT_EQ(stage.at("slowest_frame").at("frame_index"), "2");
  [&] {
    ScopedTimingObservation<decltype(record), ManualClock> timer(record);
    ManualClock::value += std::chrono::milliseconds(2);
    return; // Early return has the same accounting guarantee as unwinding.
  }();
  const auto after_return = TimingObservationJson(observation.Snapshot()).at("stages").at("async_result_wait");
  EXPECT_EQ(after_return.at("sample_count_since_start"), 2);
  EXPECT_EQ(after_return.at("latest_ms"), 2);
  EXPECT_EQ(after_return.at("max_since_start_ms"), 2066);
  EXPECT_NO_THROW(( [&] {
    ScopedTimingObservation timer([](double) { throw std::runtime_error("diagnostic failure"); });
  }() ));
}
TEST(TimingObservation, StagesKeepDistinctDispatchAndCollectedFrameIdentitiesAndRejectInvalidDurations) {
  TimingObservation observation;
  observation.Observe(TimingStage::PrepareDispatch, 12, Identity(2));
  observation.Observe(TimingStage::AsyncResultWait, 2000, Identity(1));
  observation.Observe(TimingStage::AsyncResultWait, -1, Identity(3));
  observation.Observe(TimingStage::AsyncResultWait, std::numeric_limits<double>::quiet_NaN(), Identity(4));
  observation.Observe(TimingStage::AsyncResultWait, std::numeric_limits<double>::infinity(), Identity(5));
  const auto stages = TimingObservationJson(observation.Snapshot()).at("stages");
  EXPECT_EQ(stages.at("prepare_dispatch").at("slowest_frame").at("frame_index"), "2");
  EXPECT_EQ(stages.at("async_result_wait").at("slowest_frame").at("frame_index"), "1");
  EXPECT_EQ(stages.at("async_result_wait").at("sample_count_since_start"), 1);
}
