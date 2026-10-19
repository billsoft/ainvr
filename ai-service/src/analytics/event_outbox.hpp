// Durable event delivery. Submit acknowledges SSD persistence, not Mongo delivery.
#pragma once
#include "../output/archive_spool.hpp"
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <bson/bson.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
namespace ai_service::analytics {
class EventOutbox {
 public:
  using Writer=std::function<void(const nlohmann::json&)>;
  EventOutbox(const std::string& directory,Writer writer,size_t bytes=16*1024*1024,size_t records=10000)
    :spool_(directory,bytes,records),writer_(std::move(writer)) {
    if(!writer_)throw std::invalid_argument("Event writer required");
    thread_=std::thread([this]{Run();});
  }
  ~EventOutbox() {stop_=true;wake_.notify_all();if(thread_.joinable())thread_.join();}
  EventOutbox(const EventOutbox&)=delete;
  EventOutbox& operator=(const EventOutbox&)=delete;
  void Submit(const nlohmann::json& event) {
    const auto identity=event.at("event_id").get<std::string>();
    if(identity.empty()||identity.size()>512)throw std::invalid_argument("Invalid event ID");
    const auto payload=event.dump();
    if(payload.size()>65536)throw std::invalid_argument("Event payload too large");
    unsigned char digest[SHA256_DIGEST_LENGTH];SHA256(
      reinterpret_cast<const unsigned char*>(identity.data()),identity.size(),digest);
    // Existing spool envelope uses an OID filename. Public event identity remains
    // the full event_id; identical pending OIDs with different payloads are rejected.
    bson_oid_t oid;std::copy(digest,digest+12,oid.bytes);
    char id[25];bson_oid_to_string(&oid,id);
    bson_t doc;bson_init(&doc);
    BSON_APPEND_OID(&doc,"_id",&oid);
    BSON_APPEND_UTF8(&doc,"image_id",id); // internal legacy spool envelope field only
    BSON_APPEND_UTF8(&doc,"analytics_event",payload.c_str());
    auto data=bson_get_data(&doc);
    std::vector<uint8_t> bytes(data,data+doc.len);
    bson_destroy(&doc);
    spool_.Stage(id,bytes);
    wake_.notify_all();
  }
  size_t Pending(){return spool_.Pending().size();}
  uint64_t Failures()const{return failures_.load();}
  uint64_t Delivered()const{return delivered_.load();}
 private:
  void Run() {
    while(!stop_) {
      try {
        for(const auto& id:spool_.Pending()) {
          if(stop_)break;
          try {
          spool_.Deliver(id,[this](const auto& bytes){
            bson_t doc;bson_iter_t it;
            if(!bson_init_static(&doc,bytes.data(),bytes.size())||
               !bson_iter_init_find(&it,&doc,"analytics_event")||!BSON_ITER_HOLDS_UTF8(&it))
              throw std::runtime_error("Invalid event envelope");
            writer_(nlohmann::json::parse(bson_iter_utf8(&it,nullptr)));
          });
          ++delivered_;
          } catch (...) {
            // Keep this record durable, but do not starve unrelated events.
            ++failures_;
          }
        }
      }catch(...){++failures_;}
      std::unique_lock lock(mutex_);
      wake_.wait_for(lock,std::chrono::milliseconds(500));
    }
  }
  ainvr::ArchiveSpool spool_;
  Writer writer_;
  std::atomic<bool> stop_{false};
  std::atomic<uint64_t> failures_{0},delivered_{0};
  std::mutex mutex_;
  std::condition_variable wake_;
  std::thread thread_;
};
}
