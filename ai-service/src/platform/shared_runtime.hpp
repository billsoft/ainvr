#pragma once
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ainvr {
// FIFO across callers; ownership lasts through output copying. Pending work is
// bounded by each channel's existing two-future pipeline, not an extra queue.
class FifoMutex {
 public:
  void lock(){std::unique_lock lock(mutex_);const auto ticket=next_++;cv_.wait(lock,[&]{return ticket==serving_;});}
  void unlock(){ {std::lock_guard lock(mutex_);++serving_;}cv_.notify_all();}
  uint64_t Waiting(){std::lock_guard lock(mutex_);return next_-serving_;}
 private:
  std::mutex mutex_;std::condition_variable cv_;uint64_t next_=0,serving_=0;
};

// The slot remains alive through destruction. A new lease must wait until the
// old SDK resource is completely released, even after its weak pointer expires.
template<class T> class SharedRuntimeCache {
 struct Slot {std::mutex mutex;std::condition_variable cv;std::weak_ptr<T> current;bool live=false;};
 struct Owner {
  std::shared_ptr<Slot> slot;std::shared_ptr<T> resource;
  Owner(std::shared_ptr<Slot> s,std::shared_ptr<T> r):slot(std::move(s)),resource(std::move(r)){}
  ~Owner(){ {std::lock_guard lock(slot->mutex);resource.reset();slot->live=false;}slot->cv.notify_all();}
 };
 public:
  template<class Factory> std::shared_ptr<T> Acquire(const std::string& key,Factory factory){
   std::shared_ptr<Slot> slot;
   {std::lock_guard lock(mutex_);
    for(auto i=slots_.begin();i!=slots_.end();)if(i->second.expired())i=slots_.erase(i);else ++i;
    slot=slots_[key].lock();if(!slot){slot=std::make_shared<Slot>();slots_[key]=slot;}
   }
   std::unique_lock lock(slot->mutex);
   for(;;){if(auto existing=slot->current.lock())return existing;if(!slot->live)break;slot->cv.wait(lock);}
   auto resource=factory();
   auto owner=std::make_shared<Owner>(slot,std::move(resource));
   std::shared_ptr<T> result(owner,owner->resource.get());
   slot->live=true;slot->current=result;return result;
  }
  // Take short-lived observation leases; never call SDK code under cache locks.
  std::vector<std::pair<std::string,std::shared_ptr<T>>> LiveSnapshot(){
   std::vector<std::pair<std::string,std::shared_ptr<T>>> out;std::lock_guard lock(mutex_);
   for(const auto& [key,weak]:slots_)if(auto slot=weak.lock()){
    std::unique_lock guard(slot->mutex,std::try_to_lock);
    if(guard.owns_lock())if(auto value=slot->current.lock())out.emplace_back(key,std::move(value));
   }
   return out;
  }
  std::vector<std::pair<std::string,long>> Snapshot(){
   std::vector<std::pair<std::string,long>> out;std::lock_guard lock(mutex_);
   for(const auto& [key,weak]:slots_)if(auto slot=weak.lock()){std::unique_lock guard(slot->mutex,std::try_to_lock);if(guard.owns_lock()&&slot->live)out.emplace_back(key,slot->current.use_count());}
   return out;
  }
 private:std::mutex mutex_;std::map<std::string,std::weak_ptr<Slot>> slots_;
};
}
