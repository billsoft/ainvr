#include "result_buffer.hpp"

#include <algorithm>

namespace ai_service {

void ResultBuffer::Append(FrameResult result) {
  std::lock_guard<std::mutex> lock(mutex_);
  buf_.push_back(std::move(result));
  while (buf_.size() > max_frames_) buf_.pop_front();
}

std::optional<FrameResult> ResultBuffer::Latest() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (buf_.empty()) return std::nullopt;
  return buf_.back();
}

std::vector<FrameResult> ResultBuffer::LastN(size_t n) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (n == 0 || buf_.empty()) return {};
  n = std::min(n, buf_.size());
  return std::vector<FrameResult>(buf_.end() - static_cast<long>(n), buf_.end());
}

std::vector<FrameResult> ResultBuffer::All() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return std::vector<FrameResult>(buf_.begin(), buf_.end());
}

size_t ResultBuffer::Size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return buf_.size();
}

void ResultBuffer::Clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  buf_.clear();
}

void ResultBuffer::Resize(size_t new_max) {
  std::lock_guard<std::mutex> lock(mutex_);
  max_frames_ = new_max;
  while (buf_.size() > max_frames_) buf_.pop_front();
}

}  // namespace ai_service
