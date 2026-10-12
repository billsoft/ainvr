#pragma once
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace ai_service::output {
// Reserve both frame slots for a channel. Admission never waits for another
// channel to drain; admitted channels wait only for their own outstanding frames.
class ArchiveCapacity {
 public:
  struct Pool { std::mutex mutex; size_t reserved = 0; size_t limit = size_t(384) << 20; };
  explicit ArchiveCapacity(std::shared_ptr<Pool> pool) : pool_(std::move(pool)) {}
  ~ArchiveCapacity() {
    Release();
  }
  void Release() {
    std::lock_guard<std::mutex> lock(pool_->mutex);
    pool_->reserved -= reserved_;
    reserved_ = 0;
  }
  void Configure(size_t frame_bytes) {
    std::lock_guard<std::mutex> lock(pool_->mutex);
    if (frame_bytes <= reserved_ / 2) return;
    if (frame_bytes > pool_->limit / 2 ||
        pool_->reserved - reserved_ > pool_->limit - 2 * frame_bytes)
      throw std::runtime_error("归档截图缓存额度不足，请减少归档通道或输入分辨率；未启用抽样");
    pool_->reserved += 2 * frame_bytes - reserved_;
    reserved_ = 2 * frame_bytes;
  }
  size_t Reserved() const {
    std::lock_guard<std::mutex> lock(pool_->mutex);
    return reserved_;
  }
  static std::shared_ptr<Pool> SharedPool() {
    static auto pool = std::make_shared<Pool>();
    return pool;
  }
 private:
  std::shared_ptr<Pool> pool_;
  size_t reserved_ = 0;
};
}  // namespace ai_service::output
