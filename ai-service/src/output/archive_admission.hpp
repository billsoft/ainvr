// Copyright AINVR. Reserve before selecting a frame for reliable archival.
#pragma once
#include "archive_capacity.hpp"
#include <optional>
namespace ai_service::output {
class ArchiveAdmission {
  struct State {
    explicit State(std::shared_ptr<ArchiveCapacity::Pool> pool):capacity(std::move(pool)){}
    ArchiveCapacity capacity;
    std::mutex mutex;std::condition_variable changed;
    size_t active=0;bool stopped=false;
  };
 public:
  class Ticket {
   public:
    Ticket(const Ticket&)=delete;Ticket& operator=(const Ticket&)=delete;
    Ticket(Ticket&& other) noexcept:state_(std::move(other.state_)){}
    Ticket& operator=(Ticket&& other) noexcept {
      if(this!=&other){Release();state_=std::move(other.state_);}return *this;
    }
    ~Ticket(){Release();}
   private:
    friend class ArchiveAdmission;
    explicit Ticket(std::shared_ptr<State> state):state_(std::move(state)){}
    void Release() noexcept {
      if(!state_)return;
      auto state=std::move(state_);
      {std::lock_guard lock(state->mutex);--state->active;}
      state->changed.notify_all();
    }
    std::shared_ptr<State> state_;
  };
  explicit ArchiveAdmission(std::shared_ptr<ArchiveCapacity::Pool> pool=ArchiveCapacity::SharedPool())
      :state_(std::make_shared<State>(std::move(pool))){}
  ~ArchiveAdmission(){Stop();}
  ArchiveAdmission(const ArchiveAdmission&)=delete;
  ArchiveAdmission& operator=(const ArchiveAdmission&)=delete;
  // Predicate must be fast and non-reentrant. Exceptions cancel admission.
  // The ticket owns the reservation through preparation and durable staging.
  std::optional<Ticket> Acquire(size_t frame_bytes,const std::function<bool()>& proceed) {
    if(!frame_bytes||!proceed)throw std::invalid_argument("Invalid archive admission");
    auto state=state_;std::unique_lock lock(state->mutex);
    for(;;){
      bool allowed=false;try{allowed=proceed();}catch(...){}
      if(state->stopped||!allowed)return std::nullopt;
      if(state->active<2){
        state->capacity.Configure(frame_bytes);++state->active;
        return Ticket(state);
      }
      state->changed.wait_for(lock,std::chrono::milliseconds(20));
    }
  }
  void Stop(){auto state=state_;{std::lock_guard lock(state->mutex);state->stopped=true;}state->changed.notify_all();}
 private:
  std::shared_ptr<State> state_;
};
}
