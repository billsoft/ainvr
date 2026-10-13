// AuDelayBuffer / AdaptiveDelayController —— 行为锁定,逐条对应
// Python tests/test_au_buffer.py(364 行,22 个用例)。这是三方解耦缓存
// 的核心接缝,"识别结果永远打在它自己那一帧上"这个性质成不成立全看这
// 个类对不对——所以不是挑几个跑一下,是整份照搬。
#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <string>

#include "../../src/stream/au_buffer.hpp"

using ai_service::stream::AdaptiveDelayController;
using ai_service::stream::AuDelayBuffer;
using ai_service::stream::BufferedAu;
using ai_service::stream::StampResult;

TEST(AuDelayBuffer, FastOpenVocabularyKeepsColdInferenceWithinStartupMargin) {
  AuDelayBuffer buffer(std::make_shared<AdaptiveDelayController>(0.5, 3.0));
  BufferedAu frame;
  frame.pts_ns = 123; frame.arrived_mono = 100; frame.data = {1, 2, 3};
  buffer.put(frame);
  EXPECT_FALSE(buffer.pop_ready(100.35));
  EXPECT_EQ(buffer.stamp(frame.pts_ns, [](const auto& bytes) {
    auto stamped = bytes;
    stamped.push_back(4);
    return stamped;
  }, 100.35),
            StampResult::kStamped);
  EXPECT_FALSE(buffer.pop_ready(100.49));
  EXPECT_TRUE(buffer.pop_ready(100.51));
}

TEST(AuDelayBuffer, SlowGroundingKeepsOriginalCompressedFrameUntilResultArrives) {
  AuDelayBuffer buffer(std::make_shared<AdaptiveDelayController>(40, 40), 1.2,
                       int64_t(768) * 1024 * 1024);
  BufferedAu frame;
  frame.pts_ns = 123000000; frame.dts_ns = 120000000;
  frame.arrived_mono = 100; frame.is_keyframe = true; frame.data = {1, 2, 3};
  buffer.put(frame);
  EXPECT_FALSE(buffer.pop_ready(130));
  EXPECT_EQ(buffer.stamp(frame.pts_ns, [](const auto& bytes) {
    auto output = bytes; output.push_back(4); return output;
  }, 130), StampResult::kStamped);
  auto sent = buffer.pop_ready(140.1);
  ASSERT_TRUE(sent);
  EXPECT_EQ(sent->pts_ns, frame.pts_ns);
  EXPECT_EQ(sent->dts_ns, frame.dts_ns);
  EXPECT_EQ(sent->data, (std::vector<uint8_t>{1, 2, 3, 4}));
}

namespace {

constexpr int64_t kMs = 1'000'000;  // 1ms = 1e6 ns

BufferedAu Au(int64_t pts_ms, bool key = false, double at = 0.0, size_t size = 100) {
  BufferedAu a;
  a.pts_ns = pts_ms * kMs;
  a.dts_ns = pts_ms * kMs;
  a.duration_ns = 33 * kMs;
  a.data = std::vector<uint8_t>(size, 'x');
  a.is_keyframe = key;
  a.arrived_mono = at;
  return a;
}

AuDelayBuffer FastBuffer() {
  // 延迟固定为 0 的缓存,用来单独测"打在谁身上"这件事。max_delay 不能取
  // 0——容量上限是 max_delay*hold_factor,取 0 等于容量为零,刚存进去就
  // 被抛掉。
  return AuDelayBuffer(std::make_shared<AdaptiveDelayController>(0.0, 5.0));
}

}  // namespace

// ============ AdaptiveDelayController:自适应本身 ============

TEST(AuBufferDiagnostics, ReportsByteLimitAndCleanResumePoint) {
  AuDelayBuffer b(nullptr, 1.6, 250, 8192);
  b.put(Au(0, true, 10.0));
  b.put(Au(33, false, 10.03));
  b.put(Au(66, true, 10.06));
  const auto s = b.stats();
  ASSERT_TRUE(s.last_eviction.has_value());
  const auto& e = *s.last_eviction;
  EXPECT_EQ(e.reasons, ai_service::stream::kBufferBytes);
  EXPECT_EQ(e.frames_before, 3);
  EXPECT_EQ(e.bytes_before, 300);
  EXPECT_EQ(e.removed, 2);
  EXPECT_TRUE(e.resumed_at_keyframe);
  EXPECT_EQ(s.byte_limit_events, 1);
  EXPECT_EQ(s.age_limit_events, 0);
  EXPECT_EQ(s.frame_limit_events, 0);
  EXPECT_EQ(s.level, 1);
}

