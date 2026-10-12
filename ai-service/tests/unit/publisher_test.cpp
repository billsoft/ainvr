// PtsRebaser —— 逐条对应 Python tests/test_pts_rebase.py。锁定的是
// 2026-09-17 生产事故:发布管线每 ~31 秒重连一次、永远推不出画面,根因
// 是新管线 base_time 从 0 起而源 PTS 可能已经涨到几千秒;第一版修复又
// 栽在按 PTS(而非 DTS)算帧间隔上,B 帧解码序下 PTS 非单调,见 publisher.
// hpp 头注。
#include <gtest/gtest.h>

#include <optional>
#include <utility>
#include <vector>

#include "../../src/stream/publisher.hpp"

using ai_service::stream::PtsRebaser;

namespace {
constexpr int64_t kSec = 1'000'000'000;
constexpr int64_t kF = 33'333'333;  // 30fps 标称帧间隔

// 真实编码器给 IBBP 流打的时间戳(解码顺序):DTS 每帧 +1 且整体前移,
// 保证 PTS>=DTS 恒成立;PTS 在解码顺序下则是非单调的。(dts, pts) 单位=帧
const std::pair<int, int> kIbbpDecodeOrder[] = {
    {0, 2}, {1, 5}, {2, 3}, {3, 4}, {4, 8}, {5, 6}, {6, 7},
};
}  // namespace

TEST(PublishPressureReportGate, ReportsFirstEventAndAggregatesWithoutSpam) {
  ai_service::stream::PublishPressureReportGate gate;
  EXPECT_FALSE(gate.Observe(0, 0, 10.0));
  auto first = gate.Observe(1, 27, 11.0);
  ASSERT_TRUE(first.has_value());
  EXPECT_EQ(first->first, 1);
  EXPECT_EQ(first->second, 27);
  for (int i = 2; i <= 100; ++i) {
    EXPECT_FALSE(gate.Observe(i, i + 26, 12.0));
  }
  auto summary = gate.Observe(100, 126, 41.0);
  ASSERT_TRUE(summary.has_value());
  EXPECT_EQ(summary->first, 99);
  EXPECT_EQ(summary->second, 99);
  EXPECT_FALSE(gate.Observe(100, 126, 1000.0));
}

TEST(PublishPressureReportGate, QuietTailIsReportedOnNextPoll) {
  ai_service::stream::PublishPressureReportGate gate;
  ASSERT_TRUE(gate.Observe(1, 1, 10.0));
  EXPECT_FALSE(gate.Observe(2, 3, 11.0));
  EXPECT_FALSE(gate.Observe(2, 3, 39.9));
  auto summary = gate.Observe(2, 3, 40.0);
  ASSERT_TRUE(summary.has_value());
  EXPECT_EQ(summary->first, 1);
  EXPECT_EQ(summary->second, 2);
}

TEST(PtsRebaser, FirstAuAnchorsToZeroHoweverOldTheSourceClockIs) {
  PtsRebaser r;
  auto [dts, pts] = r.Map(8305 * kSec, 8305 * kSec);
  EXPECT_EQ(dts, 0);
  EXPECT_EQ(pts, 0);
}

TEST(PtsRebaser, InterFrameDeltasArePreserved) {
  PtsRebaser r;
  int64_t b = 8305 * kSec;
  EXPECT_EQ(r.Map(b, b), (std::pair<int64_t, int64_t>{0, 0}));
  EXPECT_EQ(r.Map(b + kF, b + kF), (std::pair<int64_t, int64_t>{kF, kF}));
  EXPECT_EQ(r.Map(b + 2 * kF, b + 2 * kF), (std::pair<int64_t, int64_t>{2 * kF, 2 * kF}));
  auto jittered = r.Map(b + 2 * kF + 7'000'000, b + 2 * kF + 7'000'000);
  EXPECT_EQ(jittered.first, jittered.second);
}

TEST(PtsRebaser, BframeReorderingDoesNotLookLikeADiscontinuity) {
  PtsRebaser r;
  int64_t b = 8305 * kSec;
  std::vector<std::pair<int64_t, int64_t>> out;
  for (auto [d, p] : kIbbpDecodeOrder) {
    out.push_back(r.Map(b + static_cast<int64_t>(d) * kF, b + static_cast<int64_t>(p) * kF));
  }
  for (size_t i = 0; i < out.size(); ++i) {
    EXPECT_EQ(out[i].first, static_cast<int64_t>(kIbbpDecodeOrder[i].first) * kF)
        << "帧 " << i << " DTS 不对";
    EXPECT_EQ(out[i].second, static_cast<int64_t>(kIbbpDecodeOrder[i].second) * kF)
        << "帧 " << i << " PTS 不对";
  }
  EXPECT_EQ(r.discontinuities(), 0);
}

