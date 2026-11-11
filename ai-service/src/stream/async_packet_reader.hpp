// Copyright AINVR. One-slot read-ahead; the consumer owns hardware decoding.
#pragma once
#include <chrono>
#include <condition_variable>
#include <exception>
#include <functional>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace ai_service::stream {
template<class Packet> class AsyncPacketReader {
 public:
  struct Result { bool pending; std::optional<Packet> packet; };
  AsyncPacketReader(std::function<std::optional<Packet>()> read,
                    std::function<void()> cancel)
      : read_(std::move(read)), cancel_(std::move(cancel)), worker_([this]{Run();}) {}
  AsyncPacketReader(const AsyncPacketReader&)=delete;
  AsyncPacketReader& operator=(const AsyncPacketReader&)=delete;
  ~AsyncPacketReader() {
    { std::lock_guard lock(mutex_); stopped_=true; }
    // Cancel only the network reader; VPU stays on its original owning thread.
    cancel_(); changed_.notify_all(); worker_.join();
  }
  Result Poll(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    if(!changed_.wait_for(lock,timeout,[this]{return packet_ || done_ || error_;}))
      return {true,std::nullopt};
    if(error_)std::rethrow_exception(error_);
    auto packet=std::move(packet_);packet_.reset();
    lock.unlock();changed_.notify_all();
    return {false,std::move(packet)};
  }
 private:
  void Run() noexcept {
    try {
      for(;;) {
        // Do not read ahead of an occupied slot: at most one compressed AU,
        // either in Read() or in packet_, rather than an accumulating queue.
        {std::unique_lock lock(mutex_);
         changed_.wait(lock,[this]{return stopped_ || !packet_;});
         if(stopped_)return;}
        auto next=read_();
        {std::lock_guard lock(mutex_);
         if(stopped_)return;
         if(next)packet_=std::move(next);else done_=true;}
        changed_.notify_all();
        if(done_)return;
      }
    } catch(...) {
      {std::lock_guard lock(mutex_);error_=std::current_exception();}
      changed_.notify_all();
    }
  }
  std::function<std::optional<Packet>()> read_;
  std::function<void()> cancel_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::optional<Packet> packet_;
  bool stopped_=false,done_=false;
  std::exception_ptr error_;
  std::thread worker_;
};
} // namespace ai_service::stream
