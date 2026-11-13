// Copyright AINVR. Existing control server/config overlay + shared ION ledger.
#pragma once
#include "hardware_integration.hpp"
#include "routes.hpp"

namespace ainvr::face {
struct Selection {
  bool enabled=false;
  std::string detector="face-det-scrfd-500m",embedding="face-embed-mbf";
  uint64_t revision=0;
  Json ToJson() const{return {{"enabled",enabled},{"detector_model",detector},{"embedding_model",embedding},{"revision",revision}};}
};
inline Selection ParseSelection(const Json& input){
  if(input.is_null())return {};
  Keys(input,{"enabled","detector_model","embedding_model","revision"});
  Selection s;s.enabled=input.at("enabled").get<bool>();s.detector=input.at("detector_model").get<std::string>();
  s.embedding=input.at("embedding_model").get<std::string>();s.revision=input.at("revision").get<uint64_t>();
  if(s.revision>9007199254740991ULL||
      (s.detector!="face-det-scrfd-500m"&&s.detector!="face-det-scrfd-2g5")||
      (s.embedding!="face-embed-mbf"&&s.embedding!="face-embed-r50"))throw Error(422,"invalid_face_configuration");
  return s;
}
class Integration {
 public:
  using Read=std::function<Json()>;
  using Save=std::function<void(const Json&)>;
  Integration(std::string root,std::function<std::string()> token,std::function<bool()> authorized,
      std::shared_ptr<Residency> residency,Read read,Save save)
      :root_(std::move(root)),token_(std::move(token)),authorized_(std::move(authorized)),
       residency_(std::move(residency)),read_(std::move(read)),save_(std::move(save)) {
    runtime_=std::make_shared<Runtime>(root_,token_,authorized_,
      [residency=residency_](const Settings& s){return residency->Apply(s);},NativeFactory());
  }
  std::shared_ptr<Runtime> RuntimePort() const{return runtime_;}
  ~Integration(){Stop();}
  void Start(){
    std::lock_guard lock(maintenance_mutex_);
    if(maintenance_.joinable()||maintenance_stopped_)return;
    maintenance_=std::thread([this]{
      for(;;){
        {std::unique_lock lock(maintenance_mutex_);if(maintenance_stopped_)return;}
        try{Refresh();}catch(...){}
        std::unique_lock lock(maintenance_mutex_);
        if(maintenance_changed_.wait_for(lock,std::chrono::seconds(1),[&]{return maintenance_stopped_;}))return;
      }
    });
  }
  void Register(httplib::Server& server){
    RegisterExtractorRoutes(server,runtime_,[this](const Json& j,const Peer& p){return Configure(j,p);},
      [this](const Peer& p){return Status(p);});
  }
  // Maintenance is outside the channel control loop: the existing admission
  // lock has bounded waits which must not stall channel/search scheduling.
  void Refresh(){
    std::lock_guard lock(mutex_);if(stopped_)return;
    RefreshLocked();residency_->Reap();
  }
  void Stop(){
    std::call_once(stop_once_,[this]{
      {std::lock_guard lock(maintenance_mutex_);maintenance_stopped_=true;}
      maintenance_changed_.notify_all();if(maintenance_.joinable())maintenance_.join();
      std::lock_guard lock(mutex_);stopped_=true;runtime_->Stop();residency_->Reap();
    });
  }
  Json Status(const Peer& peer){
    auto out=runtime_->Call({{"action","status"}},"",peer);
    std::lock_guard lock(mutex_);out["configuration_revision"]=desired_.revision;
    out["configuration"]=desired_.ToJson();
    out["apply_pending"]=pending_;out["persisted"]=persisted_;
    if(pending_){out["can_extract"]=false;out["ready"]=false;out["reason"]=error_.empty()?"configuration_pending":error_;}
    return out;
  }
  Json Configure(const Json& input,const Peer& peer){
    runtime_->RequireAccess(peer);
    Keys(input,{"enabled","detector_model","embedding_model","expected_revision"});
    {
      std::lock_guard lock(mutex_);
      const auto before=ParseSelection(read_());const auto expected=input.at("expected_revision").get<uint64_t>();
      if(expected!=before.revision)throw Error(409,"face_configuration_changed");
      auto next=ParseSelection(Json{{"enabled",input.at("enabled")},{"detector_model",input.at("detector_model")},
        {"embedding_model",input.at("embedding_model")},{"revision",before.revision+1}});
      // Validate local contracts before persisting any selection. Never accept paths or client pins.
      if(next.enabled){(void)ReadSpec(root_,next.detector,false);(void)ReadSpec(root_,next.embedding,true);}
      runtime_->RequireAccess(peer);save_(next.ToJson());persisted_=true;next_attempt_=0;RefreshLocked();
    }
    return Status(peer);
  }
 private:
  void DisableLocked(){
    if(runtime_->Configured().enabled)runtime_->Revoke();
  }
  int64_t NextIssued(int64_t now){issued_=std::max(now,issued_+1);return issued_;}
  void RefreshLocked(){
    const auto now=WallMs();
    try{
      const auto raw=read_();auto desired=ParseSelection(raw);persisted_=!raw.is_null();
      const bool changed=desired.ToJson()!=desired_.ToJson();
      desired_=desired;
      if(changed){pending_=true;next_attempt_=0;DisableLocked();}
      if(!authorized_()){
        DisableLocked();pending_=true;error_="not_authorized";return;
      }
      if(now<next_attempt_)return;
      if(!desired.enabled){DisableLocked();pending_=false;error_.clear();next_attempt_=now+20000;return;}
      auto detector=ReadSpec(root_,desired.detector,false),embedding=ReadSpec(root_,desired.embedding,true);
      const auto space=SpaceHash(embedding);const auto current=runtime_->Configured();
      if(current.enabled&&(current.space_hash!=space||current.detector.hbm_hash!=detector.hbm_hash))DisableLocked();
      runtime_->Call({{"action","configure"},{"enabled",true},{"detector_model",desired.detector},
        {"embedding_model",desired.embedding},{"model_space_hash",space},{"detector_sha256",detector.hbm_hash},
        {"issued_ms",NextIssued(now)},{"expires_ms",now+60000}},"",Peer{"127.0.0.1",token_()});
      pending_=false;error_.clear();next_attempt_=now+20000;
    }catch(...){
      // Invalid/replaced configuration must fence the old extractor immediately.
      try{DisableLocked();}catch(...){}
      pending_=true;error_="face_configuration_unavailable";next_attempt_=now+5000;
    }
  }
  std::string root_;std::function<std::string()> token_;std::function<bool()> authorized_;
  std::shared_ptr<Residency> residency_;Read read_;Save save_;std::shared_ptr<Runtime> runtime_;
  std::mutex mutex_;Selection desired_;bool pending_=true,persisted_=false,stopped_=false;
  std::string error_;int64_t issued_=0,next_attempt_=0;
  std::mutex maintenance_mutex_;std::condition_variable maintenance_changed_;std::thread maintenance_;
  bool maintenance_stopped_=false;std::once_flag stop_once_;
};
} // namespace ainvr::face
