// Copyright AINVR. One merged residency writer; budget outlives SDK resources.
#pragma once
#include "face_embedding/extractor.hpp"
#include <atomic>
#include <mutex>

namespace ainvr::face {
struct Reservation {
  std::shared_ptr<void> custody;
  std::function<void()> loaded;
};
class Residency {
  struct Holding {
    Reservation reservation;
    std::atomic<bool> active{true};
    std::mutex mutex;
    std::vector<std::weak_ptr<void>> models;
    bool ModelsGone(){std::lock_guard lock(mutex);return std::all_of(models.begin(),models.end(),[](auto& w){return w.expired();});}
  };
  struct Book {std::mutex mutex;std::vector<std::weak_ptr<Holding>> holders;};
 public:
  using Reserve=std::function<Reservation(const Settings&)>;
  using Publish=std::function<void(Demand)>;
  Residency(Reserve reserve,Publish publish):reserve_(std::move(reserve)),publish_(std::move(publish)) {
    if(!reserve_||!publish_)throw std::invalid_argument("face_residency_dependencies");
  }
  ~Residency(){
    // Shutdown normally drains model residency first. If callers violate that
    // order, retain accounting until process exit instead of under-accounting.
    for(auto& h:holdings_)if(!h->ModelsGone()){
      static auto* held=new std::vector<std::shared_ptr<Holding>>;
      static auto* lock=new std::mutex;
      std::lock_guard guard(*lock);held->push_back(std::move(h));
    }
  }
  void SetBase(Demand base) {
    std::lock_guard lock(mutex_);auto merged=base;AppendDemand(merged,face_);
    publish_(std::move(merged));base_=std::move(base);ReapLocked();
  }
  BudgetLease Apply(const Settings& next) {
    std::lock_guard lock(mutex_);ReapLocked();
    if(next.enabled&&holdings_.size()>=8)throw std::runtime_error("face_retirement_capacity");
    std::shared_ptr<Holding> holding;
    if(next.enabled){
      holding=std::make_shared<Holding>();holding->reservation=reserve_(next);
      if(!holding->reservation.custody)throw std::runtime_error("face_budget_unavailable");
      std::lock_guard guard(book_->mutex);
      std::erase_if(book_->holders,[](const auto& w){return w.expired();});
      book_->holders.push_back(holding);
    }
    auto merged=base_;AppendDemand(merged,next);
    publish_(std::move(merged)); // Failed publication cannot revoke the old lease.
    if(active_)active_->active=false;
    face_=next;active_=holding;
    if(!holding)return {};
    holdings_.push_back(holding);
    std::weak_ptr<Holding> weak=holding;
    BudgetLease lease;lease.custody=holding;
    lease.current=[weak]{auto p=weak.lock();return p&&p->active.load();};
    lease.observe_model=[weak,book=book_](std::weak_ptr<void> model){
      auto p=weak.lock();if(!p)throw std::runtime_error("face_budget_retired");
      std::lock_guard serial(book->mutex);
      // New admission already reserves this entire model set. Transfer shared
      // resources before retiring old accounting, so a common detector cannot
      // pin every previous generation's reservation forever. Observe first:
      // allocation failure must leave the previous accounting intact.
      {std::lock_guard guard(p->mutex);p->models.push_back(model);}
      for(auto& w:book->holders)if(auto old=w.lock();old&&old!=p&&!old->active){
        std::lock_guard guard(old->mutex);
        std::erase_if(old->models,[&](const auto& prior){
          return !prior.owner_before(model)&&!model.owner_before(prior);
        });
      }
    };
    lease.loaded=[weak]{auto p=weak.lock();if(!p||!p->active)throw std::runtime_error("face_budget_retired");
      if(p->reservation.loaded)p->reservation.loaded();};
    return lease;
  }
  void Reap(){std::lock_guard lock(mutex_);ReapLocked();}
  size_t Holdings()const{std::lock_guard lock(mutex_);return holdings_.size();}
 private:
  void ReapLocked(){
    std::erase_if(holdings_,[](auto& h){return !h->active&&h.use_count()==1&&h->ModelsGone();});
  }
  Reserve reserve_;Publish publish_;mutable std::mutex mutex_;Demand base_;Settings face_;
  std::shared_ptr<Holding> active_;std::vector<std::shared_ptr<Holding>> holdings_;
  std::shared_ptr<Book> book_=std::make_shared<Book>();
};
} // namespace ainvr::face