TEST(AuBufferDiagnostics, DistinguishesAgeFromFrameLimit) {
  AuDelayBuffer aged;
  aged.put(Au(0, true, 10.0));
  aged.put(Au(33, true, 15.0));
  auto s = aged.stats();
  ASSERT_TRUE(s.last_eviction.has_value());
  EXPECT_EQ(s.last_eviction->reasons, ai_service::stream::kBufferAge);
  EXPECT_DOUBLE_EQ(s.last_eviction->oldest_age_s, 5.0);
  EXPECT_NEAR(s.last_eviction->hold_limit_s, 4.8, 1e-9);
  EXPECT_EQ(s.age_limit_events, 1);

  AuDelayBuffer frames(nullptr, 1.6, 10000, 1);
  frames.put(Au(0, true, 10.0));
  frames.put(Au(33, false, 10.03));
  s = frames.stats();
  ASSERT_TRUE(s.last_eviction.has_value());
  EXPECT_EQ(s.last_eviction->reasons, ai_service::stream::kBufferFrames);
  EXPECT_FALSE(s.last_eviction->resumed_at_keyframe);
  EXPECT_EQ(s.frame_limit_events, 1);
}

TEST(AuBufferDiagnostics, KeepsAllSimultaneousLimitReasons) {
  AuDelayBuffer b(nullptr, 1.6, 150, 1);
  b.put(Au(0, true, 10.0));
  b.put(Au(33, true, 15.0));
  const auto s = b.stats();
  ASSERT_TRUE(s.last_eviction.has_value());
  EXPECT_EQ(s.last_eviction->reasons, ai_service::stream::kBufferBytes |
      ai_service::stream::kBufferFrames | ai_service::stream::kBufferAge);
  EXPECT_EQ(s.byte_limit_events, 1);
  EXPECT_EQ(s.frame_limit_events, 1);
  EXPECT_EQ(s.age_limit_events, 1);
  EXPECT_EQ(s.drop_events, 1);
}

TEST(AuBufferDiagnostics, GenerationResetHasSeparateAccounting) {
  AuDelayBuffer b;
  auto old = Au(0, true, 10.0);
  old.generation = 1;
  b.put(std::move(old));
  auto fresh = Au(33, true, 20.0);
  fresh.generation = 2;
  b.put(std::move(fresh));
  const auto s = b.stats();
  EXPECT_EQ(s.generation_reset_events, 1);
  EXPECT_EQ(s.generation_reset_units, 1);
  EXPECT_EQ(s.dropped, 0);
  EXPECT_FALSE(s.last_eviction.has_value());
  EXPECT_EQ(s.level, 1);
  b.clear();
  EXPECT_EQ(b.stats().generation_reset_units, 1);
}

TEST(AdaptiveDelayController, StartsAtMinimumSoAFastSystemNeverPaysForAGuess) {
  AdaptiveDelayController c(0.1, 3.0);
  EXPECT_NEAR(c.delay_s(), 0.1, 1e-9);
}

TEST(AdaptiveDelayController, RisesImmediatelyWhenInferenceGetsSlower) {
  AdaptiveDelayController c(0.1, 3.0, /*headroom=*/1.4);
  for (int i = 0; i < 50; ++i) c.on_stamp(0.5);
  EXPECT_NEAR(c.delay_s(), 0.5 * 1.4, 0.5 * 1.4 * 0.05);
}

