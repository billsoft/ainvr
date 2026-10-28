// AINVR. Process-wide search pixel ownership, not a queue or BPU reservation.
#pragma once
#include <cstddef>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <utility>
namespace ai_service::output {
// One instance belongs to the shared search producer, never one per channel.
// Acquire before retaining FrameRef or submitting to ArchiveExecutor::TrySubmit.
// Count queued AND running jobs, including old configuration generations.
class SearchWorkBudget {
  struct State {
    std::mutex mutex;
    size_t limit_jobs = 0, limit_bytes = 0, jobs = 0, bytes = 0;
    bool enabled = false;
  };
 public:
  struct Usage { size_t jobs, bytes; bool enabled; };
  class Ticket {
   public:
    Ticket(const Ticket&) = delete;
    Ticket& operator=(const Ticket&) = delete;
    Ticket(Ticket&& other) noexcept
        : state_(std::move(other.state_)), bytes_(std::exchange(other.bytes_, 0)) {}
    Ticket& operator=(Ticket&& other) noexcept {
      if (this != &other) { Release(); state_ = std::move(other.state_); bytes_ = std::exchange(other.bytes_, 0); }
      return *this;
    }
    ~Ticket() { Release(); }
    size_t ReservedBytes() const noexcept { return state_ ? bytes_ : 0; }
   private:
    Ticket(std::shared_ptr<State> state, size_t bytes) noexcept : state_(std::move(state)), bytes_(bytes) {}
    void Release() noexcept {
      if (!state_) return;
      { std::lock_guard<std::mutex> lock(state_->mutex); --state_->jobs; state_->bytes -= bytes_; }
      state_.reset(); bytes_ = 0;
    }
    std::shared_ptr<State> state_;
    size_t bytes_ = 0;
    friend class SearchWorkBudget;
  };
  SearchWorkBudget() : state_(std::make_shared<State>()) {}
  SearchWorkBudget(const SearchWorkBudget&) = delete;
  SearchWorkBudget& operator=(const SearchWorkBudget&) = delete;
  // Configuration-client thread only. Lowering limits never forgets live bytes.
  void Configure(size_t jobs, size_t bytes) {
    if (!jobs || jobs > 4 || bytes < 8388608 || bytes > 268435456)
      throw std::invalid_argument("invalid_search_work_budget");
    std::lock_guard<std::mutex> lock(state_->mutex);
    state_->limit_jobs = jobs; state_->limit_bytes = bytes; state_->enabled = true;
  }
  void Disable() {
    std::lock_guard<std::mutex> lock(state_->mutex); state_->enabled = false;
  }
  std::optional<Ticket> TryAcquire(size_t retained_bytes) {
    if (!retained_bytes) return std::nullopt;
    std::unique_lock<std::mutex> lock(state_->mutex, std::try_to_lock);
    if (!lock.owns_lock() || !state_->enabled || state_->jobs >= state_->limit_jobs ||
        state_->bytes > state_->limit_bytes || retained_bytes > state_->limit_bytes - state_->bytes)
      return std::nullopt;
    ++state_->jobs; state_->bytes += retained_bytes;
    return Ticket(state_, retained_bytes);
  }
  Usage Inspect() const {
    std::lock_guard<std::mutex> lock(state_->mutex);
    return {state_->jobs, state_->bytes, state_->enabled};
  }
 private:
  // Tickets outlive the producer safely while shutdown joins outstanding work.
  std::shared_ptr<State> state_;
};
}  // namespace ai_service::output
