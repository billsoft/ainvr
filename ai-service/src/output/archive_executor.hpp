#pragma once

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
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
    auto task = std::make_shared<std::packaged_task<void()>>(std::move(fn));
    auto result = task->get_future();
    {
      std::unique_lock<std::mutex> lock(mutex_);
      space_.wait(lock, [this] { return stopping_ || tasks_.size() < capacity_; });
      if (stopping_) throw std::runtime_error("archive executor stopped");
      tasks_.emplace_back([task] { (*task)(); });
    }
    ready_.notify_one();
    return result;
  }

 private:
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