TEST(AdaptiveDelayController, FallsBackSlowlyWhenInferenceSpeedsUp) {
  AdaptiveDelayController c(0.05, 3.0, 1.4, 240, 0.95, 1.3, /*fall_rate=*/0.04);
  for (int i = 0; i < 50; ++i) c.on_stamp(1.0);
  double high = c.delay_s();
  c.on_stamp(0.05);  // 突然变快一帧
  EXPECT_GT(c.delay_s(), high * 0.9) << "一个样本就掉下来了,太敏感";
  for (int i = 0; i < 400; ++i) c.on_stamp(0.05);
  EXPECT_LT(c.delay_s(), high * 0.5) << "长期变快之后没有收下来,白白多压延迟";
}

TEST(AdaptiveDelayController, AdaptsToACompletelyDifferentWorkload) {
  AdaptiveDelayController c(0.05, 5.0);
  for (int i = 0; i < 300; ++i) c.on_stamp(0.08);  // 轻量模型
  double light = c.delay_s();
  for (int i = 0; i < 300; ++i) c.on_stamp(1.2);  // 换成重模型
  double heavy = c.delay_s();
  EXPECT_TRUE(light < 0.2 && heavy > 1.2) << "没跟上负载变化: " << light << " -> " << heavy;
}

TEST(AdaptiveDelayController, ALateStampPushesTheDelayUpRightAway) {
  AdaptiveDelayController c(0.1, 3.0, 1.4, 240, 0.95, /*miss_growth=*/1.3);
  double before = c.delay_s();
  c.on_miss();
  EXPECT_NEAR(c.delay_s(), before * 1.3, 1e-9);
}

TEST(AdaptiveDelayController, DelayIsAlwaysClampedBetweenMinAndMax) {
  AdaptiveDelayController c(0.2, 1.0);
  for (int i = 0; i < 100; ++i) c.on_stamp(9.0);  // 荒谬的慢
  EXPECT_LE(c.delay_s(), 1.0);
  for (int i = 0; i < 50; ++i) c.on_miss();
  EXPECT_LE(c.delay_s(), 1.0);
  for (int i = 0; i < 2000; ++i) c.on_stamp(0.0);
  EXPECT_GE(c.delay_s(), 0.2);
}

TEST(AdaptiveDelayController, TailLatencyDrivesTheTargetNotTheAverage) {
  AdaptiveDelayController c(0.01, 5.0, /*headroom=*/1.0, 240, /*percentile=*/0.95);
  for (int i = 0; i < 95; ++i) c.on_stamp(0.1);
  for (int i = 0; i < 5; ++i) c.on_stamp(1.0);  // 5% 的长尾
  EXPECT_GT(c.delay_s(), 0.3) << "被均值抹平了,长尾帧会丢框";
}

TEST(AdaptiveDelayController, RejectsNonsenseConstruction) {
  EXPECT_THROW(AdaptiveDelayController(2.0, 1.0), std::invalid_argument);
  EXPECT_THROW(AdaptiveDelayController(0.1, 3.0, 1.4, 240, 0.0), std::invalid_argument);
  EXPECT_THROW(AdaptiveDelayController(0.1, 3.0, 1.4, 0), std::invalid_argument);
}

// ============ 不变量 1:推理打在正确的那一个包上 ============

TEST(AuDelayBufferInvariant1, StampHitsExactlyThePacketWithThatPts) {
  AuDelayBuffer b(std::make_shared<AdaptiveDelayController>(10.0, 10.0));
  int64_t pts_list[] = {100, 133, 166};
  for (int i = 0; i < 3; ++i) b.put(Au(pts_list[i], false, i * 0.033));
  EXPECT_EQ(b.stamp(133 * kMs, [](const std::vector<uint8_t>& d) {
    auto out = d;
    out.push_back('S'); out.push_back('E'); out.push_back('I');
    return out;
  }, 0.5), StampResult::kStamped);

  auto g0 = b.pop_ready(999.0), g1 = b.pop_ready(999.0), g2 = b.pop_ready(999.0);
  ASSERT_TRUE(g0 && g1 && g2);
  auto ends_with = [](const std::vector<uint8_t>& d, const std::string& suffix) {
    if (d.size() < suffix.size()) return false;
    return std::equal(suffix.rbegin(), suffix.rend(), d.rbegin());
  };
  EXPECT_EQ(g0->pts_ns, 100 * kMs);
  EXPECT_TRUE(ends_with(g0->data, "x"));
  EXPECT_EQ(g1->pts_ns, 133 * kMs);
  EXPECT_TRUE(ends_with(g1->data, "SEI"));
  EXPECT_EQ(g2->pts_ns, 166 * kMs);
  EXPECT_TRUE(ends_with(g2->data, "x"));
}

