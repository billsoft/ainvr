#pragma once
#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

namespace ainvr::llm {
enum class ReviewTask { Alarm, Search };
struct TaskIdentity {
  using Clock = std::chrono::steady_clock;
  ReviewTask task = ReviewTask::Alarm;
  std::string caller, request_id;
  Clock::time_point queued = Clock::now();
  std::atomic<bool> canceled{false};
};
// The large model is reserved for alarm review. Search verification is permanently off in this build.
inline constexpr bool kSearchVerificationEnabled = false;
enum class TaskAdmission { Accepted, Duplicate, SearchBusy, SearchDisabled, Full };
// Only one search handler may decode/copy a bounded JPEG body at a time.
// The existing inference queue still owns the only retained job payload.
class SearchParsingPermit {
 public:
  SearchParsingPermit(std::mutex& mutex, bool& busy) : mutex_(mutex), busy_(busy) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (busy_) throw std::runtime_error("search_busy");
    busy_ = true;
  }
  ~SearchParsingPermit() { if (held_) { std::lock_guard<std::mutex> lock(mutex_); busy_ = false; } }
  SearchParsingPermit(const SearchParsingPermit&) = delete;
  SearchParsingPermit& operator=(const SearchParsingPermit&) = delete;
  void ReleaseLocked() { busy_ = false; held_ = false; }
 private:
  std::mutex& mutex_; bool& busy_; bool held_ = true;
};
// Policy over the service's existing single queue. No additional queue, worker,
// retained payload registry or model residency lives in this helper.
template<class Job> TaskAdmission AdmitTask(const std::deque<std::shared_ptr<Job>>& queue,
    const std::shared_ptr<Job>& active, const Job& proposed, size_t capacity) {
  if (proposed.task == ReviewTask::Search) {
    if (!kSearchVerificationEnabled) return TaskAdmission::SearchDisabled;
    auto same = [&](const auto& job) { return job && job->task == ReviewTask::Search &&
      job->caller == proposed.caller && job->request_id == proposed.request_id; };
    if (same(active) || std::any_of(queue.begin(), queue.end(), same)) return TaskAdmission::Duplicate;
    auto search = [](const auto& job) { return job && job->task == ReviewTask::Search; };
    if (search(active) || std::any_of(queue.begin(), queue.end(), search)) return TaskAdmission::SearchBusy;
  }
  return queue.size() >= capacity ? TaskAdmission::Full : TaskAdmission::Accepted;
}
template<class Job> std::shared_ptr<Job> TakeTask(std::deque<std::shared_ptr<Job>>& queue,
    bool previous_search, TaskIdentity::Clock::time_point now = TaskIdentity::Clock::now()) {
  if (queue.empty()) return {};
  const auto alarm = std::find_if(queue.begin(), queue.end(), [](const auto& job) { return job->task == ReviewTask::Alarm; });
  const auto search = std::find_if(queue.begin(), queue.end(), [](const auto& job) { return job->task == ReviewTask::Search; });
  (void)previous_search; (void)now;
  // Alarms are strictly first; anything else only runs when no alarm is waiting.
  auto chosen = alarm;
  if (alarm == queue.end()) chosen = search != queue.end() ? search : queue.begin();
  auto job = *chosen; queue.erase(chosen); return job;
}
struct TaskCancellation { size_t queued = 0; bool active = false; };
template<class Job, class Finish> bool PreemptQueuedSearch(std::deque<std::shared_ptr<Job>>& queue,
    size_t capacity, Finish finish) {
  if (queue.size() < capacity) return false;
  const auto found = std::find_if(queue.begin(), queue.end(), [](const auto& job) { return job->task == ReviewTask::Search; });
  if (found == queue.end()) return false;
  auto job = *found; queue.erase(found); job->canceled = true; finish(job); return true;
}
template<class Job, class Finish> TaskCancellation CancelSearchTasks(std::deque<std::shared_ptr<Job>>& queue,
    const std::shared_ptr<Job>& active, const std::string& caller, const std::string& id, Finish finish) {
  TaskCancellation output;
  auto same = [&](const auto& job) { return job && job->task == ReviewTask::Search && job->caller == caller && job->request_id == id; };
  for (auto it = queue.begin(); it != queue.end();) {
    if (!same(*it)) { ++it; continue; }
    auto job = *it; it = queue.erase(it); job->canceled = true; ++output.queued; finish(job);
  }
  if (same(active)) { active->canceled = true; output.active = true; }
  return output;
}
} // namespace ainvr::llm
