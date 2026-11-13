// Copyright AINVR. Internal BFF port; one admitted request, affine lazy hardware.
#pragma once
#include "face_embedding/extractor.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <mutex>
#include <thread>
#include <openssl/crypto.h>

namespace ainvr::face {
class Error:public std::runtime_error {
 public:
  Error(int http,std::string code):std::runtime_error(std::move(code)),status(http){}
  const int status;
};
struct Peer {std::string address,token;};
inline int64_t WallMs(){return std::chrono::duration_cast<std::chrono::milliseconds>(
  std::chrono::system_clock::now().time_since_epoch()).count();}
inline bool TokenMatches(const std::string& expected,const std::string& actual) {
  return expected.size()>=32&&expected.size()<=512&&expected.size()==actual.size()&&
    CRYPTO_memcmp(expected.data(),actual.data(),expected.size())==0;
}
inline bool LocalPeer(const Peer& peer,const std::string& token) {
  return (peer.address=="127.0.0.1"||peer.address=="::1"||peer.address=="::ffff:127.0.0.1")&&TokenMatches(token,peer.token);
}
inline void Keys(const Json& value,std::initializer_list<const char*> allowed) {
  if(!value.is_object())throw Error(422,"invalid_face_request");
  std::set<std::string> keys;for(auto key:allowed)keys.insert(key);
  for(auto i=value.begin();i!=value.end();++i)if(!keys.contains(i.key()))throw Error(422,"invalid_face_request");
}

class Runtime {
 public:
  // ApplyDemand is the central config/budget owner's integration point:
  // 1. merge AppendDemand(settings) with channel/search/other demand;
  // 2. reserve existing BPU budget before publishing this enabled generation;
  // 3. call ConfigureResidency ONCE with the combined map;
  // 4. return its lease (and retain it until all corresponding residency retires).
  // Disabled settings revoke only this owner's demand. Never ConfigureResidency
  // with a face-only map. The hook is serialized, called outside state mutex.
  using ApplyDemand=std::function<BudgetLease(const Settings&)>;
  using SpecReader=std::function<ModelSpec(const std::string&,bool)>;
  Runtime(std::string root,std::function<std::string()> token,std::function<bool()> authorized,
      ApplyDemand apply,ExtractorFactory factory,SpecReader reader={},std::function<int64_t()> clock=WallMs)
      :root_(std::move(root)),token_(std::move(token)),authorized_(std::move(authorized)),
       apply_(std::move(apply)),factory_(std::move(factory)),reader_(std::move(reader)),clock_(std::move(clock)) {
    if(!token_||!authorized_||!clock_)throw std::invalid_argument("face_runtime_dependencies");
    if(!reader_)reader_=[this](const std::string& id,bool embedding){return ReadSpec(root_,id,embedding);};
    worker_=std::thread([this]{Loop();});
  }
  ~Runtime() {Stop();}
  void Stop() {
    std::call_once(stop_once_,[this]{
    {std::lock_guard lock(mutex_);stopping_=true;
      if(pending_){pending_->done.set_exception(std::make_exception_ptr(Error(503,"face_stopping")));pending_.reset();}}
    changed_.notify_all();worker_.join();
    // main must destroy Runtime before the shared admission/config owner.
    try{if(apply_){Settings disabled;apply_(disabled);}}catch(...){}
    });
  }
  Runtime(const Runtime&)=delete;
  Settings Configured() const {std::lock_guard lock(mutex_);return settings_;}
  // Trusted in-process owner can revoke when the license itself has disappeared.
  // This never grants authority and is not exposed as an unauthenticated route.
  void Revoke(){
    std::lock_guard control(control_mutex_);Settings disabled;
    {std::lock_guard lock(mutex_);disabled.generation=settings_.generation+1;
      settings_=disabled;budget_={};loaded_generation_=0;expires_=0;}
    if(apply_)apply_(disabled);
    changed_.notify_all();
  }
  void RequireAccess(const Peer& peer) const {if(!Access(peer))throw Error(403,"face_not_authorized");}
  Json Call(const Json& input,const std::string& jpeg,const Peer& peer) {
    RequireAccess(peer);
    try{
      if(input.dump().size()>4096)throw Error(413,"face_metadata_large");
      const auto action=input.at("action").get<std::string>();
      if(action=="status"){
        Keys(input,{"action"});if(!jpeg.empty())throw Error(422,"invalid_face_request");return Status();
      }
      if(action=="configure"){
        if(!jpeg.empty())throw Error(422,"invalid_face_request");
        Configure(input,peer);return Status();
      }
      if(action!="extract")throw Error(422,"invalid_face_action");
      Keys(input,{"action","request_id","model_space_hash","detector_sha256","jpeg_sha256","expires_ms"});
      const auto now=clock_(),expires=input.at("expires_ms").get<int64_t>();
      const auto id=input.at("request_id").get<std::string>();
      if(id.empty()||id.size()>128||!std::all_of(id.begin(),id.end(),[](unsigned char c){return c>=33&&c<=126;}))
        throw Error(422,"invalid_face_request_id");
      if(expires<=now||expires>now+30000)throw Error(422,"invalid_face_deadline");
      if(jpeg.size()<4||jpeg.size()>8ULL*1024*1024)throw Error(413,"face_image_size");
      const auto jpeg_hash=input.at("jpeg_sha256").get<std::string>();
      if(!IsHash(jpeg_hash)||Sha256(jpeg)!=jpeg_hash)throw Error(422,"face_image_hash_mismatch");
      auto job=std::make_shared<Job>();job->meta=input;job->peer=peer;
      job->expires=expires;job->deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(expires-now);
      auto future=job->done.get_future();
      {
        std::lock_guard lock(mutex_);
        if(stopping_||!settings_.enabled||expires_<=now||!apply_||!factory_)throw Error(503,"face_not_configured");
        if(input.at("model_space_hash")!=settings_.space_hash||input.at("detector_sha256")!=settings_.detector.hbm_hash)
          throw Error(409,"face_model_space_changed");
        if(busy_)throw Error(429,"face_busy");
        if(std::chrono::steady_clock::now()<retry_after_)throw Error(503,"face_hardware_backoff");
        job->settings=settings_;job->budget=budget_;busy_=true;
      }
      // Reserve BEFORE retaining another copy of the JPEG. HTTP wire buffers
      // remain bounded by the existing server payload/thread limits.
      try{
        job->jpeg.assign(jpeg.begin(),jpeg.end());
        const auto [w,h]=ai_service::analytics::JpegDimensions(job->jpeg);
        if(w<16||h<16||w>4096||h>4096||uint64_t(w)*h>8ULL*1024*1024)throw Error(422,"unsupported_face_image");
        std::lock_guard lock(mutex_);
        if(stopping_)throw Error(503,"face_stopping");
        pending_=job;
      }catch(...){std::lock_guard lock(mutex_);busy_=false;throw;}
      changed_.notify_all();
      if(future.wait_until(job->deadline)!=std::future_status::ready){job->cancelled=true;throw Error(504,"face_timeout");}
      auto result=future.get();
      // Final publication fence includes token revocation and config generation.
      if(!CurrentJob(*job))throw Error(409,"face_request_stale");
      auto out=result.InternalJson();out["request_id"]=id;out["jpeg_sha256"]=jpeg_hash;
      out["detector_sha256"]=job->settings.detector.hbm_hash;return out;
    }catch(const Error&){throw;}
    catch(const Json::exception&){throw Error(422,"invalid_face_request");}
    catch(const std::invalid_argument&){throw Error(422,"invalid_face_image_or_contract");}
    catch(...){throw Error(503,"face_extraction_unavailable");}
  }
 private:
  struct Job {
    Json meta;std::vector<uint8_t> jpeg;Peer peer;Settings settings;BudgetLease budget;
    int64_t expires=0;std::chrono::steady_clock::time_point deadline;
    std::promise<Result> done;std::atomic<bool> cancelled{false};
  };
  bool Access(const Peer& peer) const {try{return LocalPeer(peer,token_())&&authorized_();}catch(...){return false;}}
  bool CurrentJob(const Job& job) const {
    if(job.cancelled||std::chrono::steady_clock::now()>=job.deadline||clock_()>=job.expires||!Access(job.peer))return false;
    {std::lock_guard lock(mutex_);if(stopping_||!settings_.enabled||settings_.generation!=job.settings.generation||expires_<=clock_())return false;}
    try{return job.budget.Valid();}catch(...){return false;}
  }
  Json Status() const {
    Settings settings;BudgetLease budget;int64_t expires;uint64_t loaded;bool busy,backoff;std::string error;
    {std::lock_guard lock(mutex_);settings=settings_;budget=budget_;expires=expires_;loaded=loaded_generation_;busy=busy_;error=error_;
      backoff=std::chrono::steady_clock::now()<retry_after_;}
    const bool configured=settings.enabled&&expires>clock_();
    bool admitted=false;try{admitted=budget.Valid();}catch(...){}
    const bool can_extract=configured&&admitted&&bool(apply_)&&bool(factory_)&&!backoff;
    const bool ready=can_extract&&loaded==settings.generation;
    const std::string reason=!configured?"not_configured":!apply_||!factory_?"native_not_connected":
      !admitted?"budget_unavailable":backoff?"hardware_backoff":!ready?"lazy_not_loaded":"";
    return {{"schema","ainvr.face-runtime.v1"},{"implemented",true},{"configured",configured},
      {"loaded",configured&&loaded==settings.generation},{"ready",ready},{"can_extract",can_extract},{"busy",busy},
      {"generation",settings.generation},{"model_space_hash",configured?Json(settings.space_hash):Json(nullptr)},
      {"embedding_model",configured?Json(settings.embedding.id):Json(nullptr)},
      {"detector_model",configured?Json(settings.detector.id):Json(nullptr)},
      {"detector_sha256",configured?Json(settings.detector.hbm_hash):Json(nullptr)},
      {"reason",reason.empty()?Json(nullptr):Json(reason)},
      {"expires_ms",expires},{"last_error",error},{"accuracy_verified",false}};
  }
  void Configure(const Json& input,const Peer& peer) {
    Keys(input,{"action","enabled","detector_model","embedding_model","model_space_hash","detector_sha256","issued_ms","expires_ms"});
    const auto now=clock_(),issued=input.at("issued_ms").get<int64_t>(),expires=input.at("expires_ms").get<int64_t>();
    if(issued<now-60000||issued>now+5000||expires<=now||expires>now+60000)throw Error(422,"invalid_face_grant");
    Settings next;next.enabled=input.at("enabled").get<bool>();
    if(next.enabled){
      next.detector=reader_(input.at("detector_model").get<std::string>(),false);
      next.embedding=reader_(input.at("embedding_model").get<std::string>(),true);next.space_hash=SpaceHash(next.embedding);
      if(input.at("model_space_hash")!=next.space_hash||input.at("detector_sha256")!=next.detector.hbm_hash)
        throw Error(409,"face_model_space_changed");
    }
    std::lock_guard control(control_mutex_);
    {std::lock_guard lock(mutex_);
      if(stopping_)throw Error(503,"face_stopping");
      if(issued<issued_)throw Error(409,"stale_face_grant");
      const bool same=next.enabled==settings_.enabled&&(!next.enabled||
        (next.space_hash==settings_.space_hash&&next.detector.hbm_hash==settings_.detector.hbm_hash&&
         next.detector.path==settings_.detector.path&&next.embedding.path==settings_.embedding.path));
      if(issued==issued_&&!same)throw Error(409,"conflicting_face_grant");
      if(same&&expires_>now&&(!next.enabled||budget_.Valid())){issued_=issued;expires_=expires;return;}
      next.generation=settings_.generation+1;
    }
    if(!Access(peer))throw Error(403,"face_not_authorized");
    if(!apply_)throw Error(503,"face_budget_not_connected");
    auto lease=apply_(next);
    if(next.enabled&&!lease.Valid())throw Error(503,"face_budget_unavailable");
    {std::lock_guard lock(mutex_);settings_=next;budget_=std::move(lease);issued_=issued;expires_=expires;
      loaded_generation_=0;retry_after_={};error_.clear();}
    changed_.notify_all();
  }
  void Expire() {
    std::lock_guard control(control_mutex_);Settings disabled;
    {std::lock_guard lock(mutex_);if(!settings_.enabled||expires_>clock_())return;
      disabled.generation=settings_.generation+1;settings_=disabled;budget_={};loaded_generation_=0;}
    // Revocation is effective before attempting a fallible residency reconcile.
    if(apply_)try{apply_(disabled);}catch(...){std::lock_guard lock(mutex_);error_="face_demand_reconcile_failed";}
  }
  void Loop() {
    std::unique_ptr<Extractor> hardware;uint64_t hardware_generation=0;
    for(;;){
      std::shared_ptr<Job> job;Settings active;
      {std::unique_lock lock(mutex_);changed_.wait_for(lock,std::chrono::milliseconds(100),[&]{return stopping_||pending_;});
        if(stopping_)break;
        job=std::move(pending_);active=settings_;}
      Expire();active=Configured();
      if(!active.enabled||hardware_generation!=active.generation){hardware.reset();hardware_generation=0;}
      if(!job)continue;
      try{
        Current current=[this,job]{return CurrentJob(*job);};
        if(!current())throw Error(409,"face_request_stale");
        if(!hardware){
          hardware=factory_(job->settings,job->budget,current);
          if(!hardware)throw Error(503,"face_hardware_unavailable");
          hardware_generation=job->settings.generation;
          std::lock_guard lock(mutex_);loaded_generation_=hardware_generation;
        }
        auto result=hardware->Extract(job->jpeg,current);
        if(!current())throw Error(409,"face_request_stale");
        if(result.space_hash!=job->settings.space_hash)throw Error(503,"face_output_space_mismatch");
        if(result.status=="extracted"){
          if(!result.quality.accepted)throw Error(503,"face_output_quality_mismatch");
          result.embedding=Normalize(std::vector<float>(result.embedding.begin(),result.embedding.end()));
        }
        {std::lock_guard lock(mutex_);busy_=false;error_.clear();}
        job->done.set_value(std::move(result));
      }catch(const Error&){
        {std::lock_guard lock(mutex_);busy_=false;}
        job->done.set_exception(std::current_exception());
      }
      catch(...){
        hardware.reset();hardware_generation=0;
        {std::lock_guard lock(mutex_);loaded_generation_=0;error_="face_hardware_unavailable";
          retry_after_=std::chrono::steady_clock::now()+std::chrono::seconds(5);}
        {std::lock_guard lock(mutex_);busy_=false;}
        job->done.set_exception(std::make_exception_ptr(Error(503,"face_hardware_unavailable")));
      }
    }
    hardware.reset();
  }
  std::string root_;std::function<std::string()> token_;std::function<bool()> authorized_;
  ApplyDemand apply_;ExtractorFactory factory_;SpecReader reader_;std::function<int64_t()> clock_;
  mutable std::mutex mutex_;std::mutex control_mutex_;std::condition_variable changed_;
  Settings settings_;BudgetLease budget_;int64_t issued_=0,expires_=0;
  bool stopping_=false,busy_=false;uint64_t loaded_generation_=0;std::string error_;
  std::chrono::steady_clock::time_point retry_after_{};std::shared_ptr<Job> pending_;std::thread worker_;std::once_flag stop_once_;
};
} // namespace ainvr::face