TEST(AuDelayBufferInvariant1, StampIsVisibleToThePublisherThatPopsLater) {
  AuDelayBuffer b(std::make_shared<AdaptiveDelayController>(1.0, 1.0));
  b.put(Au(100, false, 0.0));
  b.stamp(100 * kMs, [](const std::vector<uint8_t>& d) {
    std::vector<uint8_t> out = {'S', 'E', 'I', ':'};
    out.insert(out.end(), d.begin(), d.end());
    return out;
  }, 0.2);
  auto out = b.pop_ready(5.0);
  ASSERT_TRUE(out.has_value());
  ASSERT_GE(out->data.size(), 4u);
  EXPECT_EQ(std::string(out->data.begin(), out->data.begin() + 4), "SEI:");
  EXPECT_TRUE(out->stamped);
}

TEST(AuDelayBufferInvariant1, StampMissDoesNotFallBackToANeighbour) {
  AuDelayBuffer b(std::make_shared<AdaptiveDelayController>(10.0, 10.0));
  b.put(Au(100, false, 0.0));
  b.put(Au(166, false, 0.033));
  EXPECT_EQ(b.stamp(133 * kMs, [](const std::vector<uint8_t>& d) {
    auto out = d; out.push_back('S'); out.push_back('E'); out.push_back('I');
    return out;
  }, 0.1), StampResult::kUnknown);
  for (int i = 0; i < 2; ++i) {
    auto out = b.pop_ready(999.0);
    ASSERT_TRUE(out.has_value());
    ASSERT_GE(out->data.size(), 3u);
    std::string tail(out->data.end() - 3, out->data.end());
    EXPECT_NE(tail, "SEI") << "把结果打到邻居身上了";
  }
}

TEST(AuDelayBufferInvariant1, BytesAccountingFollowsStamping) {
  AuDelayBuffer b(std::make_shared<AdaptiveDelayController>(10.0, 10.0));
  b.put(Au(100, false, 0.0, 100));
  EXPECT_EQ(b.stats().bytes, 100);
  b.stamp(100 * kMs, [](const std::vector<uint8_t>& d) {
    auto out = d;
    out.insert(out.end(), 50, 'y');
    return out;
  }, 0.1);
  EXPECT_EQ(b.stats().bytes, 150);
}

// ============ 不变量 2:延迟是给推理的时间窗,且实测自适应 ============

TEST(AuDelayBufferInvariant2, PacketIsNotPublishedBeforeItHasAged) {
  AuDelayBuffer b(std::make_shared<AdaptiveDelayController>(2.0, 2.0));
  b.put(Au(100, false, 10.0));
  EXPECT_FALSE(b.pop_ready(11.0).has_value()) << "还没熟就被取走了,推理没时间追上";
  EXPECT_FALSE(b.pop_ready(11.9).has_value());
  EXPECT_TRUE(b.pop_ready(12.0).has_value());
}

TEST(AuDelayBufferInvariant2, PacketsComeOutInArrivalOrder) {
  auto b = FastBuffer();
  int64_t pts_list[] = {100, 133, 166, 200};
  for (int i = 0; i < 4; ++i) b.put(Au(pts_list[i], false, i * 0.033));
  std::vector<int64_t> out;
  while (true) {
    auto x = b.pop_ready(99.0);
    if (!x) break;
    out.push_back(x->pts_ns / kMs);
  }
  EXPECT_EQ(out, (std::vector<int64_t>{100, 133, 166, 200}));
}

TEST(AuDelayBufferInvariant2, EmptyBufferReturnsNone) {
  AuDelayBuffer b;
  EXPECT_FALSE(b.pop_ready(1.0).has_value());
}

