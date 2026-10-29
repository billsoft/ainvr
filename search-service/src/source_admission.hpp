// Non-queuing source-write fence. Does not stop queries, receipts or migration.
#pragma once
#include "model_pin.hpp"
#include <chrono>
#include <algorithm>
#include <stdexcept>
#include <memory>
#include <mutex>
#include <optional>
namespace ainvr::search {
struct RuntimeIngestionGate {
  std::string plan_id,epoch,worker,source_ids_sha256;
  int64_t generation=0,expires_ms=0;
  RuntimeModelPin source;
};
class SourceAdmission {
  using Clock=std::chrono::steady_clock;
  struct State {std::mutex mutex;size_t active=0;bool sealed=false;std::optional<RuntimeIngestionGate> gate;
    Clock::time_point first{},until{};};
 public:
  class Permit {
   public:
    Permit(Permit&&other)noexcept:state_(std::move(other.state_)){}
    Permit&operator=(Permit&&other)noexcept{if(this!=&other){Release();state_=std::move(other.state_);}return *this;}
    ~Permit(){Release();}
    Permit(const Permit&)=delete;Permit&operator=(const Permit&)=delete;
   private:
    friend class SourceAdmission;explicit Permit(std::shared_ptr<State>s):state_(std::move(s)){}
    void Release(){if(state_){auto owner=std::move(state_);std::lock_guard<std::mutex>lock(owner->mutex);--owner->active;}}
    std::shared_ptr<State>state_;
  };
  SourceAdmission():state_(std::make_shared<State>()){}
  // Bootstrap, generation shutdown and failed durable Begin also close the
  // existing admission owner. No fabricated PG gate or ACK is introduced.
  void Seal(){std::lock_guard<std::mutex>lock(state_->mutex);state_->sealed=true;}
  bool Drained()const{std::lock_guard<std::mutex>lock(state_->mutex);return state_->active==0;}
  // Parsing and source-ID digest validation occur at the trusted runtime edge.
  // A renewal can only extend to the epoch's original 120-second steady bound.
  // The gate stays closed after that ACK deadline. Apply(null) is a low-level
  // resume action: the trusted controller may call it only after durable Begin
  // has established a new source-writer epoch that fences old producer grants.
  void Apply(const std::optional<RuntimeIngestionGate>&next,int64_t wall_ms,Clock::time_point now=Clock::now()){
    std::lock_guard<std::mutex>lock(state_->mutex);
    if(!next){state_->gate.reset();state_->sealed=false;return;}
    const auto remaining=next->expires_ms-wall_ms;
    if(!state_->gate||state_->gate->epoch!=next->epoch){state_->first=now;state_->until=now;}
    else if(state_->gate->plan_id!=next->plan_id||state_->gate->worker!=next->worker||state_->gate->generation!=next->generation||
        state_->gate->source_ids_sha256!=next->source_ids_sha256||!MatchesRuntimeModelPin(state_->gate->source,next->source))
      throw std::invalid_argument("ingestion_gate_epoch_changed");
    state_->gate=next;state_->sealed=true;
    state_->until=std::min(state_->first+std::chrono::seconds(120),now+std::chrono::milliseconds(std::max(int64_t(0),remaining)));
  }
  std::optional<Permit> TryEnter(Clock::time_point=Clock::now()){
    std::lock_guard<std::mutex>lock(state_->mutex);
    if(state_->sealed)return std::nullopt;
    ++state_->active;return Permit(state_);
  }
  std::optional<RuntimeIngestionGate> DrainedGate(Clock::time_point now=Clock::now())const{
    std::lock_guard<std::mutex>lock(state_->mutex);
    if(!state_->gate||now>=state_->until||state_->active)return std::nullopt;
    return state_->gate;
  }
 private:std::shared_ptr<State>state_;
};
}  // namespace ainvr::search
