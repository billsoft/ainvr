#include "index_build_worker.hpp"
#include <algorithm>
#include <ctime>
#include <iomanip>
#include <regex>
#include <sstream>
namespace ainvr::search {
namespace {
using State = IndexBuildOutcome::State;
bool Uuid(const std::string& value) { return std::regex_match(value,std::regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")); }
bool Hash(const std::string& value) { return std::regex_match(value,std::regex("[a-f0-9]{64}")); }
Scope Window(const std::string& channel, const std::string& day) {
  if (!Uuid(channel) || !std::regex_match(day,std::regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))) throw std::invalid_argument("invalid_index_day");
  std::tm date{}; std::istringstream input(day); input>>std::get_time(&date,"%Y-%m-%d");
  if (input.fail()) throw std::invalid_argument("invalid_index_day");
  const auto seconds=timegm(&date); char canonical[11]{};
  if (seconds<0 || !strftime(canonical,sizeof(canonical),"%Y-%m-%d",&date) || day!=canonical) throw std::invalid_argument("invalid_index_day");
  return {{channel},int64_t(seconds)*1000,int64_t(seconds)*1000+86400000,20};
}
bool Abort(const IndexBuildWorker::Cancelled& cancelled) { return cancelled && cancelled(); }
IndexBuildOutcome Result(State state) { return {state,{}, {}}; }
bool SamePublication(const ShardPublication& a,const ShardPublication& b) {
  return a.manifest_key==b.manifest_key && a.manifest_sha256==b.manifest_sha256 && a.checkpoint==b.checkpoint && a.record_count==b.record_count && a.byte_count==b.byte_count;
}
bool SameRetired(const IndexRetiredRef& ref,const IndexBuildLease& build){
  return ref.shard.id==build.shard.id&&ref.shard.revision==build.shard.revision&&
    ref.shard.channel_id==build.shard.channel_id&&ref.shard.model_version==build.shard.model_version&&
    ref.shard.utc_day==build.shard.utc_day&&ref.shard.storage_generation==build.shard.storage_generation&&ref.manifest_key==build.manifest_key;
}
}
#ifndef AINVR_INDEX_BUILDER_TESTING
IndexBuildWorker::IndexBuildWorker(HistoryMongo& history,IndexShardFiles& files,IndexJobPort& jobs,
    IndexJobContext context,size_t dimensions,IndexBuildOptions options,Clock clock)
  :scan_([&history](const auto& model,const auto& scope,auto after,auto limit){return history.Scan(model,scope,after,limit);}),
   files_(files),jobs_(jobs),context_(std::move(context)),dimensions_(dimensions),options_(options),clock_(std::move(clock)){Validate();}
#endif
#ifdef AINVR_INDEX_BUILDER_TESTING
IndexBuildWorker::IndexBuildWorker(Scan scan,IndexShardFiles& files,IndexJobPort& jobs,
    IndexJobContext context,size_t dimensions,IndexBuildOptions options,Clock clock)
  :scan_(std::move(scan)),files_(files),jobs_(jobs),context_(std::move(context)),dimensions_(dimensions),options_(options),clock_(std::move(clock)){Validate();}
#endif
void IndexBuildWorker::Validate() {
  if (!clock_) clock_=[] {return std::chrono::steady_clock::now();};
  if (!scan_ || !Hash(context_.revision) || !Hash(context_.storage_generation) || files_.StorageGeneration()!=context_.storage_generation ||
      !std::regex_match(context_.model_version,std::regex("search-v1-[a-f0-9]{64}")) || context_.package_id.empty() || context_.package_id.size()>128 ||
      context_.channels.empty() || context_.channels.size()>1024 || dimensions_==0 || dimensions_>4096 || options_.max_records==0 || options_.max_records>100000 ||
      options_.batch_size==0 || options_.batch_size>1000 || options_.max_batches==0 || options_.max_batches>2048 ||
      options_.max_vector_bytes<dimensions_*sizeof(float) || options_.max_vector_bytes>256ULL*1024*1024 || options_.max_duration.count()<1 || options_.max_duration.count()>300)
    throw std::invalid_argument("invalid_index_build_policy");
  for (const auto& channel:context_.channels) if(!Uuid(channel))throw std::invalid_argument("invalid_index_source");
  capacity_=std::min<uint64_t>(options_.max_records,options_.max_vector_bytes/(dimensions_*sizeof(float)));
}
bool IndexBuildWorker::SameJob(const IndexJob& job) const {
  return Uuid(job.id)&&Uuid(job.worker)&&job.generation>0&&job.generation<=9007199254740991ULL&&
    (job.kind=="index"||job.kind=="rebuild")&&job.minimum_checkpoint>=0&&job.minimum_checkpoint<=9007199254740991LL&&
    job.config_revision==context_.revision&&job.package_id==context_.package_id&&
    Uuid(job.shard.id)&&job.shard.model_version==context_.model_version&&job.shard.storage_generation==context_.storage_generation&&
    std::find(context_.channels.begin(),context_.channels.end(),job.shard.channel_id)!=context_.channels.end();
}
bool IndexBuildWorker::SameBuild(const IndexJob& job,const IndexBuildLease& lease) const {
  return lease.job_id==job.id&&lease.worker==job.worker&&lease.job_generation==job.generation&&
    lease.shard.id==job.shard.id&&lease.shard.channel_id==job.shard.channel_id&&lease.shard.model_version==job.shard.model_version&&
    lease.shard.utc_day==job.shard.utc_day&&lease.shard.storage_generation==job.shard.storage_generation&&
    lease.shard.revision>0&&lease.shard.revision<=9007199254740991ULL&&lease.manifest_key==IndexShardFiles::ManifestKey(lease.shard);
}
IndexBuildOutcome IndexBuildWorker::RunOne(const std::string& worker,const std::string& kind,Cancelled cancelled) {
  if(!Uuid(worker)||(kind!="index"&&kind!="rebuild"))return Result(State::Invalid);
  if(Abort(cancelled))return Result(State::Cancelled);
  std::optional<IndexJob> job; std::optional<IndexBuildLease> build; std::optional<ShardPublication> publication;
  bool sent=false;
  // Only a positive PG revocation plus the exact retired reference authorizes
  // cleanup. Absence from the published directory never proves a lost write
  // was rejected. An ambiguous Publish is deliberately excluded below.
  auto abandoned=[&](State state)->IndexBuildOutcome{
    if(build&&!sent){try{
      if(jobs_.DiscardBuild(*build)){
        const auto ref=jobs_.Retired(build->shard.id);
        if(ref&&SameRetired(*ref,*build)){
          files_.DeleteRetired(ref->shard,ref->manifest_key);
          (void)jobs_.ConfirmCleanup(*ref);
        }
      }
    }catch(...){/* PG's single retired slot remains discoverable; no retry here. */}}
    return {state,build,publication};
  };
  const auto start=clock_();
  auto stopped=[&]{return Abort(cancelled)||clock_()-start>options_.max_duration;};
  try {
    job=jobs_.Claim(worker,kind); if(!job)return Result(State::Idle);
    if(!SameJob(*job)||job->worker!=worker||job->kind!=kind)return Result(State::Stale);
    auto window=Window(job->shard.channel_id,job->shard.utc_day);
    if(context_.migration_scope){
      // A granted 31-day range may start/end inside a UTC day. Reuse the
      // bounded builder without broadening metadata/vector reads outside it.
      window.from_ms=std::max(window.from_ms,context_.migration_scope->from_ms);
      window.to_ms=std::min(window.to_ms,context_.migration_scope->to_ms);
      if(window.to_ms<=window.from_ms)return Result(State::Stale);
    }
    if(stopped())return Result(State::Cancelled);
    build=jobs_.Begin(*job); build->shard.dimensions=dimensions_;
    if(!SameBuild(*job,*build))return Result(State::Invalid);
    VectorIndex index(context_.model_version,dimensions_,capacity_);
    int64_t checkpoint=0; size_t batches=0;
    for(;;) {
      if(stopped())return abandoned(State::Cancelled);
      if(!jobs_.Renew(*job))return abandoned(State::Stale);
      if(++batches>options_.max_batches)throw std::runtime_error("index_capacity");
      const auto batch=scan_(context_.model_version,window,checkpoint,options_.batch_size);
      if(batch.samples.size()>options_.batch_size||batch.checkpoint<checkpoint||batch.checkpoint>9007199254740991LL||
          (!batch.samples.empty()&&batch.checkpoint==checkpoint))throw std::runtime_error("invalid_index_scan");
      for(const auto& sample:batch.samples) {
        const auto& row=sample.record;
        if(row.channel!=job->shard.channel_id||row.model!=context_.model_version||row.captured_ms<window.from_ms||row.captured_ms>=window.to_ms||!Hash(row.fingerprint))
          throw std::runtime_error("invalid_index_scan");
        if(sample.track_slot)index.ReplaceTrackSlot(row,index.Fingerprint(row.id).value_or(""));
        else index.Upsert(row);
      }
      if(batch.checkpoint==checkpoint)break;
      checkpoint=batch.checkpoint;
    }
    if(stopped())return abandoned(State::Cancelled);
    if(!jobs_.Renew(*job))return abandoned(State::Stale);
    // Only after a complete authoritative traversal. Deleted/expired rows may
    // leave no current vector ordinal, but the claimed dirty watermark is now
    // processed. This is never used as proof of video/sampling coverage.
    build->shard.checkpoint=std::max(checkpoint,job->minimum_checkpoint);
    auto records=std::move(index).ReleaseRecords();
    publication=files_.Publish(build->shard,records);
    std::vector<Record>().swap(records); // no vector payload retained for unknown ACK
    auto verified=files_.Load(build->shard,*publication);
    if(verified.size()!=publication->record_count)throw std::runtime_error("invalid_index_file");
    std::vector<Record>().swap(verified);
    if(stopped())return abandoned(State::Cancelled);
    if(!jobs_.Renew(*job))return abandoned(State::Stale);
    sent=true;
    if(!jobs_.Publish(*build,*publication))return {State::Stale,build,publication};
    return {State::Published,build,publication};
  }catch(const std::exception& error) {
    if(sent&&build&&publication)return {State::NeedsReconcile,build,publication};
    const std::string code=error.what();
    if(code=="index_capacity"||code=="search_index_capacity"||code=="search_index_quota_exceeded"||code=="index_job_capacity") {
      if(job)try{jobs_.Fail(*job,"index_capacity");}catch(...){}
      return abandoned(State::Capacity);
    }
    if(code=="index_job_stale"||code=="index_forbidden")return abandoned(State::Stale);
    // A positive PG revocation permits exact derived-file cleanup. If that RPC
    // is unknown, PG retains the lease/retired slot for bounded reconciliation;
    // no second in-memory retry queue or speculative deletion is introduced.
    return abandoned(State::Unavailable);
  }
}
IndexBuildOutcome IndexBuildWorker::Reconcile(const IndexBuildOutcome& pending,Cancelled cancelled) {
  if(!pending.lease||!pending.publication||pending.state!=State::NeedsReconcile)return Result(State::Invalid);
  if(Abort(cancelled))return Result(State::Cancelled);
  const auto& lease=*pending.lease;
  if(lease.shard.dimensions!=dimensions_||lease.shard.model_version!=context_.model_version||lease.shard.storage_generation!=context_.storage_generation||
      std::find(context_.channels.begin(),context_.channels.end(),lease.shard.channel_id)==context_.channels.end())return Result(State::Stale);
  try {
    const auto saved=jobs_.Published(lease.shard.id);
    if(saved){
      // PG does not store dimensions. A newer publication proves the old
      // build is fenced; an older publication says nothing about this request.
      if(saved->shard.id!=lease.shard.id||saved->shard.channel_id!=lease.shard.channel_id||
        saved->shard.utc_day!=lease.shard.utc_day||
        (saved->shard.dimensions!=0&&saved->shard.dimensions!=lease.shard.dimensions)||
        saved->shard.model_version!=lease.shard.model_version||saved->shard.storage_generation!=lease.shard.storage_generation)return Result(State::Stale);
      if(saved->shard.revision>lease.shard.revision)return Result(State::Stale);
      if(saved->shard.revision==lease.shard.revision){
        if(saved->shard.checkpoint!=lease.shard.checkpoint||!SamePublication(saved->publication,*pending.publication))return Result(State::Stale);
        return {State::Published,lease,pending.publication};
      }
    }
    if(Abort(cancelled))return pending;
    // Absence is NOT a rejection. Ask PG to atomically revoke this exact
    // unpublished build instead. A racing/committed publication makes this
    // return false, and no file is deleted or Publish replayed.
    if(!jobs_.DiscardBuild(lease))return pending;
    // Positive revocation is a final publication result. Cleanup has its own
    // durable PG retired slot, so a failed lookup/confirm must not block every
    // other partition. Delete only a matching explicit retired reference.
    try{
      const auto retired=jobs_.Retired(lease.shard.id);
      if(retired&&SameRetired(*retired,lease)){
        files_.DeleteRetired(retired->shard,retired->manifest_key);
        (void)jobs_.ConfirmCleanup(*retired);
      }
    }catch(...){/* Runtime's independent retired-catalog pass owns GC retries. */}
    return {State::Cancelled,lease,pending.publication};
  }catch(...){return pending;}
}
} // namespace ainvr::search