TEST(AuDelayBufferInvariant2, LateStampIsReportedAndDrivesTheDelayUp) {
  auto b = FastBuffer();
  b.put(Au(100, false, 0.0));
  EXPECT_TRUE(b.pop_ready(1.0).has_value());

  auto c = std::make_shared<AdaptiveDelayController>(0.1, 3.0);
  AuDelayBuffer b2(c);
  b2.put(Au(100, false, 0.0));
  b2.pop_ready(99.0);
  double before = c->delay_s();
  EXPECT_EQ(b2.stamp(100 * kMs, [](const std::vector<uint8_t>& d) { return d; }, 99.5),
            StampResult::kTooLate);
  EXPECT_GT(c->delay_s(), before) << "来晚了却没有调长延迟,下次还会晚";
  EXPECT_EQ(b2.stats().too_late, 1);
}

// ============ 不变量 3/4:抛帧策略与正反馈防护 ============

TEST(AuDelayBufferInvariant34, DroppedPacketIsReportedAsDroppedNotLate) {
  // 回归锁(正反馈死循环):溢出抛掉的包,推理来找时必须报 DROPPED,绝不能
  // 报 TOO_LATE 去调长延迟——存不下的时候调长只会更存不下。
  auto c = std::make_shared<AdaptiveDelayController>(0.1, 0.5);
  AuDelayBuffer b(c, /*hold_factor=*/1.4);  // 最多存 0.7 秒
  b.put(Au(100, false, 0.0));
  for (int i = 1; i < 60; ++i) b.put(Au(100 + i, false, i * 0.033));  // 推进到 2 秒,头部必被抛
  double before = c->delay_s();
  EXPECT_EQ(b.stamp(100 * kMs, [](const std::vector<uint8_t>& d) { return d; }, 2.0),
            StampResult::kDropped);
  EXPECT_NEAR(c->delay_s(), before, 1e-9) << "抛帧被误判成来晚,触发了正反馈";
  EXPECT_EQ(b.stats().too_late, 0);
}

TEST(AuDelayBufferInvariant34, CapacityIsBoundedByTimeNotFrameCount) {
  auto c = std::make_shared<AdaptiveDelayController>(0.5, 1.0);
  AuDelayBuffer b(c, /*hold_factor=*/2.0);  // 最多存 2 秒
  for (int i = 0; i < 119; ++i) b.put(Au(100 + i, false, i / 60.0));  // 约 2 秒 @60fps
  EXPECT_EQ(b.stats().dropped, 0) << "60fps 下被帧数误伤了";
  EXPECT_LE(b.stats().held_s, 2.01);
}

TEST(AuDelayBufferInvariant34, OverflowDropsFromTheHeadNeverTheTail) {
  auto c = std::make_shared<AdaptiveDelayController>(0.1, 0.2);
  AuDelayBuffer b(c, /*hold_factor=*/1.4);  // 最多存 0.28 秒
  int64_t pts_list[] = {100, 133, 166, 200};
  for (int i = 0; i < 4; ++i) b.put(Au(pts_list[i], false, i * 0.15));  // 跨度 0.45 秒,必溢出
  auto out = b.pop_ready(99.0);
  ASSERT_TRUE(out.has_value());
  EXPECT_GT(out->pts_ns, 100 * kMs) << "丢的是尾部,不是头部";
  EXPECT_GE(b.stats().dropped, 1);
}

TEST(AuDelayBufferInvariant34, OverflowResyncsToAKeyframeWhenOneIsAvailable) {
  auto c = std::make_shared<AdaptiveDelayController>(0.1, 0.25);
  AuDelayBuffer b(c, /*hold_factor=*/1.4);  // 最多存 0.35 秒
  b.put(Au(100, false, 0.00));
  b.put(Au(133, false, 0.05));
  b.put(Au(166, true, 0.10));
  b.put(Au(200, false, 0.15));
  b.put(Au(233, false, 0.40));  // 头部超 0.35 → 溢出
  std::vector<int64_t> remaining;
  while (true) {
    auto x = b.pop_ready(999.0);
    if (!x) break;
    remaining.push_back(x->pts_ns / kMs);
  }
  ASSERT_FALSE(remaining.empty());
  EXPECT_EQ(remaining[0], 166) << "没有从 I 帧重同步";
}

