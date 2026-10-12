// 重连状态机 + watchdog —— 对应 Python stream/reconnect.py。
#pragma once

#include <atomic>
#include <functional>
#include <mutex>
#include <string>

namespace ai_service::stream {

class ReconnectStateMachine {
 public:
  using ReconnectFn = std::function<bool()>;
  // stack_sampler.cpp(进程级线程栈快照)本版未移植——明确已知缺口,不是
  // 静默丢弃。这个回调是它未来的接入点:不传(默认)时纯 no-op。
  using NotifyFn = std::function<void(const std::string& formatted_reason)>;

  ReconnectStateMachine(std::string channel_id, double initial_delay, double max_delay,
                         double backoff_factor, double watchdog_timeout,
                         ReconnectFn reconnect_fn = nullptr, NotifyFn notify_fn = nullptr);

  void OnFrameReceived();
  void TriggerReconnect(const std::string& reason = "");
  bool CheckWatchdog();
  bool NeedsReconnect() const;
  // 已请求重连、正在重连、或上次重连失败等待下一次——即源仍在断线恢复中。
  // (NeedsReconnect 在"正在重连"期间为 false,不能用它判断源是否可用)
  bool IsRecovering() const;
  bool DoReconnect();
  void Stop();

  int ConsecutiveFailures() const;
  double CurrentDelay() const;

 private:
  void NotifyStackSampler(const std::string& reason);

  std::string channel_id_;
  double initial_delay_;
  double max_delay_;
  double backoff_factor_;
  double watchdog_timeout_;
  ReconnectFn reconnect_fn_;
  NotifyFn notify_fn_;

  mutable std::mutex mutex_;
  double last_frame_time_ = 0.0;  // 0 = 从未收到过帧
  double started_at_;
  double current_delay_;
  int consecutive_failures_ = 0;
  bool reconnect_requested_ = false;
  bool reconnecting_ = false;
  std::atomic<bool> stop_flag_{false};
};

}  // namespace ai_service::stream
