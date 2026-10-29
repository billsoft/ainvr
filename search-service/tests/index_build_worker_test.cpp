#include "index_build_worker.hpp"
#include <filesystem>
#include <iostream>
#include <sys/stat.h>
#include <unistd.h>
using namespace ainvr::search;
namespace fs=std::filesystem;
namespace {
using State=IndexBuildOutcome::State;
const std::string worker="33333333-3333-4333-8333-333333333333";
const std::string channel="22222222-2222-4222-8222-222222222222";
void Check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
struct Temp {
  fs::path root;
  Temp(){char path[]="/tmp/ainvr-index-builder-XXXXXX";auto* made=mkdtemp(path);if(!made)throw std::runtime_error("tmp_failed");root=made;}
  ~Temp(){std::error_code e;fs::remove_all(root,e);}
};
struct Jobs:IndexJobPort {
  std::optional<IndexJob> job;
  IndexBuildLease lease;
  std::optional<PublishedIndexShard> published;
  bool renew=true,write=true,timeout=false,read_failure=false;
  bool discard=false,discard_timeout=false,confirm_timeout=false,wrong_retired=false,retired_read_failure=false;
  std::optional<IndexRetiredRef> retired;
  int claims=0,renewals=0,publishes=0,failures=0,discards=0,confirmations=0;
  IndexJobEnqueued Enqueue(const std::string&,const std::string&,const std::string&,const std::string&,const std::string&)override{throw std::runtime_error("unexpected_enqueue");}
  std::optional<IndexJob> Claim(const std::string&,const std::string&)override{++claims;return job;}
  bool Renew(const IndexJob&)override{++renewals;return renew;}
  IndexBuildLease Begin(const IndexJob&)override{return lease;}
  bool Publish(const IndexBuildLease& b,const ShardPublication& p)override{
    ++publishes;if(write)published=PublishedIndexShard{b.shard,p,false};
    if(timeout)throw std::runtime_error("transport_timeout");
    return write;
  }
  bool Fail(const IndexJob&,const std::string&)override{++failures;return true;}
  std::optional<PublishedIndexShard> Published(const std::string&)override{if(read_failure)throw std::runtime_error("transport_down");return published;}
  bool DiscardBuild(const IndexBuildLease& b)override{++discards;if(discard_timeout)throw std::runtime_error("transport_unknown");
    if(discard){retired=IndexRetiredRef{b.shard,b.manifest_key};retired->shard.dimensions=0;retired->shard.checkpoint=0;if(wrong_retired)++retired->shard.revision;}return discard;}
  std::optional<IndexRetiredRef> Retired(const std::string&)override{if(retired_read_failure)throw std::runtime_error("transport_unknown");return retired;}
  bool ConfirmCleanup(const IndexRetiredRef&)override{++confirmations;if(confirm_timeout)throw std::runtime_error("transport_unknown");retired.reset();return true;}
};
struct Fixture {
  Temp tmp;
  std::unique_ptr<IndexShardFiles> files=IndexShardFiles::OpenForTesting(tmp.root);
  IndexJobContext context{std::string(64,'b'),files->StorageGeneration(),"siglip2-base-full-int8","search-v1-"+std::string(64,'a'),{channel},30};
  Jobs jobs;
  Fixture(){
    IndexShardIdentity shard{"11111111-1111-4111-8111-111111111111",0,channel,context.model_version,"1970-01-02",0,0,context.storage_generation};
    jobs.job=IndexJob{"44444444-4444-4444-8444-444444444444",worker,1,"index",shard,context.revision,context.package_id,"","",{}};
    shard.revision=1;shard.dimensions=3;jobs.lease={shard,jobs.job->id,worker,1,IndexShardFiles::ManifestKey(shard),{}};
  }
  Sample Row(const std::string& id,bool slot=false,char fp='c')const{
    Sample row;row.record={id,channel,"processor","session","track",context.model_version,86401000,false,{3,0,4},std::string(64,fp)};
    if(slot)row.track_slot=0;
    return row;
  }
};
}
int main(){try{
  size_t cases=0;
  {
    Fixture f;int scans=0;
    IndexBuildWorker b([&](const auto& model,const Scope& scope,int64_t after,size_t limit){
      ++scans;Check(model==f.context.model_version&&scope.channels.count(channel)&&scope.from_ms==86400000&&scope.to_ms==172800000&&limit==512,"scan_scope");
      return after==0?HistoryBatch{{f.Row("one")},1}:HistoryBatch{{},1};
    },*f.files,f.jobs,f.context,3);
    auto out=b.RunOne(worker);Check(out.state==State::Published&&out.publication->record_count==1&&scans==2&&f.jobs.publishes==1,"normal_publish");++cases;
    auto rows=f.files->Load(out.lease->shard,*out.publication);Check(rows.size()==1&&rows[0].id=="one"&&std::abs(rows[0].vector[0]-.6)<1e-6,"normalized_file");++cases;
  }
  {
    Fixture f;int scans=0;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t after,size_t){++scans;
      return after==0?HistoryBatch{{f.Row("slot",true)},1}:after==1?HistoryBatch{{f.Row("slot",true,'d')},2}:HistoryBatch{{},2};
    },*f.files,f.jobs,f.context,3);
    auto out=b.RunOne(worker);Check(out.state==State::Published&&out.publication->record_count==1&&scans==3,"slot_replaced");
    Check(f.files->Load(out.lease->shard,*out.publication).at(0).fingerprint==std::string(64,'d'),"slot_generation");++cases;
  }
  {
    Fixture f;int scans=0;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    f.jobs.job.reset();Check(b.RunOne(worker).state==State::Idle&&scans==0,"idle");++cases;
    Check(b.RunOne("bad").state==State::Invalid&&f.jobs.claims==1,"invalid_worker");++cases;
    Check(b.RunOne(worker,"invalid").state==State::Invalid,"invalid_kind");++cases;
    Check(b.RunOne(worker,"index",[]{return true;}).state==State::Cancelled&&f.jobs.claims==1,"cancel_before_claim");++cases;
  }
  for(int change=0;change<6;++change){
    Fixture f;int scans=0;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    if(change==0)f.jobs.job->config_revision=std::string(64,'f');
    if(change==1)f.jobs.job->shard.storage_generation=std::string(64,'f');
    if(change==2)f.jobs.job->shard.channel_id=worker;
    if(change==3)f.jobs.job->shard.model_version="other";
    if(change==4)f.jobs.job->worker=channel;
    if(change==5)f.jobs.job->package_id="other";
    Check(b.RunOne(worker).state==State::Stale&&scans==0&&f.jobs.publishes==0,"stale_context_accepted");++cases;
  }
  {
    Fixture f;f.jobs.renew=false;int scans=0;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    Check(b.RunOne(worker).state==State::Stale&&scans==0,"lease_lost_before_scan");++cases;
  }
  {
    Fixture f;IndexBuildOptions options;options.max_records=1;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){return HistoryBatch{{f.Row("one"),f.Row("two")},2};},*f.files,f.jobs,f.context,3,options);
    Check(b.RunOne(worker).state==State::Capacity&&f.jobs.failures==1&&f.jobs.publishes==0,"capacity_no_partial_publish");++cases;
  }
  for(int wrong=0;wrong<5;++wrong){
    Fixture f;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){auto row=f.Row("one");
      if(wrong==0)row.record.channel=worker;
      if(wrong==1)row.record.captured_ms=0;
      if(wrong==2)row.record.fingerprint="bad";
      if(wrong==3)row.record.model="wrong";
      return HistoryBatch{{row},wrong==4?0:1};
    },*f.files,f.jobs,f.context,3);
    Check(b.RunOne(worker).state==State::Unavailable&&f.jobs.publishes==0,"invalid_scan_published");++cases;
  }
  {
    Fixture f;int scans=0;f.jobs.timeout=true;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    auto out=b.RunOne(worker);Check(out.state==State::NeedsReconcile&&f.jobs.publishes==1&&f.jobs.discards==0&&f.jobs.confirmations==0,"unknown_ack");++cases;
    Check(b.Reconcile(out).state==State::Published&&scans==1&&f.jobs.publishes==1,"no_unknown_resend");++cases;
    const auto original=f.jobs.published;
    f.jobs.published->shard.dimensions=0;
    Check(b.Reconcile(out).state==State::Published,"catalog_omitted_local_dimensions");++cases;
    f.jobs.published=original;
    for(int mismatch=0;mismatch<5;++mismatch){
      f.jobs.published=original;
      if(mismatch==0)f.jobs.published->shard.channel_id=worker;
      if(mismatch==1)f.jobs.published->shard.utc_day="1970-01-03";
      if(mismatch==2)f.jobs.published->shard.id=worker;
      if(mismatch==3)f.jobs.published->shard.dimensions=2;
      if(mismatch==4)f.jobs.published->shard.checkpoint=9;
      Check(b.Reconcile(out).state==State::Stale,"mismatched_catalog_identity_adopted");++cases;
    }
    f.jobs.published.reset();Check(b.Reconcile(out).state==State::NeedsReconcile,"absent_not_rejection");++cases;
    f.jobs.read_failure=true;Check(b.Reconcile(out).state==State::NeedsReconcile,"read_failure_not_rejection");++cases;
    Check(b.Reconcile(out,[]{return true;}).state==State::Cancelled,"reconcile_cancel");++cases;
  }
  {
    Fixture f;f.jobs.job->shard.utc_day="2025-02-29";int scans=0;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    Check(b.RunOne(worker).state==State::Unavailable&&scans==0,"invalid_day");++cases;
  }
  {
    Fixture f;int scans=0;auto now=std::chrono::steady_clock::now();
    IndexBuildOptions options;options.max_duration=std::chrono::seconds(1);
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){++scans;now+=std::chrono::seconds(2);return HistoryBatch{{},1};},*f.files,f.jobs,f.context,3,options,[&]{return now;});
    Check(b.RunOne(worker).state==State::Cancelled&&scans==1&&f.jobs.publishes==0,"duration_bound");++cases;
  }
  {
    Fixture f;
    for(int i=0;i<101;++i)f.context.channels.push_back("55555555-5555-4555-8555-"+std::to_string(100000000000LL+i));
    IndexBuildWorker b([&](const auto&,const Scope& scope,int64_t,size_t){
      Check(scope.channels.size()==1,"directory_size_expanded_job_scope");return HistoryBatch{};
    },*f.files,f.jobs,f.context,3);
    Check(b.RunOne(worker).state==State::Published,"large_directory_rejected_single_channel_build");++cases;
  }
  for(int mode=0;mode<5;++mode){
    Fixture f;f.jobs.discard=mode!=1;f.jobs.discard_timeout=mode==2;f.jobs.wrong_retired=mode==3;f.jobs.confirm_timeout=mode==4;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    const auto manifest=f.tmp.root/f.jobs.lease.shard.id/"1.manifest.json";
    auto out=b.RunOne(worker,"index",[&]{return fs::exists(manifest);});
    Check(out.state==State::Cancelled&&out.publication&&f.jobs.publishes==0&&f.jobs.discards==1,"cancelled build cleanup lifecycle");
    if(mode==0||mode==4){Check(!fs::exists(manifest)&&f.jobs.confirmations==1,"authorized orphan not removed");}
    else{Check(fs::exists(manifest)&&f.jobs.confirmations==0,"unconfirmed or wrong retired ref deleted");}
    if(mode==4)Check(f.jobs.retired.has_value(),"unknown cleanup confirm lost PG retry ref");
    ++cases;
  }
  for(bool larger:{false,true}){
    Fixture f;f.jobs.job->minimum_checkpoint=100;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t after,size_t){
      return larger&&after==0?HistoryBatch{{f.Row("visible")},200}:HistoryBatch{{},larger?200:0};
    },*f.files,f.jobs,f.context,3);
    const auto out=b.RunOne(worker);Check(out.state==State::Published&&out.publication->checkpoint==(larger?200:100),"claimed processing watermark lost");
    Check(f.files->Load(out.lease->shard,*out.publication).size()==(larger?1:0),"processing watermark fabricated vector content");++cases;
  }
  for(int mode=0;mode<5;++mode){
    Fixture f;f.jobs.timeout=true;f.jobs.write=false;f.jobs.discard=true;
    f.jobs.discard_timeout=mode==1;f.jobs.wrong_retired=mode==2;f.jobs.confirm_timeout=mode==3;f.jobs.retired_read_failure=mode==4;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    auto unknown=b.RunOne(worker);Check(unknown.state==State::NeedsReconcile&&f.jobs.discards==0,"unsubmitted unknown fixture");
    const auto manifest=f.tmp.root/f.jobs.lease.shard.id/"1.manifest.json";
    const auto reconciled=b.Reconcile(unknown);Check(f.jobs.publishes==1,"unknown Publish replayed during reconcile");
    if(mode==1){Check(reconciled.state==State::NeedsReconcile&&fs::exists(manifest)&&f.jobs.confirmations==0,"unknown revocation inferred rejection");}
    else{
      Check(reconciled.state==State::Cancelled,"positive revocation blocked other partitions");
      if(mode==0||mode==3)Check(!fs::exists(manifest)&&f.jobs.confirmations==1,"authorized revoked file not cleaned");
      else Check(fs::exists(manifest)&&f.jobs.confirmations==0,"missing or wrong-generation ref deleted evidence");
      if(mode==3)Check(f.jobs.retired.has_value(),"unknown confirm lost durable retired reference");
      if(mode==0){
        // The serial runtime may now claim unrelated work instead of remaining
        // permanently in publication_unconfirmed after an uncommitted timeout.
        f.jobs.timeout=false;f.jobs.write=true;f.jobs.job->id="55555555-5555-4555-8555-555555555555";
        f.jobs.job->shard.id="66666666-6666-4666-8666-666666666666";f.jobs.job->shard.utc_day="1970-01-03";
        f.jobs.lease.shard=f.jobs.job->shard;f.jobs.lease.shard.revision=1;f.jobs.lease.shard.dimensions=3;
        f.jobs.lease.job_id=f.jobs.job->id;f.jobs.lease.manifest_key=IndexShardFiles::ManifestKey(f.jobs.lease.shard);
        Check(b.RunOne(worker).state==State::Published&&f.jobs.claims==2,"revoked unknown prevented another pending partition");
      }
    }
    ++cases;
  }
  {
    Fixture f;f.jobs.timeout=true;f.jobs.discard=true;
    IndexBuildWorker b([&](const auto&,const auto&,int64_t,size_t){return HistoryBatch{};},*f.files,f.jobs,f.context,3);
    const auto pending=b.RunOne(worker);Check(b.Reconcile(pending).state==State::Published&&f.jobs.discards==0,"committed publication was revoked");++cases;
  }
  std::cout<<"{\"cases\":"<<cases<<",\"passed\":true}\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
