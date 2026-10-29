#include "migration_artifacts.hpp"
#include "model_package.hpp"
#include "../../shared/cpp/config_center_client.hpp"
#include <openssl/evp.h>
#include <mutex>
namespace ainvr::search {
namespace {
using Json=nlohmann::json;
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
bool SameProof(const MigrationWriteProof&a,const MigrationWriteProof&b){return a.job_id==b.job_id&&a.worker==b.worker&&
  a.actor==b.actor&&a.payload_fingerprint==b.payload_fingerprint&&a.generation==b.generation;}
MigrationCoverageDefinition Definition(const MigrationWriteProof&p,const MigrationWriteGrant&g){
  return {p.payload_fingerprint,g.source,g.target,g.scope,g.source_high_watermark,g.target_checkpoint,g.job_expires_ms};
}
class Digest {
 public:
  Digest():ctx_(EVP_MD_CTX_new()){if(!ctx_||EVP_DigestInit_ex(ctx_,EVP_sha256(),nullptr)!=1)throw std::runtime_error("migration_digest_unavailable");}
  ~Digest(){EVP_MD_CTX_free(ctx_);}
  void Add(const std::string&s){if(EVP_DigestUpdate(ctx_,s.data(),s.size())!=1)throw std::runtime_error("migration_digest_unavailable");}
  std::string Finish(){unsigned char bytes[32];unsigned n=0;if(EVP_DigestFinal_ex(ctx_,bytes,&n)!=1||n!=32)throw std::runtime_error("migration_digest_unavailable");
    static const char hex[]="0123456789abcdef";std::string out;for(auto b:bytes){out+=hex[b>>4];out+=hex[b&15];}return out;}
 private:EVP_MD_CTX*ctx_;
};
}
struct MigrationArtifactsRuntime::Impl {
  struct Work {
    MigrationWriteProof proof;MigrationWriteGrant grant;MigrationCoverageDefinition definition;
    Json status{{"state","building_report"},{"checkpoint","0"},{"source_completed_through",nullptr},
      {"target_checkpoint","0"},{"coverage_snapshot",{{"required",0},{"matched",0},{"unavailable",0}}},
      {"coverage_sha256",nullptr},{"index_manifest_sha256",nullptr},{"reason",nullptr}};
    bool begun=false;std::atomic<bool> complete{false},retired{false};std::atomic<int64_t> lease_until{0};
    std::unique_ptr<IndexJobClient> jobs;std::unique_ptr<IndexBuildWorker> builder;
    std::optional<IndexBuildOutcome> unknown;
    std::optional<std::string> after;Json page;size_t position=0;
    std::unique_ptr<Digest> digest;size_t artifacts=0;std::optional<IndexRefreshAccepted> refreshing;
  };
  HistoryMongo&history;IndexShardFiles&files;IndexJobContext base;
  std::shared_ptr<std::atomic<bool>> admitted;ainvr::config::ConfigTransport transport;
  std::mutex mutex;std::shared_ptr<Work> active;std::atomic<bool> stopping{false};
  Impl(const Json&bootstrap,HistoryMongo&h,IndexShardFiles&f,IndexJobContext c,std::shared_ptr<std::atomic<bool>> a)
    :history(h),files(f),base(std::move(c)),admitted(std::move(a)),transport(bootstrap){if(!admitted)throw std::invalid_argument("invalid_migration_runtime");}
  bool Cancelled(const std::shared_ptr<Work>&w)const{return stopping.load()||!admitted->load()||w->retired.load()||Now()>=w->lease_until.load();}
  void Update(const std::shared_ptr<Work>&w,const Json&state){std::lock_guard<std::mutex>lock(mutex);if(active==w)w->status=state;}
  void Reason(const std::shared_ptr<Work>&w,const char*reason){std::lock_guard<std::mutex>lock(mutex);if(active==w)w->status["reason"]=reason;}
  void Terminal(const std::shared_ptr<Work>&w,const char*reason){
    Json state;{std::lock_guard<std::mutex>lock(mutex);state=w->status;}
    state["state"]="unavailable";state["reason"]=reason;w->complete.store(true);Update(w,state);
  }
  Json Activate(const MigrationWriteProof&p,const MigrationWriteGrant&g){
    MigrationAuthorizationRequest(p);if(g.lease_until_ms<=Now()||g.job_expires_ms<g.lease_until_ms)throw std::runtime_error("migration_authorization_required");
    for(const auto&channel:g.scope.channels)if(std::find(base.channels.begin(),base.channels.end(),channel)==base.channels.end())throw std::runtime_error("migration_source_not_authorized");
    const auto&spec=FindPackageSpec(g.target.package_id);if(spec.pruned)throw std::invalid_argument("migration_target_unsupported");
    std::lock_guard<std::mutex>lock(mutex);
    if(active&&SameProof(active->proof,p)){
      if(!SameMigrationWriteAuthority(active->grant,g)||active->grant.job_expires_ms!=g.job_expires_ms)throw std::runtime_error("migration_authorization_changed");
      return active->status;
    }
    const bool reclaimed=active&&active->proof.job_id==p.job_id&&active->proof.actor==p.actor&&
      active->proof.payload_fingerprint==p.payload_fingerprint&&p.generation>active->proof.generation&&
      SameMigrationWriteAuthority(active->grant,g);
    // A fresh PG-authorized claim supersedes its old generation immediately;
    // an unrelated still-live lease cannot create a second background queue.
    if(active&&!active->complete&&Now()<active->lease_until.load()&&!reclaimed)throw std::runtime_error("migration_artifacts_busy");
    if(active)active->retired.store(true);
    auto w=std::make_shared<Work>();w->proof=p;w->grant=g;w->definition=Definition(p,g);w->lease_until.store(g.lease_until_ms);active=w;return w->status;
  }
  bool WantsFastSteps(){
    std::lock_guard<std::mutex>lock(mutex);
    return active&&!active->complete.load()&&!active->retired.load()&&!stopping.load()&&admitted->load()&&
      active->status.at("reason").is_null();
  }
  size_t Pump(){
    {std::lock_guard<std::mutex>lock(mutex);if(!active||active->complete.load()||stopping.load()||!admitted->load())return 0;}
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(20);size_t steps=0;
    do{Step();++steps;}while(steps<8&&std::chrono::steady_clock::now()<deadline&&WantsFastSteps());
    return steps;
  }
  void Step(){
    std::shared_ptr<Work>w;{std::lock_guard<std::mutex>lock(mutex);w=active;}
    if(!w||w->complete||stopping.load()||!admitted->load())return;
    try{
      auto query=MigrationAuthorizationRequest(w->proof);query["action"]="authorize_artifacts";
      const auto grant=ReadMigrationWriteGrant(transport.RequestAt("/api/internal/search/model-migrations",&query),w->proof,Now());
      if(!grant||!SameMigrationWriteAuthority(w->grant,*grant)||grant->job_expires_ms!=w->grant.job_expires_ms){Reason(w,"migration_authorization_revoked");return;}
      // Only this serial worker mutates the live grant. HTTP reads status under
      // mutex and never treats a stored report as renewed write permission.
      w->lease_until.store(grant->lease_until_ms);
      if(Cancelled(w))return;
      if(!w->begun){const auto s=history.BeginMigrationCoverage(w->proof.job_id,w->proof.generation,w->proof.actor,w->definition);
        w->begun=true;auto state=w->status;for(const auto*k:{"checkpoint","target_checkpoint","coverage_snapshot","coverage_sha256"})state[k]=s.at(k);
        state["state"]=s.at("state")=="complete"?"building_index":"building_report";Update(w,state);return;}
      Json state;{std::lock_guard<std::mutex>lock(mutex);state=w->status;}
      if(state.at("state")=="building_report"){
        const auto s=history.AdvanceMigrationCoverage(w->proof.job_id,w->proof.generation,w->proof.actor,w->definition,
          migration_authorization::Ordinal(state.at("checkpoint")));
        for(const auto*k:{"checkpoint","target_checkpoint","coverage_snapshot","coverage_sha256"})state[k]=s.at(k);
        if(s.at("state")=="complete"){state["state"]="building_index";state["source_completed_through"]=std::to_string(w->definition.source_high_watermark);}
        state["reason"]=nullptr;Update(w,state);return;
      }
      if(!w->jobs){auto context=base;context.package_id=w->grant.target.package_id;context.model_version=w->grant.target.model_version;
        context.channels.assign(w->grant.scope.channels.begin(),w->grant.scope.channels.end());context.migration_lease=w->proof;context.migration_scope=w->grant.scope;
        w->jobs=std::make_unique<IndexJobClient>(transport,context);
#ifdef AINVR_INDEX_BUILDER_TESTING
        w->builder=std::make_unique<IndexBuildWorker>([this](const auto&m,const auto&s,int64_t a,size_t n){return history.Scan(m,s,a,n);},files,*w->jobs,context,FindPackageSpec(context.package_id).dimensions);
#else
        w->builder=std::make_unique<IndexBuildWorker>(history,files,*w->jobs,context,FindPackageSpec(context.package_id).dimensions);
#endif
        w->digest=std::make_unique<Digest>();w->digest->Add("[\"ainvr-search-migration-index-v1\","+Json(w->proof.payload_fingerprint).dump()+","+state.at("target_checkpoint").dump()+",[");
      }
      const auto retired=w->jobs->RetiredCatalog(std::nullopt,1);
      if(retired&&!retired->shards.empty()){
        const auto&ref=retired->shards.front();files.DeleteRetired(ref.shard,ref.manifest_key);
        if(!w->jobs->ConfirmCleanup(ref))throw std::runtime_error("migration_cleanup_pending");
      }
      if(w->unknown){const auto out=w->builder->Reconcile(*w->unknown,[&]{return Cancelled(w);});
        if(out.state==IndexBuildOutcome::State::NeedsReconcile){Reason(w,"migration_publication_unconfirmed");return;}w->unknown.reset();}
      if(w->page.is_null())w->page=history.ReadMigrationCoverage(w->proof.job_id,w->proof.generation,w->proof.actor,w->definition,w->after);
      const auto&parts=w->page.at("partitions");
      if(w->position<parts.size()){
        const auto&part=parts.at(w->position);const auto channel=part.at("channel_id").get<std::string>(),day=part.at("day").get<std::string>();
        w->refreshing=w->jobs->Refresh(channel,day,migration_authorization::Ordinal(part.at("checkpoint")));
        if(!w->refreshing)throw std::runtime_error("migration_index_unavailable");
        if(w->refreshing->state=="failed"||w->refreshing->state=="cancelled"){
          Terminal(w,"migration_index_failed");return;
        }
        if(w->refreshing->state!="succeeded"){
          const auto out=w->builder->RunOne(w->proof.worker,"index",[&]{return Cancelled(w);});
          if(out.state==IndexBuildOutcome::State::NeedsReconcile)w->unknown=out;
          if(out.state==IndexBuildOutcome::State::Capacity){Terminal(w,"migration_index_capacity");return;}
          if(out.state==IndexBuildOutcome::State::Invalid){Terminal(w,"migration_index_invalid");return;}
          Reason(w,"migration_index_pending");return;
        }
        auto pub=w->jobs->Published(w->refreshing->shard_id);if(!pub)throw std::runtime_error("migration_index_pending");
        if(pub->publication.checkpoint<migration_authorization::Ordinal(part.at("checkpoint"))||
            pub->publication.record_count<part.at("records").get<size_t>())throw std::runtime_error("migration_index_pending");
        pub->shard.dimensions=FindPackageSpec(w->grant.target.package_id).dimensions;
        (void)files.Load(pub->shard,pub->publication); // Actual bounded SHA/count/vector validation; never Warm old space.
        const auto artifact=Json::array({pub->shard.id,channel,w->grant.target.model_version,day,std::to_string(pub->shard.revision),
          base.storage_generation,pub->publication.manifest_sha256,std::to_string(pub->publication.checkpoint),
          pub->publication.record_count,std::to_string(pub->publication.byte_count)});
        if(w->artifacts++)w->digest->Add(",");
        w->digest->Add(artifact.dump());++w->position;
      }
      if(w->position==parts.size()){
        if(!w->page.at("next_cursor").is_null()){w->after=w->page.at("next_cursor").get<std::string>();w->page=nullptr;w->position=0;}
        else{w->digest->Add("]]");state["index_manifest_sha256"]=w->digest->Finish();state["state"]="ready";
          state["source_completed_through"]=std::to_string(w->definition.source_high_watermark);w->complete.store(true);}
      }
      state["reason"]=nullptr;Update(w,state);
    }catch(const std::exception&error){
      if(std::string(error.what())=="migration_report_capacity")Terminal(w,"migration_report_capacity");
      else Reason(w,"migration_artifacts_pending");
    }
  }
};
MigrationArtifactsRuntime::MigrationArtifactsRuntime(const Json&b,HistoryMongo&h,IndexShardFiles&f,IndexJobContext c,std::shared_ptr<std::atomic<bool>>a)
 :impl_(std::make_unique<Impl>(b,h,f,std::move(c),std::move(a))){}
MigrationArtifactsRuntime::~MigrationArtifactsRuntime()=default;
Json MigrationArtifactsRuntime::Activate(const MigrationWriteProof&p,const MigrationWriteGrant&g){return impl_->Activate(p,g);}
void MigrationArtifactsRuntime::Step(){impl_->Step();}
size_t MigrationArtifactsRuntime::Pump(){return impl_->Pump();}
bool MigrationArtifactsRuntime::WantsFastSteps()const{return impl_->WantsFastSteps();}
void MigrationArtifactsRuntime::Stop(){impl_->stopping.store(true);std::lock_guard<std::mutex>lock(impl_->mutex);if(impl_->active)impl_->active->retired.store(true);}
}  // namespace ainvr::search
