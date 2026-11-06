#pragma once
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ainvr {
// Configuration owns residency, callers own execution. Updating demand never
// loads a resource. Dropping demand cannot destroy a resource held by a task.
template<class T> class ConfiguredResidency {
 public:
  using Demand = std::map<std::string, std::set<std::string>>;
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
    // SDK teardown must never hold the configuration mutex.
  }
  void Observe(const std::string& key, const std::shared_ptr<T>& value) {
    std::shared_ptr<T> retired;
    {
      std::lock_guard lock(mutex_);
      seen_[key] = value;
      const auto demand = demand_.find(key);
      if (demand != demand_.end() && !demand->second.empty()) {
        retired = std::move(resident_[key]);
        resident_[key] = value;
      }
    }
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
  mutable std::mutex mutex_;
  Demand demand_;
  std::map<std::string, std::weak_ptr<T>> seen_;
  std::map<std::string, std::shared_ptr<T>> resident_;
};
}
