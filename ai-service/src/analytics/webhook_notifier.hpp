// AINVR. Explicit-destination, bounded webhook delivery for EventWorker.
#pragma once
#include "event_worker.hpp"
#include <curl/curl.h>
#include <algorithm>
namespace ai_service::analytics {
class WebhookNotifier {
 public:
  explicit WebhookNotifier(std::string endpoint,bool require_review=true)
      :endpoint_(std::move(endpoint)),require_review_(require_review) {
    static std::once_flag init;std::call_once(init,[]{
      if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK)throw std::runtime_error("HTTP initialization failed");
    });
    if(endpoint_.empty()||endpoint_.size()>2048||endpoint_.find_first_of("\r\n")!=std::string::npos)
      throw std::invalid_argument("Invalid notification endpoint");
    std::unique_ptr<CURLU,decltype(&curl_url_cleanup)> url(curl_url(),curl_url_cleanup);
    if(!url||curl_url_set(url.get(),CURLUPART_URL,endpoint_.c_str(),0)!=CURLUE_OK)
      throw std::invalid_argument("Invalid notification endpoint");
    auto part=[&](CURLUPart key){char* p=nullptr;std::string value;
      if(curl_url_get(url.get(),key,&p,0)==CURLUE_OK){value=p;curl_free(p);}return value;};
    if((part(CURLUPART_SCHEME)!="http"&&part(CURLUPART_SCHEME)!="https")||part(CURLUPART_HOST).empty()||
       !part(CURLUPART_USER).empty()||!part(CURLUPART_PASSWORD).empty()||!part(CURLUPART_FRAGMENT).empty())
      throw std::invalid_argument("Notification endpoint requires HTTP(S) without embedded credentials or fragment");
  }
  EventWorker::Outcome operator()(const nlohmann::json& event,const EventWorker::Context& context) const {
    if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"},{"attempts",0}}};
    if(require_review_&&event.value("review_status",std::string())!="approved")
      return {"failed",{{"code","review_not_approved"},{"attempts",0}}};
    const auto id=event.at("event_id").get<std::string>();
    if(id.empty()||id.size()>512||id.find_first_of("\r\n")!=std::string::npos)
      throw std::invalid_argument("Invalid notification event ID");
    nlohmann::json payload={{"schema_version",1},{"event_id",id}};
    for(const char* key:{"channel_id","stream_session_id","rule_id","type","track_id","timestamp","frame_pts_ns","direction"})
      if(event.contains(key))payload[key]=event.at(key);
    payload["review_status"]=event.value("review_status",std::string("not_requested"));
    if(event.contains("review_job")&&event.at("review_job").contains("result")) {
      const auto& result=event.at("review_job").at("result");
      for(const char* key:{"scope","temporal_rule_verified","image_id"})
        if(result.contains(key))payload["review"][key]=result.at(key);
    }
    const auto body=payload.dump();if(body.size()>65536)throw std::invalid_argument("Notification payload too large");
    for(int attempt=1;attempt<=3;++attempt) {
      if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"},{"attempts",attempt-1}}};
      const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(context.deadline-std::chrono::steady_clock::now()).count();
      std::unique_ptr<CURL,decltype(&curl_easy_cleanup)> client(curl_easy_init(),curl_easy_cleanup);
      if(!client)throw std::runtime_error("HTTP client unavailable");
      curl_slist* raw=nullptr;raw=curl_slist_append(raw,"Content-Type: application/json");
      raw=curl_slist_append(raw,("Idempotency-Key: "+id).c_str());
      std::unique_ptr<curl_slist,decltype(&curl_slist_free_all)> headers(raw,curl_slist_free_all);
      size_t response_bytes=0;
      curl_easy_setopt(client.get(),CURLOPT_URL,endpoint_.c_str());
      curl_easy_setopt(client.get(),CURLOPT_HTTPHEADER,headers.get());
      curl_easy_setopt(client.get(),CURLOPT_POSTFIELDS,body.data());
      curl_easy_setopt(client.get(),CURLOPT_POSTFIELDSIZE,long(body.size()));
      curl_easy_setopt(client.get(),CURLOPT_NOSIGNAL,1L);
      curl_easy_setopt(client.get(),CURLOPT_FOLLOWLOCATION,0L);
      curl_easy_setopt(client.get(),CURLOPT_PROTOCOLS,long(CURLPROTO_HTTP|CURLPROTO_HTTPS));
      curl_easy_setopt(client.get(),CURLOPT_TIMEOUT_MS,long(std::max<int64_t>(1,std::min<int64_t>(5000,remaining))));
      curl_easy_setopt(client.get(),CURLOPT_CONNECTTIMEOUT_MS,2000L);
      curl_easy_setopt(client.get(),CURLOPT_NOPROGRESS,0L);
      curl_easy_setopt(client.get(),CURLOPT_XFERINFOFUNCTION,+[](void* p,curl_off_t,curl_off_t,curl_off_t,curl_off_t)->int{
        return static_cast<const EventWorker::Context*>(p)->Cancelled()?1:0;});
      curl_easy_setopt(client.get(),CURLOPT_XFERINFODATA,&context);
      curl_easy_setopt(client.get(),CURLOPT_WRITEFUNCTION,+[](char*,size_t size,size_t count,void* p)->size_t{
        auto& bytes=*static_cast<size_t*>(p);if(count>8192||size>8192||size*count>8192-bytes)return 0;
        bytes+=size*count;return size*count;});
      curl_easy_setopt(client.get(),CURLOPT_WRITEDATA,&response_bytes);
      const auto result=curl_easy_perform(client.get());long status=0;
      curl_easy_getinfo(client.get(),CURLINFO_RESPONSE_CODE,&status);
      if(result==CURLE_OK&&status>=200&&status<300)
        return {"sent",{{"http_status",status},{"attempts",attempt},{"delivery_id",id}}};
      if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"},{"attempts",attempt}}};
      const bool retry=(result==CURLE_COULDNT_CONNECT||result==CURLE_COULDNT_RESOLVE_HOST||
        result==CURLE_OPERATION_TIMEDOUT||result==CURLE_RECV_ERROR||result==CURLE_SEND_ERROR)||
        (result==CURLE_OK&&(status==408||status==429||status>=500));
      if(!retry||attempt==3)return {"failed",{{"code","delivery_failed"},{"http_status",status},{"attempts",attempt}}};
      for(int n=0;n<attempt*10&&!context.Cancelled();++n)std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::logic_error("Unreachable notification state");
  }
 private:
  std::string endpoint_;bool require_review_;
};
}