TEST(PtsRebaser, BframeStreamTimelineAdvancesAtExactlyOneFramePerFrame) {
  PtsRebaser r;
  int64_t b = 1234 * kSec;
  int reorder_cycle[3] = {4, 1, 1};
  int64_t last_dts = -1;
  int n = 300;
  for (int i = 0; i < n; ++i) {
    int64_t d = b + static_cast<int64_t>(i) * kF;
    int64_t p = d + static_cast<int64_t>(reorder_cycle[i % 3]) * kF;
    auto [out_dts, out_pts] = r.Map(d, p);
    if (last_dts >= 0) {
      EXPECT_EQ(out_dts - last_dts, kF) << "第 " << i << " 帧 DTS 步长异常";
    }
    EXPECT_GE(out_pts, out_dts);
    last_dts = out_dts;
  }
  EXPECT_EQ(r.discontinuities(), 0);
  EXPECT_EQ(last_dts, static_cast<int64_t>(n - 1) * kF);
}

TEST(PtsRebaser, ResetReanchorsToTheNextFirstFrame) {
  PtsRebaser r;
  int64_t b = 100 * kSec;
  r.Map(b, b);
  r.Map(b + kF, b + kF);
  r.Reset();
  EXPECT_EQ(r.Map(9000 * kSec, 9000 * kSec), (std::pair<int64_t, int64_t>{0, 0}));
  EXPECT_EQ(r.Map(9000 * kSec + kF, 9000 * kSec + kF), (std::pair<int64_t, int64_t>{kF, kF}));
}

TEST(PtsRebaser, SourceDtsGoingBackwardsDoesNotProduceBackwardsOutput) {
  PtsRebaser r;
  r.Map(5000 * kSec, 5000 * kSec);
  auto [before, _p1] = r.Map(5000 * kSec + kF, 5000 * kSec + kF);
  auto [after, _p2] = r.Map(0, 0);  // 源重启,时间戳归零
  EXPECT_GT(after, before);
  EXPECT_EQ(r.discontinuities(), 1);
  EXPECT_EQ(r.Map(kF, kF).first, after + kF);
  EXPECT_EQ(r.discontinuities(), 1);
}

TEST(PtsRebaser, HugeForwardJumpIsTreatedAsDiscontinuity) {
  PtsRebaser r;
  r.Map(10 * kSec, 10 * kSec);
  auto [before, _p1] = r.Map(10 * kSec + kF, 10 * kSec + kF);
  auto [after, _p2] = r.Map(3000 * kSec, 3000 * kSec);
  EXPECT_EQ(after, before + kF);
  EXPECT_EQ(r.discontinuities(), 1);
}

TEST(PtsRebaser, OutputDtsIsMonotonicAndPtsNeverNegativeAcrossAllUpsets) {
  PtsRebaser r;
  int64_t b = 8305 * kSec;
  std::vector<std::pair<std::optional<int64_t>, std::optional<int64_t>>> feed;
  for (auto [d, p] : kIbbpDecodeOrder) {
    feed.emplace_back(b + static_cast<int64_t>(d) * kF, b + static_cast<int64_t>(p) * kF);
  }
  feed.emplace_back(std::nullopt, std::nullopt);
  for (int i = 0; i < 4; ++i) {
    auto [d, p] = kIbbpDecodeOrder[i];
    feed.emplace_back(static_cast<int64_t>(d) * kF, static_cast<int64_t>(p) * kF);
  }
  feed.emplace_back(9000 * kSec, 9000 * kSec);
  feed.emplace_back(9000 * kSec + kF, 9000 * kSec + kF);

  int64_t prev = -1;
  for (auto& [d, p] : feed) {
    auto [out_dts, out_pts] = r.Map(d, p);
    EXPECT_GE(out_dts, 0);
    EXPECT_GE(out_pts, 0);
    EXPECT_GE(out_pts, out_dts) << "PTS(" << out_pts << ") < DTS(" << out_dts << ")";
    EXPECT_GE(out_dts, prev) << "DTS 倒退: " << prev << " -> " << out_dts;
    prev = out_dts;
  }
}

TEST(PtsRebaser, MissingTimestampsStillAdvanceTheTimeline) {
  PtsRebaser r;
  auto a = r.Map(std::nullopt, std::nullopt);
  auto b2 = r.Map(std::nullopt, std::nullopt);
  EXPECT_GT(b2.first, a.first);
}

TEST(PtsRebaser, DtsMissingFallsBackToPts) {
  PtsRebaser r;
  int64_t b = 500 * kSec;
  EXPECT_EQ(r.Map(std::nullopt, b), (std::pair<int64_t, int64_t>{0, 0}));
  EXPECT_EQ(r.Map(std::nullopt, b + kF), (std::pair<int64_t, int64_t>{kF, kF}));
  EXPECT_EQ(r.discontinuities(), 0);
}

