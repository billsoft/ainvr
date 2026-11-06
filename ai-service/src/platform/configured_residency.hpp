#pragma once
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>
#include <condition_variable>
#include <deque>
#include <thread>

namespace ainvr {
// Configuration owns residency, callers own execution. Updating demand never
// loads a resource. Dropping demand cannot destroy a resource held by a task.
template<class T> class ConfiguredResidency {
 public:
  using Demand = std::map<std::string, std::set<std::string>>;
  ConfiguredResidency():reaper_([this]{Reap();}){}
  ~ConfiguredResidency(){
    {std::lock_guard lock(retire_mutex_);stopping_=true;}
    retire_cv_.notify_all();reaper_.join();
  }
  ConfiguredResidency(const ConfiguredResidency&)=delete;
  ConfiguredResidency& operator=(const ConfiguredResidency&)=delete;
  // Secondary wrapper registries can share the same bounded retirement policy.
  void RetireResource(std::shared_ptr<T> value){
    if(!value)return;
    std::map<std::string,std::shared_ptr<T>> batch;
    batch.emplace("retired",std::move(value));Retire(std::move(batch));
  }
  void DrainRetired(){
    std::unique_lock lock(retire_mutex_);
    retire_cv_.wait(lock,[this]{return retired_.empty()&&!releasing_;});
  }
  void Update(Demand desired) {
    std::map<std::string, std::shared_ptr<T>> retired;
    {
      std::lock_guard lock(mutex_);
      if (desired == demand_) return;
      demand_ = std::move(desired);
      retired.swap(resident_);
      for (const auto& [key, owners] : demand_) {
        if (!owners.empty()) if (auto value = seen_[key].lock())
          resident_[key] = std::move(value);
      }
      for (auto i = seen_.begin(); i != seen_.end();)
        if (i->second.expired() && !demand_.count(i->first)) i = seen_.erase(i);
        else ++i;
    }
    // The caller may still hold ConfigStore's locks. Release on the dedicated
    // bounded worker, not on that caller. SharedRuntimeCache fences reacquisition
    // until SDK teardown completes, including after the weak pointer expires.
    Retire(std::move(retired));
  }
  void Observe(const std::string& key, const std::shared_ptr<T>& value) {
    std::shared_ptr<T> retired;
    {
      std::lock_guard lock(mutex_);
      seen_[key] = value;
      const auto demand = demand_.find(key);
      if (demand != demand_.end() && !demand->second.empty()) {
        if(resident_[key]==value)return;
        retired = std::move(resident_[key]);
        resident_[key] = value;
      }
    }
    if(retired){std::map<std::string,std::shared_ptr<T>> batch;batch.emplace(key,std::move(retired));Retire(std::move(batch));}
  }
  struct Entry { std::string key; std::set<std::string> owners; bool resident; };
  std::vector<Entry> Snapshot() const {
    std::lock_guard lock(mutex_);
    std::vector<Entry> result;
    for (const auto& [key, owners] : demand_)
      result.push_back({key, owners, resident_.count(key) != 0});
    return result;
  }
 private:
  void Retire(std::map<std::string,std::shared_ptr<T>> batch){
    if(batch.empty())return;
    std::unique_lock lock(retire_mutex_);
    // Explicit backpressure for extreme churn; never create unbounded threads
    // or allow unlimited queued model allocations during a stuck SDK release.
    retire_cv_.wait(lock,[this]{return retired_.size()<64;});
    retired_.push_back(std::move(batch));lock.unlock();retire_cv_.notify_all();
  }
  void Reap(){
    for(;;){
      std::map<std::string,std::shared_ptr<T>> batch;
      {
        std::unique_lock lock(retire_mutex_);
        retire_cv_.wait(lock,[this]{return stopping_||!retired_.empty();});
        if(retired_.empty()&&stopping_)return;
        batch=std::move(retired_.front());retired_.pop_front();releasing_=true;
      }
      retire_cv_.notify_all();
      batch.clear(); // no residency/configuration/retirement lock during SDK calls
      {std::lock_guard lock(retire_mutex_);releasing_=false;}
      retire_cv_.notify_all();
    }
  }
  mutable std::mutex mutex_;
  Demand demand_;
  std::map<std::string, std::weak_ptr<T>> seen_;
  std::mutex retire_mutex_;std::condition_variable retire_cv_;
  std::deque<std::map<std::string,std::shared_ptr<T>>> retired_;
  bool stopping_=false,releasing_=false;
  std::map<std::string, std::shared_ptr<T>> resident_;
  std::thread reaper_;
};
}
