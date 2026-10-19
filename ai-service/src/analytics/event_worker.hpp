// AINVR. One bounded, channel-scoped asynchronous stage consumer.
#pragma once
#include "event_store.hpp"
#include <bson/bson.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
namespace ai_service::analytics {
class EventWorker {
 public:
  struct Context {
    std::chrono::steady_clock::time_point deadline;
    const std::atomic<bool>& stopping;
    bool Cancelled()const{return stopping||std::chrono::steady_clock::now()>=deadline;}
  };
  struct Outcome {std::string status;nlohmann::json details=nlohmann::json::object();};
  // Handlers must impose transport deadlines and observe cancellation. No
  // detached thread may keep using evidence/model memory after Stop returns.
  using Handler=std::function<Outcome(const nlohmann::json&,const Context&)>;
  EventWorker(std::shared_ptr<EventStore> store,std::string channel,
              std::string stage,Handler handler,int lease_seconds=60)
      :store_(std::move(store)),channel_(std::move(channel)),stage_(std::move(stage)),
       handler_(std::move(handler)),lease_seconds_(lease_seconds) {
    if(!store_||channel_.empty()||channel_.size()>512||
       (stage_!="review"&&stage_!="notification")||!handler_||lease_seconds<3||lease_seconds>3600)
      throw std::invalid_argument("Invalid asynchronous event worker");
    thread_=std::thread([this]{Run();});
  }
  ~EventWorker(){Stop();}
  EventWorker(const EventWorker&)=delete;
  EventWorker& operator=(const EventWorker&)=delete;
  void Stop(){stop_=true;wake_.notify_all();if(thread_.joinable())thread_.join();}
  uint64_t Completed()const{return completed_;}
  uint64_t Failures()const{return failures_;}
  uint64_t LostLeases()const{return lost_leases_;}
 private:
  static double Now(){return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();}
  void Run() {
    while(!stop_) {
      try {
        if(stage_=="notification")store_->AdvanceNotifications(channel_);
        for(const auto& event:store_->ReadyJobs(channel_,stage_,Now())) {
          if(stop_)break;
          try {
            bson_oid_t oid;bson_oid_init(&oid,nullptr);char token[25];bson_oid_to_string(&oid,token);
            const auto id=event.at("event_id").get<std::string>();
            if(!store_->ClaimJob(id,stage_,token,Now(),lease_seconds_))continue;
            const Context context{std::chrono::steady_clock::now()+std::chrono::seconds(lease_seconds_-2),stop_};
            Outcome outcome;
            try {
              const auto prior=event.value(stage_+"_job",nlohmann::json::object()).value("attempts",0);
              outcome=prior>=5?Outcome{"failed",{{"code","recovery_attempts_exhausted"}}}:handler_(event,context);
            }
            catch(...) {outcome={"failed",{{"code","handler_failed"}}};++failures_;}
            // Stop leaves durable ownership to expire. Never call an unexecuted
            // notification "sent" or turn cancellation into review approval.
            if(stop_)break;
            if(context.Cancelled())outcome={"timeout",{{"code","deadline_exceeded"}}};
            const bool valid=stage_=="review"?
              (outcome.status=="approved"||outcome.status=="rejected"||outcome.status=="failed"||outcome.status=="timeout"||outcome.status=="unavailable"):
              (outcome.status=="sent"||outcome.status=="failed"||outcome.status=="timeout");
            if(!valid||!outcome.details.is_object()||outcome.details.dump().size()>16384)
              outcome={"failed",{{"code","invalid_handler_result"}}};
            if(store_->FinishJob(id,stage_,token,Now(),outcome.status,outcome.details))++completed_;
            else ++lost_leases_;
          }catch(...){++failures_;}
        }
      }catch(...){++failures_;}
      std::unique_lock lock(mutex_);
      wake_.wait_for(lock,std::chrono::milliseconds(250),[this]{return stop_.load();});
    }
  }
  std::shared_ptr<EventStore> store_;
  std::string channel_,stage_;
  Handler handler_;int lease_seconds_;
  std::atomic<bool> stop_{false};
  std::atomic<uint64_t> completed_{0},failures_{0},lost_leases_{0};
  std::mutex mutex_;std::condition_variable wake_;std::thread thread_;
};
}