// ---- 发布侧:输入源断线期间不重建发布管线 ----
// 2026-10-09 现场:小门相机停推后,发布管线每 ~12.5 秒重建一次(一天上百次)。
// 两条路径都会触发:发布看门狗(没有 AU 进来)、以及流媒体服务踢掉不发数据的
// 空闲推流连接后的总线错误。每次重建都让流媒体服务换一个推流会话,下游录像/
// 观看跟着反复重连;而上游没有画面时重建毫无作用——等源恢复再重建一次即可。
using ai_service::stream::DecidePublishStep;
using ai_service::stream::PublishStep;

TEST(PublishStep, RebuildRequestedWhileSourceHealthyRebuildsNow) {
  EXPECT_EQ(DecidePublishStep(true, 0.5, 5.0, false), PublishStep::kRebuildNow);
  EXPECT_EQ(DecidePublishStep(true, std::nullopt, 5.0, false), PublishStep::kRebuildNow);
}

TEST(PublishStep, RebuildRequestedWhileSourceRecoveringWaitsForSource) {
  // 空闲推流连接被流媒体服务踢掉(总线错误)时源仍在断线:先不重建
  EXPECT_EQ(DecidePublishStep(true, std::nullopt, 5.0, true), PublishStep::kWaitForSource);
  EXPECT_EQ(DecidePublishStep(true, 6.0, 5.0, true), PublishStep::kWaitForSource);
}

TEST(PublishStep, FreshInputIsFeedingRegardlessOfSourceState) {
  EXPECT_EQ(DecidePublishStep(false, 0.5, 5.0, false), PublishStep::kFeeding);
  EXPECT_EQ(DecidePublishStep(false, 0.5, 5.0, true), PublishStep::kFeeding);
}

TEST(PublishStep, StalledInputWhileSourceHealthyStillChecksWatchdog) {
  // 源正常却没有 AU 进来(如编码环节卡住):保留原有的看门狗重建路径
  EXPECT_EQ(DecidePublishStep(false, 6.0, 5.0, false), PublishStep::kCheckWatchdog);
  EXPECT_EQ(DecidePublishStep(false, std::nullopt, 5.0, false), PublishStep::kCheckWatchdog);
}

TEST(PublishStep, StalledInputWhileSourceRecoveringDoesNotArmWatchdog) {
  EXPECT_EQ(DecidePublishStep(false, 6.0, 5.0, true), PublishStep::kWaitForSource);
  EXPECT_EQ(DecidePublishStep(false, std::nullopt, 5.0, true), PublishStep::kWaitForSource);
}

// ---- 源断线恢复后重建一次发布会话 ----
// 2026-10-09 现场:相机断线重连期间发布会话一直沿用,恢复后的新画面接在旧会话里推出;
// 录像读端在会话中途解析错位,零输出 26 分钟。内容不连续就给下游一个新会话边界,
// 下游按新会话重新读取(录像据此换读端)。断线期间已经重建过就不再重复。
using ai_service::stream::SourceRecoveryLatch;

TEST(SourceRecoveryLatch, NeverRebuildsWithoutAnInterruption) {
  SourceRecoveryLatch latch;
  for (int i = 0; i < 5; ++i) EXPECT_FALSE(latch.Observe(false, true));
}

TEST(SourceRecoveryLatch, RebuildsOnceWhenFreshInputArrivesAfterRecovery) {
  SourceRecoveryLatch latch;
  EXPECT_FALSE(latch.Observe(true, false));   // 断线
  EXPECT_FALSE(latch.Observe(true, true));    // 恢复中:不重建
  EXPECT_FALSE(latch.Observe(false, false));  // 已恢复但还没有新画面
  EXPECT_TRUE(latch.Observe(false, true));    // 新画面到达:重建一次
  EXPECT_FALSE(latch.Observe(false, true));   // 之后不再重复
}

TEST(SourceRecoveryLatch, RebuildAlreadyDoneDuringRecoveryIsNotRepeated) {
  SourceRecoveryLatch latch;
  EXPECT_FALSE(latch.Observe(true, false));
  latch.Reset();                              // 发布管线已因错误重建
  EXPECT_FALSE(latch.Observe(false, true));
}

TEST(SourceRecoveryLatch, EachInterruptionGetsItsOwnRebuild) {
  SourceRecoveryLatch latch;
  latch.Observe(true, false);
  EXPECT_TRUE(latch.Observe(false, true));
  latch.Observe(true, false);
  EXPECT_TRUE(latch.Observe(false, true));
}
