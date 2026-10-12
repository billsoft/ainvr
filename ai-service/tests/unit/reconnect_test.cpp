// ReconnectStateMachine —— 逐条对应 Python tests/test_reconnect.py 的功能
// 测试(跳过 stack_sampler 联动那几条,C++ 这版未移植 stack_sampler,已在
// reconnect.hpp 头注里说明)。
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#include "../../src/stream/reconnect.hpp"

using ai_service::stream::ReconnectStateMachine;

namespace {
void SleepS(double s) { std::this_thread::sleep_for(std::chrono::duration<double>(s)); }
}  // namespace

TEST(Reconnect, WatchdogNoTriggerWhenFeeding) {
  ReconnectStateMachine sm("test", 0.1, 1.0, 2.0, 0.5);
  for (int i = 0; i < 5; ++i) {
    sm.OnFrameReceived();
    SleepS(0.1);
    EXPECT_FALSE(sm.CheckWatchdog()) << "帧" << i << "不应触发watchdog";
  }
  EXPECT_EQ(sm.ConsecutiveFailures(), 0);
  EXPECT_FALSE(sm.NeedsReconnect());
}

TEST(Reconnect, WatchdogTriggersOnSilence) {
  ReconnectStateMachine sm("test", 0.1, 1.0, 2.0, 0.3);
  sm.OnFrameReceived();
  SleepS(0.1);
  EXPECT_FALSE(sm.CheckWatchdog());
  SleepS(0.3);
  EXPECT_TRUE(sm.CheckWatchdog());
  EXPECT_TRUE(sm.NeedsReconnect());
}

TEST(Reconnect, ExponentialBackoff) {
  std::atomic<int> call_count{0};
  ReconnectStateMachine sm("test", 0.1, 0.8, 2.0, 1.0, [&] {
    call_count++;
    return false;
  });

  std::vector<double> delays;
  for (int i = 0; i < 4; ++i) {
    sm.TriggerReconnect("fail-" + std::to_string(i));
    auto t0 = std::chrono::steady_clock::now();
    sm.DoReconnect();
    delays.push_back(std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
  }
  for (size_t i = 0; i < delays.size(); ++i) {
    double expected = std::min(0.1 * std::pow(2.0, static_cast<double>(i)), 0.8);
    EXPECT_NEAR(delays[i], expected, 0.05) << "第" << i << "次延迟不符合预期";
  }
  EXPECT_EQ(call_count.load(), 4);
}

TEST(Reconnect, ReconnectSuccessResetsBackoff) {
  int attempts = 0;
  ReconnectStateMachine sm("test", 0.1, 1.0, 2.0, 1.0, [&] {
    attempts++;
    return attempts >= 2;
  });

  sm.TriggerReconnect("fail");
  sm.DoReconnect();
  EXPECT_EQ(sm.ConsecutiveFailures(), 1);
  EXPECT_GT(sm.CurrentDelay(), 0.1);

  sm.TriggerReconnect("retry");
  sm.DoReconnect();
  EXPECT_EQ(sm.ConsecutiveFailures(), 0);
  EXPECT_NEAR(sm.CurrentDelay(), 0.1, 0.001);
  EXPECT_FALSE(sm.NeedsReconnect());
}

TEST(Reconnect, StopInterruptsReconnect) {
  ReconnectStateMachine sm("test", 5.0, 10.0, 2.0, 1.0, [] { return false; });

  std::thread stopper([&sm] {
    SleepS(0.3);
    sm.Stop();
  });

  sm.TriggerReconnect("test");
  auto t0 = std::chrono::steady_clock::now();
  bool result = sm.DoReconnect();
  double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  stopper.join();

  EXPECT_FALSE(result);
  EXPECT_LT(dt, 1.0) << "stop 应打断 5s 等待,实际耗时 " << dt;
}

TEST(Reconnect, WatchdogTriggersOnInitialDeadStream) {
  ReconnectStateMachine sm("test-dead", 0.1, 1.0, 2.0, 0.2);
  EXPECT_FALSE(sm.CheckWatchdog());
  EXPECT_FALSE(sm.NeedsReconnect());
  SleepS(0.3);
  EXPECT_TRUE(sm.CheckWatchdog());
  EXPECT_TRUE(sm.NeedsReconnect());
}

TEST(Reconnect, WatchdogDoesNotTriggerDuringStartupGrace) {
  ReconnectStateMachine sm("test-grace", 0.1, 1.0, 2.0, 2.0);
  EXPECT_FALSE(sm.CheckWatchdog());
  SleepS(0.2);
  EXPECT_FALSE(sm.CheckWatchdog());
  EXPECT_FALSE(sm.NeedsReconnect());
}

TEST(Reconnect, InitialTimeoutThenRetryBackoff) {
  int attempts = 0;
  ReconnectStateMachine sm("test-retry", 0.1, 0.8, 2.0, 0.05, [&] {
    attempts++;
    return false;
  });
  SleepS(0.08);
  EXPECT_TRUE(sm.CheckWatchdog());

  std::vector<double> delays;
  for (int i = 0; i < 3; ++i) {
    EXPECT_TRUE(sm.NeedsReconnect());
    auto t0 = std::chrono::steady_clock::now();
    bool success = sm.DoReconnect();
    delays.push_back(std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    EXPECT_FALSE(success);
  }
  EXPECT_EQ(attempts, 3);
  EXPECT_NEAR(delays[0], 0.1, 0.05);
  EXPECT_NEAR(delays[1], 0.2, 0.05);
  EXPECT_NEAR(delays[2], 0.4, 0.05);
}

// 发布侧据此判断"上游源正在断线恢复"(此时重建发布管线无用):请求重连、
// 正在重连、重连失败等待下一次,都算恢复中;成功后不算。
TEST(Reconnect, IsRecoveringCoversRequestedInProgressAndFailedAttempts) {
  std::atomic<bool> in_fn{false};
  std::atomic<bool> release{false};
  std::atomic<bool> succeed{false};
  ReconnectStateMachine sm("test", 0.05, 0.2, 2.0, 0.1, [&] {
    in_fn = true;
    while (!release.load()) SleepS(0.01);
    return succeed.load();
  });
  EXPECT_FALSE(sm.IsRecovering());
  sm.TriggerReconnect("源断开");
  EXPECT_TRUE(sm.IsRecovering());

  std::thread t([&] { sm.DoReconnect(); });
  while (!in_fn.load()) SleepS(0.01);
  EXPECT_FALSE(sm.NeedsReconnect());  // 正在重连时 NeedsReconnect 为 false,不能拿它判断
  EXPECT_TRUE(sm.IsRecovering());
  release = true;
  t.join();
  EXPECT_TRUE(sm.IsRecovering());  // 本次失败,等下一次

  succeed = true;
  sm.DoReconnect();
  EXPECT_FALSE(sm.IsRecovering());
}
