#pragma once

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

namespace ai_service::output {

// Shared across channels. Producers are writer threads, never pool workers.
// Joining every returned future is required before destroying its captures.
class ArchiveExecutor {
 public:
  explicit ArchiveExecutor(size_t workers = 4, size_t capacity = 64)
      : capacity_(std::max(size_t(1), capacity)) {
    try {
      for (size_t i = 0; i < std::max(size_t(1), workers); ++i)
        workers_.emplace_back([this] {
          for (;;) {
            std::function<void()> task;
            {
              std::unique_lock<std::mutex> lock(mutex_);
              ready_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
              if (tasks_.empty()) return;
              task = std::move(tasks_.front());
              tasks_.pop_front();
            }
            space_.notify_one();
            task();  // packaged_task transfers exceptions to the future
          }
        });
    } catch (...) {
      Shutdown();
      throw;
    }
  }
  ~ArchiveExecutor() { Shutdown(); }
  ArchiveExecutor(const ArchiveExecutor&) = delete;
  ArchiveExecutor& operator=(const ArchiveExecutor&) = delete;

  std::future<void> Submit(std::function<void()> fn) {
    std::future<void> result;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      space_.wait(lock, [this] { return stopping_ || tasks_.size() < capacity_; });
      if (stopping_) throw std::runtime_error("archive executor stopped");
      result = EnqueueLocked(std::move(fn));
    }
    ready_.notify_one();
    return result;
  }

  // Optional background work must not slow real-time producers. A contended
  // admission lock, full queue or shutdown rejects immediately; the callback is
  // never executed in that case. A returned future has the same completion and
  // exception contract as Submit and must be joined before captures are freed.
  std::optional<std::future<void>> TrySubmit(std::function<void()> fn) {
    std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock() || stopping_ || tasks_.size() >= capacity_)
      return std::nullopt;
    auto result = EnqueueLocked(std::move(fn));
    lock.unlock();
    ready_.notify_one();
    return result;
  }

 private:
  // Caller holds mutex_. Both admission modes use exactly the same queue and
  // packaged-task exception handling; no parallel executor is introduced.
  std::future<void> EnqueueLocked(std::function<void()> fn) {
    auto task = std::make_shared<std::packaged_task<void()>>(std::move(fn));
    auto result = task->get_future();
    tasks_.emplace_back([task] { (*task)(); });
    return result;
  }
  void Shutdown() {
    { std::lock_guard<std::mutex> lock(mutex_); stopping_ = true; }
    ready_.notify_all();
    space_.notify_all();
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
  }
  size_t capacity_;
  bool stopping_ = false;
  std::mutex mutex_;
  std::condition_variable ready_, space_;
  std::deque<std::function<void()>> tasks_;
  std::vector<std::thread> workers_;
};

inline size_t ArchiveWorkerCount() {
  // S100P live archive trial: six workers increased GPU contention and memory
  // without throughput benefit. Keep four; see S100P-ARCHIVE-PIPELINE.md.
  static const size_t count = [] {
    const auto cores = std::thread::hardware_concurrency();
    return std::clamp<size_t>(cores > 2 ? cores - 2 : 2, 2, 4);
  }();
  return count;
}

inline ArchiveExecutor& SharedArchiveExecutor() {
  static ArchiveExecutor executor(ArchiveWorkerCount());
  return executor;
}
}  // namespace ai_service::output
