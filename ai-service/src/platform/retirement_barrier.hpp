#pragma once
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <stdexcept>

namespace ainvr {
// All asynchronous residency owners, including enhancement wrappers, participate.
// This fences queued retirement, not resources still owned by active tasks.
class RetirementBarrier {
 public:
  void Begin() { std::lock_guard lock(mutex_); ++pending_; }
  void End() { { std::lock_guard lock(mutex_); --pending_; } cv_.notify_all(); }
  bool WaitFor(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return cv_.wait_for(lock, timeout, [&]{return pending_ == 0;});
  }
  void BeforeColdLoad() {
    if (!WaitFor(std::chrono::seconds(5)))
      throw std::runtime_error("旧模型资源仍在回收，暂缓加载新模型；稍后自动重试");
  }
  uint64_t Pending() const { std::lock_guard lock(mutex_); return pending_; }
 private:
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  uint64_t pending_ = 0;
};
inline RetirementBarrier& SharedRetirementBarrier() {
  static auto* barrier = new RetirementBarrier;
  return *barrier;
}
}
