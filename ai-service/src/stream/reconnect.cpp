#include "reconnect.hpp"

#include <algorithm>
#include <chrono>
#include <thread>

namespace ai_service::stream {

namespace {
double NowWall() {
  return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}
}  // namespace

ReconnectStateMachine::ReconnectStateMachine(std::string channel_id, double initial_delay,
                                              double max_delay, double backoff_factor,
                                              double watchdog_timeout, ReconnectFn reconnect_fn,
                                              NotifyFn notify_fn)
    : channel_id_(std::move(channel_id)),
      initial_delay_(initial_delay),
      max_delay_(max_delay),
      backoff_factor_(backoff_factor),
      watchdog_timeout_(watchdog_timeout),
      reconnect_fn_(std::move(reconnect_fn)),
      notify_fn_(std::move(notify_fn)),
      started_at_(NowWall()),
      current_delay_(initial_delay) {}

void ReconnectStateMachine::OnFrameReceived() {
  std::lock_guard<std::mutex> lock(mutex_);
  last_frame_time_ = NowWall();
  current_delay_ = initial_delay_;
  consecutive_failures_ = 0;
  reconnect_requested_ = false;
}

void ReconnectStateMachine::TriggerReconnect(const std::string& reason) {
  std::string notify_reason;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (reconnecting_) return;
    reconnect_requested_ = true;
    notify_reason = reason;
  }
  NotifyStackSampler(notify_reason);
}

void ReconnectStateMachine::NotifyStackSampler(const std::string& reason) {
  if (notify_fn_) {
    notify_fn_("[" + channel_id_ + "] " + reason);
  }
}

bool ReconnectStateMachine::CheckWatchdog() {
  bool triggered;
  std::string reason;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (reconnecting_ || reconnect_requested_) {
      return reconnect_requested_;
    }

    double now = NowWall();
    double elapsed;
    if (last_frame_time_ > 0) {
      elapsed = now - last_frame_time_;
      reason = "距上次收帧超时";
    } else {
      elapsed = now - started_at_;
      reason = "启动后未收到首帧超时";
    }
    triggered = elapsed > watchdog_timeout_;
    if (triggered) reconnect_requested_ = true;
  }
  if (triggered) NotifyStackSampler(reason);
  return triggered;
}

bool ReconnectStateMachine::NeedsReconnect() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return reconnect_requested_ && !reconnecting_;
}

bool ReconnectStateMachine::IsRecovering() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return reconnect_requested_ || reconnecting_;
}

bool ReconnectStateMachine::DoReconnect() {
  double delay;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!reconnect_requested_) return true;
    reconnecting_ = true;
    delay = current_delay_;
  }

  bool result;
  double slept = 0.0;
  while (slept < delay && !stop_flag_.load()) {
    double step = std::min(0.1, delay - slept);
    std::this_thread::sleep_for(std::chrono::duration<double>(step));
    slept += 0.1;
  }

  if (stop_flag_.load()) {
    result = false;
  } else {
    bool success = reconnect_fn_ ? reconnect_fn_() : true;
    std::lock_guard<std::mutex> lock(mutex_);
    if (success) {
      reconnect_requested_ = false;
      consecutive_failures_ = 0;
      current_delay_ = initial_delay_;
      last_frame_time_ = NowWall();
    } else {
      consecutive_failures_++;
      current_delay_ = std::min(current_delay_ * backoff_factor_, max_delay_);
      reconnect_requested_ = true;
    }
    result = success;
  }

  // 对应 Python try/finally:无论上面走哪条路径,reconnecting_ 都要复位。
  {
    std::lock_guard<std::mutex> lock(mutex_);
    reconnecting_ = false;
  }
  return result;
}

void ReconnectStateMachine::Stop() {
  stop_flag_.store(true);
  std::lock_guard<std::mutex> lock(mutex_);
  reconnect_requested_ = false;
}

int ReconnectStateMachine::ConsecutiveFailures() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return consecutive_failures_;
}

double ReconnectStateMachine::CurrentDelay() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return current_delay_;
}

}  // namespace ai_service::stream
