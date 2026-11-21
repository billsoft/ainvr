// Copyright AINVR. One admitted pair, one affine worker, lazy hardware.
#pragma once
#include "contract.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <memory>
#include <mutex>
#include <thread>
namespace ainvr::flow {
class Backend {
 public: virtual ~Backend()=default;
  virtual Json Match(const std::vector<uint8_t>&,const std::vector<uint8_t>&,const Current&){throw Error(503,"scene_match_unavailable");}
  virtual Json Run(const std::vector<uint8_t>& a,const std::vector<uint8_t>& b,const Current& current)=0;
};
using Factory=std::function<std::unique_ptr<Backend>()>;
Factory NativeFactory(std::string model_root);
class Runtime {
 public:
  Runtime(std::function<std::string()> token,std::function<bool()> allowed,Factory factory,
      std::chrono::milliseconds timeout=std::chrono::seconds(15))
      :token_(std::move(token)),allowed_(std::move(allowed)),factory_(std::move(factory)),timeout_(timeout){
    if(!token_||!allowed_||!factory_)throw std::invalid_argument("flow_dependencies");
    worker_=std::thread([this]{Loop();});
  }
  ~Runtime(){Stop();}
  void Stop(){std::call_once(stop_,[this]{
    {std::lock_guard lock(mutex_);stopping_=true;}
    changed_.notify_all();worker_.join();
  });}
  void RequireAccess(const Peer& peer)const{if(!Access(peer))throw Error(403,"flow_not_authorized");}
  Json Call(const std::string& body,const Peer& peer,bool scene=false){
    RequireAccess(peer);
    auto job=std::make_shared<Job>();job->peer=peer;job->scene=scene;job->deadline=Clock::now()+timeout_;
    auto future=job->done.get_future();
    {
      std::lock_guard lock(mutex_);
      if(stopping_)throw Error(503,"flow_stopping");
      if(busy_)throw Error(429,"flow_busy");
      if(Clock::now()<retry_)throw Error(503,"flow_hardware_backoff");
      busy_=true;
    }
    try{
      auto frames=Parse(body);job->a=std::move(frames.first);job->b=std::move(frames.second);
      std::lock_guard lock(mutex_);
      if(stopping_)throw Error(503,"flow_stopping");pending_=job;
    }catch(...){std::lock_guard lock(mutex_);busy_=false;throw;}
    changed_.notify_one();
    if(future.wait_until(job->deadline)!=std::future_status::ready){job->cancelled=true;throw Error(504,"flow_timeout");}
    auto result=future.get();RequireAccess(peer);
    if(Clock::now()>=job->deadline)throw Error(504,"flow_timeout");
    return result;
  }
 private:
  using Clock=std::chrono::steady_clock;
  struct Job{std::vector<uint8_t>a,b;Peer peer;Clock::time_point deadline;
    bool scene=false;std::promise<Json>done;std::atomic<bool>cancelled{false};};
  bool Access(const Peer& peer)const{try{return Authorized(peer,token_())&&allowed_();}catch(...){return false;}}
  bool CurrentJob(const Job& job)const{
    if(job.cancelled||Clock::now()>=job.deadline||!Access(job.peer))return false;
    std::lock_guard lock(mutex_);return !stopping_;
  }
  void Loop(){
    std::unique_ptr<Backend> hardware;
    for(;;){
      std::shared_ptr<Job> job;
      {
        std::unique_lock lock(mutex_);
        if(!changed_.wait_for(lock,std::chrono::seconds(30),[&]{return stopping_||pending_;})){
          lock.unlock();hardware.reset();continue;
        }
        if(stopping_){if(pending_){pending_->done.set_exception(std::make_exception_ptr(Error(503,"flow_stopping")));pending_.reset();}break;}
        job=std::move(pending_);
      }
      Json result;std::exception_ptr error;
      try{
        Current current=[this,job]{return CurrentJob(*job);};Check(current);
        if(!hardware)hardware=factory_();Check(current);
        result=job->scene?hardware->Match(job->a,job->b,current):hardware->Run(job->a,job->b,current);Check(current);
      }catch(...){
        error=std::current_exception();hardware.reset();
        {std::lock_guard lock(mutex_);retry_=Clock::now()+std::chrono::seconds(2);}
      }
      {std::lock_guard lock(mutex_);busy_=false;}
      if(error)job->done.set_exception(error);else job->done.set_value(std::move(result));
    }
    // Destruction on worker preserves EGL affinity and model-before-budget order.
    hardware.reset();
  }
  std::function<std::string()>token_;std::function<bool()>allowed_;Factory factory_;
  std::chrono::milliseconds timeout_;mutable std::mutex mutex_;std::condition_variable changed_;
  bool stopping_=false,busy_=false;Clock::time_point retry_{};std::shared_ptr<Job>pending_;
  std::once_flag stop_;std::thread worker_;
};
}
