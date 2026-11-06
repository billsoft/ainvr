#pragma once
#include <mutex>
#include <set>
#include <string>
#include <nlohmann/json.hpp>
namespace ainvr {
// Repeated failed checks remain observable without pretending each is a new incident.
class ModelDependencyHealth {
 public:
  void Observe(const std::set<std::string>& faults){
    std::lock_guard lock(mutex_);++checks_;
    if(!faults.empty())++failed_checks_;
    for(const auto& f:faults)if(!active_.count(f))++incidents_;
    for(const auto& f:active_)if(!faults.count(f))++recoveries_;
    active_=faults;
    if(check_failed_)++recoveries_;
    check_failed_=false;
  }
  void Failed(){
    std::lock_guard lock(mutex_);++checks_;++failed_checks_;
    if(!check_failed_)++incidents_;
    check_failed_=true; // preserve last known dependencies until a complete check
  }
  nlohmann::json Status()const{
    std::lock_guard lock(mutex_);
    return {{"state",check_failed_?"unknown":active_.empty()?"healthy":"degraded"},
      {"current_invalid_dependencies",active_.size()},{"check_failed",check_failed_},
      {"checks",checks_},{"failed_checks",failed_checks_},
      {"incidents",incidents_},{"recoveries",recoveries_}};
  }
 private:
  mutable std::mutex mutex_;std::set<std::string> active_;
  bool check_failed_=false;uint64_t checks_=0,failed_checks_=0,incidents_=0,recoveries_=0;
};
}
