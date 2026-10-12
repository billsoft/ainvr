// 抽帧跳过 vs 过载丢帧的拆分、算力不足判定——多通道并行时"GPU 够不够"
// 的唯一信号,不能再把按设定帧率的正常抽帧/源流抖动当成丢帧报出去。
#include <gtest/gtest.h>

#include "../../src/pipeline/frame_accounting.hpp"

using namespace ai_service::pipeline;

namespace {
constexpr double kInterval15 = 1.0 / 15.0;
constexpr double kFastInfer = 0.038;  // 生产实测单帧推理 38ms,远小于 66.7ms 间隔
}  // namespace

TEST(SplitSkipped, SamplingAtHalfSourceRateIsNotOverload) {
  // 源 30fps、推理 15fps:每次取帧天然跳过 1 帧
  auto s = SplitSkipped(1, 30.0, kInterval15, kFastInfer);
  EXPECT_EQ(s.sampled, 1);
  EXPECT_EQ(s.overload, 0);
}

// 生产实测:源 30fps、推理 15fps、GPU 只忙 57% 时,帧到达有突发(取帧等待
// p95 82ms),逐次跳帧数 0/1/2/3 不等。只看跳帧数会把源流抖动误报成过载
// (重启后 75s 误报 396 帧)——推理本身跟得上节拍时,跳多少都不是算力问题。
TEST(SplitSkipped, BurstyArrivalWhileKeepingPaceIsNotOverload) {
  int64_t overload = 0;
  for (int64_t skipped : {0, 2, 1, 3, 0, 2}) {
    overload += SplitSkipped(skipped, 30.0, kInterval15, kFastInfer).overload;
  }
  EXPECT_EQ(overload, 0);
}

TEST(SplitSkipped, ComputeBoundSkipsBeyondSamplingAreOverload) {
  // 单帧推理 130ms(> 66.7ms 间隔,只跑得到 7.5fps):每次跳 3 帧,期望 1 帧
  auto s = SplitSkipped(3, 30.0, kInterval15, 0.130);
  EXPECT_EQ(s.sampled, 1);
  EXPECT_EQ(s.overload, 2);
}

TEST(SplitSkipped, FollowSourceModeOverloadOnlyWhenComputeBound) {
  // inference_fps=0 跟随源流:推理比源帧间隔慢,跳过的就是算力不够
  auto slow = SplitSkipped(2, 30.0, 0.0, 0.050);
  EXPECT_EQ(slow.sampled, 0);
  EXPECT_EQ(slow.overload, 2);
  // 推理比源帧间隔快:跳帧只是到达突发
  auto fast = SplitSkipped(2, 30.0, 0.0, 0.020);
  EXPECT_EQ(fast.overload, 0);
}

TEST(SplitSkipped, UnknownSourceRateDoesNotRaiseFalseOverload) {
  auto s = SplitSkipped(2, 0.0, kInterval15, 0.130);
  EXPECT_EQ(s.sampled, 2);
  EXPECT_EQ(s.overload, 0);
}

TEST(SplitSkipped, NoSkipNoCount) {
  auto s = SplitSkipped(0, 30.0, kInterval15, 0.130);
  EXPECT_EQ(s.sampled, 0);
  EXPECT_EQ(s.overload, 0);
}

TEST(EffectiveTargetFps, CappedBySourceRate) {
  EXPECT_DOUBLE_EQ(EffectiveTargetFps(15.0, 30.0), 15.0);
  EXPECT_DOUBLE_EQ(EffectiveTargetFps(15.0, 10.0), 10.0);  // 源只有 10fps,推理不可能更快
  EXPECT_DOUBLE_EQ(EffectiveTargetFps(0.0, 30.0), 30.0);   // 跟随源流
  EXPECT_DOUBLE_EQ(EffectiveTargetFps(15.0, 0.0), 15.0);   // 源帧率未知时按设定
}

TEST(IsUnderCapacity, NeedsBothLowFpsAndBusyInference) {
  EXPECT_FALSE(IsUnderCapacity(14.6, 15.0, 38.0));  // 生产实测:正常
  EXPECT_TRUE(IsUnderCapacity(12.0, 15.0, 70.0));   // 推理 70ms/帧 × 15 > 1s:GPU 跑满
  // 帧率低但推理只用了 57% 时间:源流卡顿/抖动,不是算力不够,不该让人去减通道
  EXPECT_FALSE(IsUnderCapacity(12.0, 15.0, 38.0));
  EXPECT_FALSE(IsUnderCapacity(0.0, 15.0, 70.0));   // 还没测出实际帧率,不告警
  EXPECT_FALSE(IsUnderCapacity(10.0, 0.0, 70.0));
}

TEST(InferenceDeadline, LongArchiveWaitDoesNotAddAnotherIdleInterval) {
  EXPECT_DOUBLE_EQ(NextInferenceDeadline(10.0,12.0,kInterval15),12.0);
  EXPECT_DOUBLE_EQ(NextInferenceDeadline(10.0,10.15,kInterval15),10.15);
}

TEST(InferenceDeadline, FastInferenceStillRespectsConfiguredRate) {
  EXPECT_DOUBLE_EQ(NextInferenceDeadline(10.0,10.03,kInterval15),10.0+kInterval15);
  EXPECT_DOUBLE_EQ(NextInferenceDeadline(10.0,10.03,0),10.03);
}

TEST(InferenceDeadline, VariableWorkPreservesAverageCadenceInsteadOfAddingJitterIdle) {
  double now=10,scheduled=10;
  for(int frame=0;frame<100;++frame) {
    now=std::max(now,scheduled)+(frame%2 ? 0.10 : 0.03);
    scheduled=NextInferenceDeadline(scheduled,now,kInterval15);
  }
  EXPECT_GE(now-10,6.5);
  EXPECT_LE(now-10,6.8); // alternating 30/100ms fits ~15 FPS; strict start pacing gives 12
}

TEST(InferenceDeadline, SustainedOverloadDoesNotPeriodicallyAddAnIdleFrame) {
  double now=10,scheduled=10;
  for(int frame=0;frame<100;++frame) {
    now=std::max(now,scheduled)+0.08;
    scheduled=NextInferenceDeadline(scheduled,now,kInterval15);
  }
  EXPECT_NEAR(now-10,8.0,1e-10);
}

TEST(ArchiveAdmissionSkips, SeparatesArchiveWaitFromSamplingAndOverload) {
  const auto archive = ArchiveAdmissionSkips(100, 130, 31);
  const auto rest = SplitSkipped(31 - archive, 30, kInterval15, kFastInfer);
  EXPECT_EQ(archive, 30);
  EXPECT_EQ(rest.sampled, 1);
  EXPECT_EQ(rest.overload, 0);
  EXPECT_EQ(ArchiveAdmissionSkips(-1, 100, 0), 0);
  EXPECT_EQ(ArchiveAdmissionSkips(100, 3, 0), 0);
  EXPECT_EQ(ArchiveAdmissionSkips(100, 130, 5), 5);
}
