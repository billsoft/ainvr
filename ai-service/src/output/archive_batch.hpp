#pragma once

#include <exception>
#include <future>
#include <utility>
#include <vector>

namespace ai_service::output {

// The caller owns the jobs even when preparation throws. Only one task may
// access them; Join must complete before the caller reads or moves the batch.
template <class Job>
class ArchiveBatch {
 public:
  ArchiveBatch() = default;
  ArchiveBatch(const ArchiveBatch&) = delete;
  ArchiveBatch& operator=(const ArchiveBatch&) = delete;
  ~ArchiveBatch() { Join(); }

  std::vector<Job> jobs;

  bool Pending() const { return task_.valid(); }

  template <class Prepare, class Launch>
  bool Start(Prepare prepare, Launch launch) noexcept {
    if (Pending()) return false;
    try {
      task_ = launch([this, prepare = std::move(prepare)]() mutable { prepare(jobs); });
      return true;
    } catch (...) {
      error_ = std::current_exception();
      return false;
    }
  }

  template <class Prepare>
  bool Start(Prepare prepare) noexcept {
    return Start(std::move(prepare), [](auto work) {
      return std::async(std::launch::async, std::move(work));
    });
  }

  std::exception_ptr Join() noexcept {
    try {
      if (task_.valid()) task_.get();
    } catch (...) {
      error_ = std::current_exception();
    }
    return std::exchange(error_, {});
  }

 private:
  std::future<void> task_;
  std::exception_ptr error_;
};

}  // namespace ai_service::output