TEST(AuDelayBufferInvariant34, ByteCapIsAnAbsoluteBackstop) {
  auto c = std::make_shared<AdaptiveDelayController>(10.0, 10.0);
  AuDelayBuffer b(c, /*hold_factor=*/10.0, /*max_bytes=*/250);
  int64_t pts_list[] = {100, 133, 166};
  for (int i = 0; i < 3; ++i) b.put(Au(pts_list[i], false, i * 0.001, 100));
  EXPECT_LE(b.stats().bytes, 250);
  EXPECT_GE(b.stats().dropped, 1);
}

TEST(AuDelayBufferInvariant34, UnderPressureTheDelayShrinksInsteadOfDroppingFrames) {
  auto c = std::make_shared<AdaptiveDelayController>(100.0, 100.0);
  AuDelayBuffer b(c, /*hold_factor=*/1.6);  // 门槛 130s / 上限 160s
  for (int i = 0; i < 8; ++i) b.put(Au(100 + i, false, i * 20.0));  // 已攒 140 秒 > 门槛
  EXPECT_TRUE(b.pop_ready(140.0).has_value()) << "快存不下了却还在死等延迟";
  EXPECT_EQ(b.stats().dropped, 0) << "应该提前放行,而不是抛帧";
}

TEST(AuDelayBufferInvariant34, ElasticReleaseNeverPreemptsTheNormalDelay) {
  // 回归锁(写这版时踩过):弹性放行的门槛必须排在正常延迟之上,否则包会
  // 在没到时候就被放走,延迟形同虚设、推理永远来不及。
  auto c = std::make_shared<AdaptiveDelayController>(2.0, 2.0);
  AuDelayBuffer b(c, /*hold_factor=*/1.6);
  b.put(Au(100, false, 0.0));
  for (double t : {0.5, 1.0, 1.5, 1.9}) {
    EXPECT_FALSE(b.pop_ready(t).has_value()) << t << "s 就被放走了,延迟被架空";
  }
  EXPECT_TRUE(b.pop_ready(2.0).has_value());
}

// ============ 拉流/推流之间唯一的联系:只读的供给信号 ============

TEST(AuDelayBufferSupplySignal, ReadonlyAndReflectsLastPut) {
  AuDelayBuffer b;
  EXPECT_FALSE(b.seconds_since_last_put(5.0).has_value());
  b.put(Au(100, false, 10.0));
  auto s = b.seconds_since_last_put(13.0);
  ASSERT_TRUE(s.has_value());
  EXPECT_NEAR(*s, 3.0, 1e-9);
}

TEST(AuDelayBufferLifecycle, ClearEmptiesEverything) {
  AuDelayBuffer b;
  b.put(Au(100, false, 0.0));
  b.clear();
  EXPECT_EQ(b.size(), 0u);
  EXPECT_EQ(b.stats().bytes, 0);
  EXPECT_FALSE(b.seconds_since_last_put(1.0).has_value());
  EXPECT_EQ(b.stamp(100 * kMs, [](const std::vector<uint8_t>& d) { return d; }, 1.0),
            StampResult::kUnknown);
}

// ============ 端到端:三方互不认识,且工况变化时仍不打偏 ============

struct WorkloadCase {
  int fps;
  int infer_every;
  double lag_s;
  const char* label;
};

TEST(AuDelayBufferEndToEnd, ThreePartiesNeverMisattributeUnderAnyWorkload) {
  const WorkloadCase cases[] = {
      {30, 2, 0.30, "30fps/15fps推理/300ms"},
      {60, 4, 0.12, "60fps/15fps推理/120ms"},
      {25, 5, 0.90, "25fps/5fps推理/900ms"},
      {30, 2, 0.05, "30fps/15fps推理/50ms"},
  };

  for (const auto& tc : cases) {
    SCOPED_TRACE(tc.label);
    AuDelayBuffer b;
    double frame_s = 1.0 / tc.fps;
    int lag_frames = std::max(1, static_cast<int>(std::lround(tc.lag_s / frame_s)));

    std::vector<std::pair<int64_t, std::optional<int64_t>>> published;
    int n = tc.fps * 12;  // 跑 12 秒
    for (int i = 0; i < n; ++i) {
      double t = i * frame_s;
      int64_t pts_ms = static_cast<int64_t>(std::lround((i + 1) * frame_s * 1000));
      b.put(Au(pts_ms, (i % (tc.fps * 8)) == 0, t));

      int done = i - lag_frames;
      if (done >= 0 && done % tc.infer_every == 0) {
        int64_t done_pts = static_cast<int64_t>(std::lround((done + 1) * frame_s * 1000));
        b.stamp(
            done_pts * kMs,
            [done_pts](const std::vector<uint8_t>& d) {
              auto out = d;
              std::string tag = "|pts=" + std::to_string(done_pts);
              out.insert(out.end(), tag.begin(), tag.end());
              return out;
            },
            t);
      }

      while (true) {
        auto out = b.pop_ready(t);
        if (!out) break;
        std::string s(out->data.begin(), out->data.end());
        auto pos = s.find("|pts=");
        std::optional<int64_t> seen;
        if (pos != std::string::npos) {
          seen = std::stoll(s.substr(pos + 5));
        }
        published.emplace_back(out->pts_ns / kMs, seen);
      }
    }

    std::vector<std::pair<int64_t, int64_t>> stamped;
    for (auto& [own, seen] : published) {
      if (seen.has_value()) stamped.emplace_back(own, *seen);
    }
    ASSERT_FALSE(stamped.empty()) << "一个都没打上,自适应没收敛";
    for (auto& [own, seen] : stamped) {
      EXPECT_EQ(own, seen) << "打偏了:包 pts=" << own << " 上写着 pts=" << seen;
    }
    double expected = static_cast<double>(published.size()) / tc.infer_every;
    EXPECT_GT(static_cast<double>(stamped.size()), expected * 0.6)
        << "命中率太低 " << stamped.size() << "/" << expected << ",延迟窗没涨够";
  }
}
#include "../../src/stream/publisher.hpp"

TEST(InitialPublishBuffer, CapacityFailureDoesNotWaitForeverAndSourceRecoveryDoesNotMisfire) {
  ai_service::stream::BufferStats stats;
  stats.level = 300;
  stats.held_s = 10;
  stats.controller.delay_s = 40;
  using namespace ai_service::stream;
  EXPECT_EQ(DecideInitialBuffer(stats, false), InitialBufferStep::kWait);
  stats.byte_limit_events = 1;
  EXPECT_EQ(DecideInitialBuffer(stats, false), InitialBufferStep::kCapacityFault);
  EXPECT_EQ(DecideInitialBuffer(stats, true), InitialBufferStep::kWait);
  stats.held_s = 40;
  EXPECT_EQ(DecideInitialBuffer(stats, false), InitialBufferStep::kReady);
}

TEST(AdaptiveDelayController, ExplicitColdStartBudgetDecaysWithoutFabricatedMisses) {
  AdaptiveDelayController controller(0.75,3.0,1.6,240,0.99,1.3,0.01,3.0);
  EXPECT_DOUBLE_EQ(controller.delay_s(),3.0);
  EXPECT_EQ(controller.stats().miss_events,0);
  for(int i=0;i<500;++i)controller.on_stamp(0.2);
  EXPECT_GE(controller.delay_s(),0.75);
  EXPECT_LT(controller.delay_s(),0.8);
  EXPECT_EQ(controller.stats().miss_events,0);
  EXPECT_THROW(AdaptiveDelayController(0.75,3.0,1.4,240,0.95,1.3,0.04,4.0),std::invalid_argument);
  AuDelayBuffer buffer(std::make_shared<AdaptiveDelayController>(0.75,3.0,1.6,240,0.99,1.3,0.01,3.0));
  auto frame=Au(123,false,100);
  buffer.put(frame);
  EXPECT_FALSE(buffer.pop_ready(102.8));
  EXPECT_EQ(buffer.stamp(frame.pts_ns,[](const auto& data){auto result=data;result.push_back(4);return result;},102.9),StampResult::kStamped);
  auto output=buffer.pop_ready(103.1);
  ASSERT_TRUE(output);
  EXPECT_EQ(output->pts_ns,frame.pts_ns);
}
