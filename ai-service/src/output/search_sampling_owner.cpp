#include <chrono>
#include <thread>
#include "output/search_sampling_owner.hpp"
#include <atomic>
#include <cctype>
#include <set>
#include <vector>
namespace ai_service::output {
namespace search_owner_detail {
using Policy = SearchSamplingPolicy;
using Status = SearchSamplingOffer::Status;
// Separate resident descriptor accounting: it MUST NOT keep a raw-frame work
// ticket alive. 4096 tracks + 128 scenes + bounded uncertain descriptors;
// 32 MiB also covers the supported 1152-D package (with metadata allowance).
struct DescriptorAccounting {std::atomic<size_t> count{0},bytes{0};};
struct Descriptor {
  std::vector<float> values;
  std::array<char,64> fingerprint{};
  std::shared_ptr<DescriptorAccounting> account;
  size_t charge=0;
  ~Descriptor(){if(account){account->bytes.fetch_sub(charge);account->count.fetch_sub(1);}}
  std::string Fingerprint()const{return {fingerprint.begin(),fingerprint.end()};}
};
struct Source {
  explicit Source(std::string id): processor(std::move(id)) {}
  std::string processor;
  std::atomic<uint64_t> token{1};
  std::atomic<uint64_t> generation_stamp{1},missed_end_generation{0},missed_end_events{0};
  uint64_t handled_missed_events=0;
  uint64_t generation = 1;
  bool retired = false;
  std::optional<SearchFrameFence> fence;
  std::optional<SearchSamplingBinding> binding;
  std::optional<config::SearchProducerSource> mapping;
  // The existing authoritative tracker-ID set, with its acknowledged descriptor
  // attached. No second tracker, reassociation or identity registry.
  std::map<std::string,std::shared_ptr<const Descriptor>> tracks;
  std::shared_ptr<const Descriptor> scene_descriptor;
  std::set<std::string> uncertain_tracks;
  int64_t coverage_index=-1,coverage_pts=-1,coverage_ms=-1;
  bool coverage_object_complete=false,coverage_scene_complete=false;
  std::optional<SearchObservationTicket> coverage_observation;
  // Samples deferred by admission pressure but still owed; losing one is a gap.
  std::set<std::string> owed_tracks;bool owed_scene=false,owed_lost=false;
  int64_t retired_scene_pts=-1,retired_scene_index=-1;
  void Miss(uint64_t expected_token,uint64_t epoch) noexcept {
    if(token.load()!=expected_token||generation_stamp.load()!=epoch)return;
    auto old=missed_end_generation.load();
    // An old in-flight frame cannot overwrite a newer lifecycle's gap latch.
    while(old<epoch&&!missed_end_generation.compare_exchange_weak(old,epoch)){}
    auto events=missed_end_events.load();
    while(events!=UINT64_MAX&&!missed_end_events.compare_exchange_weak(events,events+1)){}
  }
};
struct FrameAttempt {
  Source& source;uint64_t token,epoch;bool accepted=false;
  FrameAttempt(Source& s,uint64_t t):source(s),token(t),epoch(s.generation_stamp.load()){}
  ~FrameAttempt(){if(!accepted)source.Miss(token,epoch);}
};
struct Job {
  Policy::Candidate candidate;
  config::SearchProducerSource mapping;
  SearchEmbeddingSpace space;
  config::SearchProducerLease lease;
  std::weak_ptr<Source> source;
  uint64_t generation = 0;
  std::atomic<bool> cancelled{false};
  bool running = false, needs_reconcile = false;
  std::optional<std::chrono::steady_clock::time_point> uncertain_since;
  std::string receipt_key, receipt_query;
  std::shared_ptr<const FrozenSearchFrame> frame;
  std::shared_ptr<const Descriptor> baseline;
  std::shared_ptr<Descriptor> descriptor;
};
struct State: std::enable_shared_from_this<State> {
  State(config::SearchProducerLeaseReader r, std::shared_ptr<SearchSamplingExecutionPort> p, ArchiveExecutor& e,
      std::function<std::chrono::steady_clock::time_point()> now)
    : reader(std::move(r)), port(std::move(p)), executor(e), clock(now?std::move(now):[]{return std::chrono::steady_clock::now();}), policy([] { SearchSamplingConfig c; c.max_pending = kSearchSamplingMetadataPendingLimit; return c; }()) {}
  mutable std::mutex mutex;
  config::SearchProducerLeaseReader reader;
  std::shared_ptr<SearchSamplingExecutionPort> port;
  ArchiveExecutor& executor;
  std::function<std::chrono::steady_clock::time_point()> clock;
  bool coverage_running=false;
  size_t coverage_failures=0,retired_unknown=0,deferred_offers=0;
  std::atomic<uint64_t> end_lock_busy{0};
  std::array<std::atomic<uint64_t>,10> offer_status{};
  SearchSamplingOffer Counted(SearchSamplingOffer offer){offer_status[size_t(offer.status)].fetch_add(1,std::memory_order_relaxed);return offer;}
  // Inference-thread entry points wait at most ~2 ms for a control tick/ACK instead of reading as lost frames.
  std::unique_lock<std::mutex> LockBounded(){
    std::unique_lock<std::mutex> lock(mutex,std::defer_lock);
    bool got=lock.try_lock();
    for(int spin=0;!got&&spin<40;++spin){std::this_thread::sleep_for(std::chrono::microseconds(50));got=lock.try_lock();}
    if(!got)end_lock_busy.fetch_add(1,std::memory_order_relaxed);
    return lock;
  }
  Policy policy;
  SearchCoverageLedger coverage;
  SearchWorkBudget budget;
  std::shared_ptr<DescriptorAccounting> descriptor_account=std::make_shared<DescriptorAccounting>();
  bool stopped = false;
  bool coverage_turn = false;
  std::optional<SearchEmbeddingSpace> space;
  std::map<std::string, std::weak_ptr<Source>> sources;
  std::map<Policy::Token, std::shared_ptr<Job>> jobs;
  Policy::Token reconcile_cursor = 0;
  std::vector<std::future<void>> futures;
  std::optional<std::pair<int64_t,int64_t>> configured_budget;
  static bool Safe(const std::string& text, size_t max = 128) {
    return !text.empty() && text.size() <= max && std::all_of(text.begin(), text.end(), [](unsigned char c) {
      return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
    });
  }
  // Envelope/retention boundary only. The storage endpoint remains the sole
  // full sample validator; do not reconstruct random IDs/expiry from Candidate.
  static bool ReceiptQueryValid(const std::string& text, const Job& job) {
    using Json = nlohmann::json;
    if (text.empty() || text.size() > 16384) return false;
    try {
      std::vector<std::set<std::string>> object_keys;
      const auto query = Json::parse(text, [&](int depth, Json::parse_event_t event, Json& parsed) {
        if (depth < 0 || depth > 8) throw std::invalid_argument("receipt_metadata_depth");
        if (event==Json::parse_event_t::object_start) {
          if (object_keys.size()<=size_t(depth)) object_keys.resize(size_t(depth)+1);
          object_keys[size_t(depth)].clear();
        } else if (event==Json::parse_event_t::key) {
          if (!depth || object_keys.size()<size_t(depth) ||
              !object_keys[size_t(depth)-1].insert(parsed.get<std::string>()).second)
            throw std::invalid_argument("receipt_metadata_duplicate");
        }
        return true;
      });
      const auto keys = [](const Json& object, std::initializer_list<const char*> names) {
        if (!object.is_object() || object.size() != names.size()) return false;
        return std::all_of(names.begin(),names.end(),[&](const char* name){return object.contains(name);});
      };
      const bool object = job.candidate.slot.has_value();
      if (object ? !keys(query,{"sample","slot","replacement_token","request_fingerprint"}) :
          !keys(query,{"sample","request_fingerprint"})) return false;
      const auto& sample = query.at("sample");
      if (!keys(sample,{"id","channel_id","processor_id","stream_session_id","track_id","model_version",
          "captured_ms","kind","evidence","expires_ms"}) || !sample.at("evidence").is_object()) return false;
      const auto& hash = query.at("request_fingerprint");
      if (!hash.is_string()) return false;
      const auto fingerprint = hash.get<std::string>();
      if (fingerprint.size()!=64 || !std::all_of(fingerprint.begin(),fingerprint.end(),[](char c){return (c>='a'&&c<='f')||(c>='0'&&c<='9');})) return false;
      if (object && (!query.at("slot").is_number_integer() || query.at("slot").get<int64_t>() != int64_t(*job.candidate.slot) ||
          !query.at("replacement_token").is_string() || !Safe(query.at("replacement_token").get<std::string>()))) return false;
      // Fence identity without deriving or changing the original write metadata.
      const auto& frame = job.candidate.frame; const auto& evidence = sample.at("evidence");
      if (sample.at("channel_id") != job.mapping.channel_id || sample.at("processor_id") != job.mapping.processor_id ||
          sample.at("stream_session_id") != frame.binding.stream_session_id || sample.at("track_id") != job.candidate.track_id ||
          sample.at("model_version") != job.space.model_version || sample.at("captured_ms") != frame.captured_ms ||
          sample.at("kind") != (object ? "object" : "scene") || evidence.at("source_input_id") != job.mapping.input_stream_id ||
          evidence.at("output_channel_id") != job.mapping.channel_id || evidence.at("recording_channel_id") != job.mapping.recording_channel_id ||
          evidence.at("input_path") != job.mapping.input_path || evidence.at("output_path") != job.mapping.output_path ||
          evidence.at("stream_session_id") != frame.binding.stream_session_id ||
          evidence.at("source_pts_ns") != std::to_string(frame.source_pts_ns) ||
          evidence.at("source_frame_index") != std::to_string(frame.source_frame_index) ||
          evidence.at("frame_width") != frame.binding.width || evidence.at("frame_height") != frame.binding.height) return false;
      size_t nodes = 0;
      const auto safe_metadata = [&](const auto& self, const Json& value) -> bool {
        if (++nodes > 512 || value.is_binary() || value.is_discarded()) return false;
        if (value.is_object()) {
          if (value.size()>64) return false;
          for (auto i=value.begin();i!=value.end();++i) {
            std::string key; for (unsigned char c:i.key()) if (c!='_'&&c!='-') key+=char(std::tolower(c));
            for (const auto* forbidden : {"image","jpeg","pixels","vector","embedding","body","headers","authorization",
                "password","secret","apikey","apitoken","credentials","token","encodedbody","imagedata"})
              if (key==forbidden) return false;
            if (!self(self,i.value())) return false;
          }
        } else if (value.is_array()) {
          if (value.size()>64) return false;
          for (const auto& item:value) if (!self(self,item)) return false;
        } else if (value.is_string()) {
          const auto& s=value.get_ref<const std::string&>();
          if (s.size()>2048 || s.find("://")!=std::string::npos ||
              (!job.lease.grant->api_token.empty() && s.find(job.lease.grant->api_token)!=std::string::npos) ||
              std::any_of(s.begin(),s.end(),[](unsigned char c){return c<32||c==127;})) return false;
        } else if (value.is_number_float() && !std::isfinite(value.get<double>())) return false;
        return true;
      };
      return safe_metadata(safe_metadata,query);
    } catch (...) { return false; }
  }
  static bool SpaceValid(const SearchEmbeddingSpace& s) {
    return Safe(s.package_id) && Safe(s.model_version) && !s.input_spec_version.empty() &&
      s.input_spec_version.size()<=512 && std::all_of(s.input_spec_version.begin(),s.input_spec_version.end(),
        [](unsigned char c){return c>=32 && c<127;});
  }
  static bool SameIdentitySource(const config::SearchProducerSource& a, const config::SearchProducerSource& b) {
    return a.channel_id == b.channel_id && a.input_stream_id == b.input_stream_id && a.processor_id == b.processor_id &&
      a.recording_channel_id == b.recording_channel_id && a.input_path == b.input_path && a.output_path == b.output_path;
  }
  std::optional<config::SearchProducerLease> Lease() const {
    try { auto l = reader ? reader() : std::nullopt; return l && l->grant && l->IsCurrent() ? l : std::nullopt; }
    catch (...) { return std::nullopt; }
  }
  std::optional<SearchEmbeddingSpace> Ready() const {
    try { auto s = port ? port->CurrentSpace() : std::nullopt; return s && SpaceValid(*s) ? s : std::nullopt; }
    catch (...) { return std::nullopt; }
  }
  void Reap() {
    for (auto i = futures.begin(); i != futures.end();) {
      if (i->wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
        try { i->get(); } catch (...) {} i = futures.erase(i);
      } else ++i;
    }
  }
  enum ResetReason:size_t{ResetExplicit,ResetSpace,ResetFence,ResetNewSource,ResetStop,ResetReasonCount};
  std::array<uint64_t,ResetReasonCount> reset_reasons{};
  // Which fence field differed on a rebind (diagnostic): first, session, paths, source_epoch, stream_generation, view_reset, dimensions, other.
  std::array<uint64_t,8> fence_fields{};
  void CountFenceChange(const std::optional<SearchFrameFence>& old,const SearchFrameFence& now){
    if(!old){++fence_fields[0];return;}
    bool any=false;auto hit=[&](bool changed,size_t i){if(changed){++fence_fields[i];any=true;}};
    hit(old->stream_session_id!=now.stream_session_id,1);
    hit(old->input_path!=now.input_path||old->output_path!=now.output_path||old->processor_id!=now.processor_id,2);
    hit(old->source_epoch!=now.source_epoch,3);hit(old->stream_generation!=now.stream_generation,4);
    hit(old->view_reset_epoch!=now.view_reset_epoch,5);
    hit(old->raw_width!=now.raw_width||old->raw_height!=now.raw_height||old->observation_width!=now.observation_width||old->observation_height!=now.observation_height,6);
    if(!any)++fence_fields[7];
  }
  void ResetLocked(Source& source,ResetReason reason) {
    ++reset_reasons[reason];
    source.owed_tracks.clear();source.owed_scene=source.owed_lost=false;
    coverage.Seal(source.processor,source.generation);
    ++source.generation;
    source.generation_stamp.store(source.generation);
    source.handled_missed_events=source.missed_end_events.load();
    if (source.binding) policy.ResetSource(source.binding->source_input_id, source.processor);
    source.binding.reset(); source.fence.reset(); source.mapping.reset(); source.tracks.clear();source.scene_descriptor.reset();
    source.uncertain_tracks.clear();source.coverage_index=source.coverage_pts=source.coverage_ms=-1;
    source.coverage_object_complete=source.coverage_scene_complete=false;
    source.coverage_observation.reset();
    source.retired_scene_pts=source.retired_scene_index=-1;
    for (auto i = jobs.begin(); i != jobs.end();) {
      if (i->second->source.lock().get() == &source) { i->second->cancelled = true; i = jobs.erase(i); }
      else ++i;
    }
  }
  std::shared_ptr<Descriptor> CopyDescriptor(std::span<const float> values)const {
    if(values.empty()||values.size()>4096)return {};
    long double norm=0;for(float v:values){if(!std::isfinite(v))return {};norm+=static_cast<long double>(v)*v;}
    if(norm<.999L||norm>1.001L)return {};
    constexpr size_t max_count=4096+128+kSearchSamplingMetadataPendingLimit,max_bytes=32*1024*1024;
    const auto charge=values.size()*sizeof(float)+512;
    auto account=descriptor_account;
    if(account->count.fetch_add(1)>=max_count){account->count.fetch_sub(1);return {};}
    auto bytes=account->bytes.load();
    while(bytes<=max_bytes&&charge<=max_bytes-bytes&&!account->bytes.compare_exchange_weak(bytes,bytes+charge)){}
    if(bytes>max_bytes||charge>max_bytes-bytes){account->count.fetch_sub(1);return {};}
    try{auto d=std::make_shared<Descriptor>();d->values.assign(values.begin(),values.end());d->charge=charge;d->account=account;return d;}
    catch(...){account->bytes.fetch_sub(charge);account->count.fetch_sub(1);return {};}
  }
  SearchCoverageScope CoverageScope(const Source& source,bool scene) const {
    return {*source.mapping,space->package_id,space->model_version,source.binding->stream_session_id,source.generation,scene};
  }
  static int64_t NowMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count(); }
  static int64_t CoverageExpiry(int64_t ms,const config::SearchProducerGrant& grant) {
    const auto span=grant.limits.retention_days*86400000LL;
    return ms>=0&&ms<=9007199254740991LL-span?ms+span:0;
  }
  bool CoverageAuthorized(const SearchCoverageRange& range,const config::SearchProducerLease& lease)const {
    if(stopped||!lease.IsCurrent()||!lease.grant||!space||lease.grant->package_id!=range.scope.package_id||
        space->package_id!=range.scope.package_id||space->model_version!=range.scope.model_version)return false;
    const auto actual=Ready();if(!actual||!(*actual==*space))return false;
    const auto i=lease.grant->sources.find(range.scope.source.processor_id);
    return range.expires_ms<=range.to_ms+lease.grant->limits.retention_days*86400000LL&&
      i!=lease.grant->sources.end()&&SameIdentitySource(i->second,range.scope.source)&&
      (range.scope.scene?i->second.scene:i->second.object);
  }
  // One metadata task, independent of pixel/producer tickets and workers.
  // Each wake drains a bounded batch without delaying the first closed window.
  bool QueueCoverage() {
    if(!port||!port->CoverageEnabled()||coverage_running||futures.size()>=8)return false;
    const auto lease=Lease();if(!lease){coverage.SealAll(false);return false;}
    const auto report=coverage.Next(NowMs());if(!report)return false;
    if(!CoverageAuthorized(report->range,*lease)){coverage.Abandon(report->id);return false;}
    auto self=shared_from_this();
    try{futures.reserve(futures.size()+1);}catch(...){coverage.Reported(report->id,report->version,false);return false;}
    coverage_running=true;
    auto task=SearchCoverageExecutor().TrySubmit([self,first=*report]{
      std::optional<SearchCoverageLedger::Report> next=first;
      struct Finish{State& owner;std::optional<SearchCoverageLedger::Report>& report;
        ~Finish(){std::lock_guard<std::mutex> guard(owner.mutex);
          if(report)owner.coverage.Reported(report->id,report->version,false);
          owner.coverage_running=false;}} finish{*self,next};
      for(size_t count=0;count<16&&next;++count){
        std::optional<config::SearchProducerLease> active;
        {std::lock_guard<std::mutex> guard(self->mutex);active=self->Lease();
          if(!active||!self->CoverageAuthorized(next->range,*active)){
            self->coverage.Abandon(next->id);break;}}
        std::weak_ptr<State> weak=self;
        const auto current=[weak,range=next->range,lease=*active]{auto state=weak.lock();if(!state)return false;
          std::lock_guard<std::mutex> guard(state->mutex);return state->CoverageAuthorized(range,lease);};
        bool acknowledged=false;
        try{if(current())acknowledged=self->port->PublishCoverage(next->range,*active,current);}catch(...){}
        {std::lock_guard<std::mutex> guard(self->mutex);
          self->coverage.Reported(next->id,next->version,acknowledged);
          if(!acknowledged){++self->coverage_failures;break;}
          if(count+1<16&&!self->stopped)next=self->coverage.Next(NowMs());else next.reset();}
      }
    });
    if(!task){coverage_running=false;coverage.Reported(report->id,report->version,false);return false;}
    futures.push_back(std::move(*task));return true;
  }
  void RetireUnknown(){
    for(auto i=jobs.begin();i!=jobs.end();){auto job=i->second;
      if(!job->needs_reconcile||job->running||!job->uncertain_since||
          clock()-*job->uncertain_since<std::chrono::seconds(60)){++i;continue;}
      // Local cancellation is NOT proof the native write failed. Never resend
      // its frozen frame/ID. Object slots stay retired until the tracker leaves;
      // a later scene capture has a distinct immutable sample identity.
      if(job->candidate.slot){
        // Establish the fail-closed guard BEFORE dropping the policy's pending
        // slot. An allocation failure must leave the uncertain slot reserved.
        if(auto source=job->source.lock())source->uncertain_tracks.insert(job->candidate.track_id);
        policy.RetireTrack(job->candidate.frame.binding,job->candidate.track_id);
        if(auto source=job->source.lock()){
          auto track=source->tracks.find(job->candidate.track_id);if(track!=source->tracks.end())track->second.reset();}
      }else{
        if(!policy.Resolve(job->candidate.token,Policy::Outcome::Abandoned)){++i;continue;}
        if(auto source=job->source.lock()){
          source->retired_scene_pts=std::max(source->retired_scene_pts,job->candidate.frame.source_pts_ns);
          source->retired_scene_index=std::max(source->retired_scene_index,job->candidate.frame.source_frame_index);}
      }
      coverage.Resolve(job->candidate.token,SearchCoverageLedger::Outcome::Failed,SearchCoverageLedger::GapCause::FailRetiredUnknown);
      job->cancelled=true;i=jobs.erase(i);++retired_unknown;
    }
  }
  bool Configure(const config::SearchProducerGrant& grant) {
    const auto pair = std::make_pair(grant.limits.producer_queue, grant.limits.producer_bytes);
    if (!configured_budget || *configured_budget != pair) {
      budget.Configure(size_t(pair.first), size_t(pair.second)); configured_budget = pair;
    }
    SearchSamplingConfig timing;
    timing.object_interval_ns = grant.sampling.object_interval_ms * 1000000;
    timing.scene_active_interval_ns = grant.sampling.scene_active_interval_ms * 1000000;
    timing.scene_static_interval_ns = grant.sampling.scene_static_interval_ms * 1000000;
    timing.scene_change_interval_ns = grant.sampling.scene_change_min_interval_ms * 1000000;
    return policy.UpdateTiming(timing);
  }
  bool CurrentLocked(const Job& job, bool reconciliation) const {
    auto s = job.source.lock();
    if (stopped || job.cancelled || !s || s->retired || s->generation != job.generation || !s->fence ||
        !space || !(*space == job.space)) return false;
    auto actual = Ready(); if (!actual || !(*actual == job.space)) return false;
    if (!reconciliation) return job.frame && job.frame->IsCurrent(*s->fence);
    auto lease = Lease(); if (!lease || lease->grant->package_id != job.space.package_id) return false;
    auto found = lease->grant->sources.find(s->processor);
    return found != lease->grant->sources.end() && SameIdentitySource(found->second, job.mapping) &&
      (job.candidate.slot ? found->second.object : found->second.scene);
  }
  SearchSamplingCurrent Check(const std::shared_ptr<Job>& job, bool reconcile = false) {
    std::weak_ptr<State> weak = shared_from_this();
    return [weak, job, reconcile] { auto self = weak.lock(); if (!self) return false;
      std::lock_guard<std::mutex> lock(self->mutex); return self->CurrentLocked(*job, reconcile); };
  }
  void Complete(const std::shared_ptr<Job>& job, SearchSamplingReceipt receipt, bool reconcile,bool no_change=false) {
    std::lock_guard<std::mutex> lock(mutex);
    // packaged_task may retain its callable until future.get(); release the raw
    // owner now, rather than accidentally extending pixel lifetime to Reap.
    struct ReleasePixels { Job& job; ~ReleasePixels() { job.frame.reset(); job.lease = {}; } } release{*job};
    auto found = jobs.find(job->candidate.token);
    if (found == jobs.end() || found->second != job) return;
    job->running = false;
    const bool current = CurrentLocked(*job, reconcile);
    if(no_change&&current&&Policy::IsProbe(job->candidate)&&policy.Resolve(job->candidate.token,Policy::Outcome::NoChange)){
      coverage.Resolve(job->candidate.token,SearchCoverageLedger::Outcome::NoChange);jobs.erase(found);return;
    }
    if ((!receipt.receipt_key.empty() && !Safe(receipt.receipt_key)) ||
        (!receipt.receipt_key.empty() && !job->receipt_key.empty() && receipt.receipt_key != job->receipt_key))
      receipt.result = SearchSamplingReceipt::Result::Unknown;
    // An exception, bad ACK, late ACK or timeout might have written successfully.
    // Never pretend it was rejected and issue a new first frame in its place.
    if (current && receipt.result == SearchSamplingReceipt::Result::Committed &&
        policy.Resolve(job->candidate.token, Policy::Outcome::Committed, receipt.fingerprint)) {
      coverage.Resolve(job->candidate.token,SearchCoverageLedger::Outcome::Committed);
      if(auto owed=job->source.lock()){if(job->candidate.slot)owed->owed_tracks.erase(job->candidate.track_id);else owed->owed_scene=false;}
      if(job->descriptor){
        std::copy(receipt.fingerprint.begin(),receipt.fingerprint.end(),job->descriptor->fingerprint.begin());
        if(auto source=job->source.lock()){
          if(job->candidate.slot){auto track=source->tracks.find(job->candidate.track_id);if(track!=source->tracks.end())track->second=job->descriptor;}
          else source->scene_descriptor=job->descriptor;
        }
      }
      jobs.erase(found); return;
    }
    if (receipt.result == SearchSamplingReceipt::Result::Rejected &&
        receipt.fingerprint.empty() && policy.Resolve(job->candidate.token, Policy::Outcome::Failed)) {
      coverage.Resolve(job->candidate.token,SearchCoverageLedger::Outcome::Failed,SearchCoverageLedger::GapCause::FailRejected);
      jobs.erase(found); return;
    }
    policy.Resolve(job->candidate.token, Policy::Outcome::Unknown);
    coverage.Resolve(job->candidate.token,SearchCoverageLedger::Outcome::Unknown);
    job->needs_reconcile = true;
    if(!job->uncertain_since)job->uncertain_since=clock();
    if (job->receipt_key.empty() && Safe(receipt.receipt_key)) job->receipt_key = std::move(receipt.receipt_key);
    // Unknown releases pixels AND any prepared encoded body immediately. Only
    // bounded CAS metadata remains; reconciliation is lookup, never resubmission.
    job->frame.reset();
  }
  bool Queue(const std::shared_ptr<Job>& job, bool reconcile, std::shared_ptr<SearchWorkBudget::Ticket> reservation = {}) {
    if (futures.size() >= 8) return false;
    // Allocate bookkeeping BEFORE enqueue: once TrySubmit accepts, its task is
    // owned by the executor and may already be executing on another thread.
    try { futures.reserve(futures.size() + 1); } catch (...) { return false; }
    auto self = shared_from_this(); job->running = true;
    auto queued = executor.TrySubmit([self, job, reconcile, reservation = std::move(reservation)] () mutable {
      SearchSamplingReceipt reply;
      if (!reconcile) reply.result = SearchSamplingReceipt::Result::Rejected;
      bool write_attempted = false;
      bool no_change=false;
      try {
        auto current = self->Check(job, reconcile);
        if (current()) {
          if (reconcile) {
            const auto lease = self->Lease();
            if (lease && current()) reply = self->port->Reconcile(job->candidate, job->mapping, job->space, job->receipt_key, job->receipt_query, *lease, current);
          }
          else {
            std::shared_ptr<SearchSamplingOperation> operation;
            try {
              if(Policy::IsProbe(job->candidate)){
                if(self->port->SupportsProbes()&&job->baseline&&job->baseline->Fingerprint()==job->candidate.probe_reference_fingerprint){
                  const auto probe=self->port->PrepareProbe(*job->frame,job->space,job->lease,job->baseline->values,current);
                  if(probe.distance&&std::isfinite(*probe.distance)&&*probe.distance>=0&&*probe.distance<=2){
                    if(probe.result==SearchSamplingProbePreparation::Result::NoChange&&!probe.operation&&*probe.distance<job->candidate.probe_threshold)no_change=true;
                    if(probe.result==SearchSamplingProbePreparation::Result::Write&&probe.operation&&*probe.distance>=job->candidate.probe_threshold)operation=probe.operation;
                  }
                }
              }else operation = self->port->Prepare(*job->frame, job->space, job->lease, current);
            }
            catch (...) { reply.result = SearchSamplingReceipt::Result::Rejected; }
            if(no_change){/* A real descriptor comparison, no HTTP operation. */}
            else if (!operation || operation->RetainedBytes() > size_t(job->lease.grant->limits.image_max_bytes) + 65536)
              reply.result = SearchSamplingReceipt::Result::Rejected;
            else {
              std::string key, query;
              try { key = operation->ReceiptKey(); query = operation->ReceiptQuery(); }
              catch (...) { reply.result = SearchSamplingReceipt::Result::Rejected; }
              auto descriptor=self->port->SupportsProbes()?self->CopyDescriptor(operation->Descriptor()):nullptr;
              if (!Safe(key) || !ReceiptQueryValid(query,*job)||(self->port->SupportsProbes()&&!descriptor)) reply.result = SearchSamplingReceipt::Result::Rejected;
              else {
                { std::lock_guard<std::mutex> lock(self->mutex);
                  job->receipt_key = std::move(key); job->receipt_query = std::move(query);job->descriptor=std::move(descriptor); }
                if (current()) { write_attempted = true; reply = operation->Submit(current); }
              }
            }
          }
        }
      } catch (...) {
        reply.result = reconcile || write_attempted ? SearchSamplingReceipt::Result::Unknown : SearchSamplingReceipt::Result::Rejected;
        // Fixed outcomes only; never log credentials, exceptions or metadata.
      }
      self->Complete(job, std::move(reply), reconcile,no_change);
      reservation.reset(); // future.get() may be much later than task completion.
    });
    if (!queued) { job->running = false; return false; }
    futures.push_back(std::move(*queued)); return true;
  }
  bool RetainTracks(Source& source, const FrameResult& result) {
    try {
      const auto& tracks = result.model_extra.at("analytics").at("tracks");
      if (!tracks.is_array() || tracks.size() > 1000) return false;
      std::set<std::string> current;
      for (const auto& track : tracks) {
        const auto id = track.at("track_id").get<std::string>();
        if (!Safe(id) || !current.insert(id).second) return false;
      }
      for (auto old=source.tracks.begin();old!=source.tracks.end();) {
        if(current.contains(old->first)){++old;continue;}
        policy.RetireTrack(*source.binding, old->first);
        source.uncertain_tracks.erase(old->first);
        if(source.owed_tracks.erase(old->first))source.owed_lost=true;
        for (auto i = jobs.begin(); i != jobs.end();) {
          if (i->second->source.lock().get() == &source && i->second->candidate.track_id == old->first) {
            coverage.Resolve(i->first,SearchCoverageLedger::Outcome::Failed,SearchCoverageLedger::GapCause::FailTrackGone);
            i->second->cancelled = true; i = jobs.erase(i);
          } else ++i;
        }
        old=source.tracks.erase(old);
      }
      for(const auto& id:current)source.tracks.try_emplace(id,nullptr);
      return true;
    } catch (...) { return false; }
  }
  SearchSamplingOffer Offer(const std::shared_ptr<Source>& source, uint64_t token, const FrameResult& result,
      const SearchFrameCapture& capture, const ainvr::Nv12Frame& borrowed, SearchSamplingPixelRetainer retain,
      const std::string* track, bool usable, std::optional<double> quality, std::optional<double> change,
      const SearchSamplingScene* scene) {
    auto lock=LockBounded(); if (!lock.owns_lock()) return {Status::Busy};
    Reap(); auto ready = Ready(); auto lease = Lease();
    if (stopped || !ready || !lease || lease->grant->package_id != ready->package_id) return {Status::NotReady};
    if (source->retired || source->token != token) return {Status::Stale};
    if (!source->binding || !source->fence) return {Status::NotBound};
    if (!(capture.fence == *source->fence) || !space || !(*space == *ready)) return {Status::Stale};
    auto mapping = lease->grant->sources.find(source->processor);
    if (mapping == lease->grant->sources.end() || !source->mapping || !SameIdentitySource(mapping->second, *source->mapping) ||
        mapping->second.input_stream_id != source->binding->source_input_id ||
        mapping->second.input_path != capture.fence.input_path || mapping->second.output_path != capture.fence.output_path)
      return {Status::Stale};
    const long double ms = static_cast<long double>(capture.captured_wall) * 1000;
    if (!std::isfinite(capture.captured_wall) || ms < 0 || ms > std::numeric_limits<int64_t>::max()) return {Status::Invalid};
    auto frame = Policy::FrameFromResult(result, mapping->second.input_stream_id, int64_t(ms));
    if (!frame || !(frame->binding == *source->binding)) return {Status::Invalid};
    try {
      const auto& reset = result.model_extra.at("analytics").at("view_reset_epoch");
      if (!reset.is_number_integer() || reset < 0 || reset.get<uint64_t>() != capture.fence.view_reset_epoch ||
          result.channel_id != source->processor || result.frame_pts_ns != capture.mapped_pts_ns ||
          result.frame_index != capture.capture_sequence || result.frame_width != capture.fence.observation_width ||
          result.frame_height != capture.fence.observation_height) return {Status::Invalid};
    } catch (...) { return {Status::Invalid}; }
    // Check freshness before retiring IDs: a late frame must not erase tracks
    // which the current authoritative analytics frame still owns.
    const auto highest = source_highest.find(source.get());
    if (highest != source_highest.end()) {
      const auto [pts, index] = highest->second;
      if (result.frame_pts_ns < pts || result.frame_index < index ||
          ((result.frame_pts_ns == pts) != (result.frame_index == index))) return {Status::Stale};
    }
    // Object and scene offers from one immutable result share the authoritative
    // tracker retirement pass. Do not rescan all tracks once per detected box.
    if (highest == source_highest.end() || highest->second.first != result.frame_pts_ns) {
      if (!RetainTracks(*source, result)) return {Status::Invalid};
      source_highest[source.get()] = {result.frame_pts_ns, result.frame_index};
    }
    if (!Configure(*lease->grant)) return {Status::Invalid};
    Policy::Proposal proposal{Policy::Status::Invalid};
    std::shared_ptr<const Descriptor> baseline;
    if (track) {
      if (!mapping->second.object) return {Status::NotEligible};
      auto object = Policy::ObjectFromResult(result, *track, usable, quality, change);
      if(object&&port->SupportsProbes()){
        const auto found=source->tracks.find(*track);
        if(found!=source->tracks.end()&&found->second){baseline=found->second;object->probe_reference_fingerprint=baseline->Fingerprint();}
      }
      if(track&&source->uncertain_tracks.contains(*track))return {Status::NotEligible};
      if (object) proposal = policy.ProposeObject(*frame, *object);
    } else {
      if (!mapping->second.scene) return {Status::NotEligible};
      if(frame->source_pts_ns<=source->retired_scene_pts||frame->source_frame_index<=source->retired_scene_index)
        return {Status::NotDue};
      auto input=*scene;input.probe_reference_fingerprint.clear();
      if(port->SupportsProbes()&&source->scene_descriptor){baseline=source->scene_descriptor;input.probe_reference_fingerprint=baseline->Fingerprint();}
      proposal = policy.ProposeScene(*frame, input);
    }
    if (!proposal.candidate) {
      switch (proposal.status) {
        case Policy::Status::NotDue: return {Status::NotDue};
        case Policy::Status::NotEligible: return {Status::NotEligible};
        case Policy::Status::Busy: return {Status::Busy};
        case Policy::Status::Capacity: return {Status::Capacity};
        case Policy::Status::Pending: {
          for (const auto& [id, job] : jobs) if (job->source.lock() == source && job->candidate.track_id == (track ? *track : ""))
            return {job->needs_reconcile ? Status::NeedsReconcile : Status::Busy, id};
          return {Status::Busy};
        }
        case Policy::Status::StaleFrame: return {Status::Stale};
        default: return {Status::Invalid};
      }
    }
    const auto& candidate = *proposal.candidate;
    const auto scope=CoverageScope(*source,!track);
    const bool covered=!port->CoverageEnabled()||coverage.Plan(scope,frame->captured_ms,CoverageExpiry(frame->captured_ms,*lease->grant),candidate.token,Policy::IsProbe(candidate));
    auto failed = [&] (Status status,SearchCoverageLedger::GapCause cause=SearchCoverageLedger::GapCause::FailOfferInvalid) {
      // Budget/queue pressure defers instead of losing: the policy keeps the slot due and the
      // owed set turns a later loss (track ends before a commit) into an explicit gap.
      const bool defer=cause==SearchCoverageLedger::GapCause::FailBudget||cause==SearchCoverageLedger::GapCause::FailQueue;
      coverage.Resolve(candidate.token,defer?SearchCoverageLedger::Outcome::Deferred:SearchCoverageLedger::Outcome::Failed,cause);
      policy.Resolve(candidate.token, Policy::Outcome::Failed);
      if(defer){++deferred_offers;if(track)source->owed_tracks.insert(*track);else source->owed_scene=true;}
      return SearchSamplingOffer{status,0,defer}; };
    // Missing metadata must never stop evidence sampling. Conservatively mark
    // this observation gap (or leave absent/unknown if no metadata slot exists).
    if(!covered)coverage.Gap(scope,frame->captured_ms,CoverageExpiry(frame->captured_ms,*lease->grant),SearchCoverageLedger::GapCause::PlanUncovered);
    if(Policy::IsProbe(candidate)&&(!baseline||baseline->Fingerprint()!=candidate.probe_reference_fingerprint))return failed(Status::Invalid);
    const auto raw_bytes = SearchFrameRetainedPixelBytes(borrowed);
    if (!raw_bytes || !retain) return failed(Status::Invalid);
    const size_t extra = size_t(lease->grant->limits.image_max_bytes) + 65536;
    if (raw_bytes > std::numeric_limits<size_t>::max() - extra) return failed(Status::Capacity,SearchCoverageLedger::GapCause::FailBudget);
    auto ticket = budget.TryAcquire(raw_bytes + extra); if (!ticket) return failed(Status::Capacity,SearchCoverageLedger::GapCause::FailBudget);
    std::shared_ptr<const ainvr::Nv12Frame> pixels;
    try { pixels = retain(); } catch (...) { return failed(Status::Invalid); }
    if (!pixels || pixels.get() != &borrowed) return failed(Status::Invalid);
    auto frozen = FreezeSearchFrame(*lease, candidate, result, capture, *source->fence, pixels, std::move(*ticket));
    if (!frozen) return failed(Status::Invalid);
    try {
      auto job = std::make_shared<Job>(); job->candidate = candidate; job->mapping = mapping->second;
      job->space = *ready; job->lease = *lease; job->source = source; job->generation = source->generation; job->frame = std::move(frozen.frame);
      jobs.emplace(candidate.token, job);
      if(Policy::IsProbe(candidate))job->baseline=std::move(baseline);
      if (!Queue(job, false)) { jobs.erase(candidate.token); return failed(Status::Capacity,SearchCoverageLedger::GapCause::FailQueue); }
    } catch (...) { jobs.erase(candidate.token); return failed(Status::Capacity,SearchCoverageLedger::GapCause::FailQueue); }
    return {Status::Queued, candidate.token};
  }
  std::map<const Source*,std::pair<int64_t,int64_t>> source_highest;
};
}  // namespace search_owner_detail
using namespace search_owner_detail;
SearchSamplingSource::SearchSamplingSource(std::weak_ptr<State> state, std::shared_ptr<Source> source)
  : state_(std::move(state)), source_(std::move(source)) {}
SearchSamplingSource::~SearchSamplingSource() {
  Reset(); if (auto state = state_.lock()) { std::lock_guard<std::mutex> lock(state->mutex);
    source_->retired = true; auto i = state->sources.find(source_->processor);
    if (i != state->sources.end() && i->second.lock() == source_) state->sources.erase(i);
    state->source_highest.erase(source_.get()); }
}
uint64_t SearchSamplingSource::Token() const noexcept { return source_->token.load(); }
void SearchSamplingSource::Reset() noexcept {
  try { if (auto state = state_.lock()) { std::lock_guard<std::mutex> lock(state->mutex);
    ++source_->token; state->ResetLocked(*source_,State::ResetExplicit); state->source_highest.erase(source_.get()); } }
  catch (...) { ++source_->token; }
}
bool SearchSamplingSource::Bind(uint64_t token, const SearchFrameFence& fence) {
  FrameAttempt attempt(*source_,token);
  // Unsupported projection is not evidence that a known source/session ended.
  // Do not retire acknowledged slots or frozen unknown receipts on refusal.
  if (fence.projection != SearchSourceProjection::RawPlanar) return false;
  auto state = state_.lock(); if (!state) return false;
  auto lock=state->LockBounded(); if (!lock.owns_lock()) return false;
  auto lease = state->Lease(); auto space = state->Ready();
  if (state->stopped || source_->retired || source_->token != token || !lease || !space ||
      lease->grant->package_id != space->package_id || fence.processor_id != source_->processor || !fence.owner_allowed) return false;
  auto mapping = lease->grant->sources.find(source_->processor);
  if (mapping == lease->grant->sources.end() || mapping->second.input_path != fence.input_path || mapping->second.output_path != fence.output_path) return false;
  if (!state->space || !(*state->space == *space)) {
    for (auto& [id, weak] : state->sources) { (void)id; if (auto s = weak.lock()) state->ResetLocked(*s,State::ResetSpace); }
    state->source_highest.clear(); state->space = space;
  }
  SearchSamplingBinding binding{mapping->second.input_stream_id, source_->processor, fence.stream_session_id,
    fence.observation_width, fence.observation_height};
  if (source_->fence && *source_->fence == fence && source_->binding && *source_->binding == binding &&
      source_->mapping && State::SameIdentitySource(*source_->mapping, mapping->second)) {attempt.accepted=true;return true;}
  state->CountFenceChange(source_->fence,fence);state->ResetLocked(*source_,State::ResetFence); state->source_highest.erase(source_.get());
  if (!state->policy.BindSource(binding)) return false;
  source_->fence = fence; source_->binding = binding; source_->mapping = mapping->second;attempt.accepted=true;return true;
}
SearchSamplingOffer SearchSamplingSource::OfferObject(uint64_t token, const FrameResult& result, const SearchFrameCapture& capture,
    const ainvr::Nv12Frame& raw, SearchSamplingPixelRetainer retain, const std::string& track, bool usable,
    std::optional<double> quality, std::optional<double> change) {
  try { auto state = state_.lock(); return state ? state->Counted(state->Offer(source_, token, result, capture, raw, std::move(retain), &track, usable, quality, change, nullptr))
    : SearchSamplingOffer{Status::NotReady}; } catch (...) { return {Status::Capacity}; }
}
SearchSamplingOffer SearchSamplingSource::OfferScene(uint64_t token, const FrameResult& result, const SearchFrameCapture& capture,
    const ainvr::Nv12Frame& raw, SearchSamplingPixelRetainer retain, const SearchSamplingScene& scene) {
  try { auto state = state_.lock(); return state ? state->Counted(state->Offer(source_, token, result, capture, raw, std::move(retain), nullptr, true, {}, {}, &scene))
    : SearchSamplingOffer{Status::NotReady}; } catch (...) { return {Status::Capacity}; }
}
bool SearchSamplingSource::EndFrame(uint64_t token,const FrameResult& result,const SearchFrameCapture& capture,
    bool object_complete,bool scene_complete) {
  FrameAttempt attempt(*source_,token);
  try{
    auto state=state_.lock();if(!state)return false;
    auto lock=state->LockBounded();if(!lock.owns_lock())return false;
    auto lease=state->Lease();auto ready=state->Ready();
    if(state->stopped||!state->port||!state->port->CoverageEnabled()||!lease||!ready||!state->space||!(*ready==*state->space)||
      source_->retired||source_->token!=token||!source_->mapping||!source_->binding||!source_->fence||
      !(capture.fence==*source_->fence)||lease->grant->package_id!=ready->package_id)return false;
    const auto mapping=lease->grant->sources.find(source_->processor);
    if(mapping==lease->grant->sources.end()||!State::SameIdentitySource(mapping->second,*source_->mapping))return false;
    const long double ms=static_cast<long double>(capture.captured_wall)*1000;
    if(!std::isfinite(capture.captured_wall)||ms<0||ms>9007199254740991LL)return false;
    const auto frame=Policy::FrameFromResult(result,mapping->second.input_stream_id,int64_t(ms));
    if(!frame||!(frame->binding==*source_->binding)||result.frame_pts_ns!=capture.mapped_pts_ns||
      result.frame_index!=capture.capture_sequence||result.frame_width!=capture.fence.observation_width||
      result.frame_height!=capture.fence.observation_height||
      result.model_extra.at("analytics").at("view_reset_epoch")!=capture.fence.view_reset_epoch)return false;
    const auto highest=state->source_highest.find(source_.get());
    if(highest!=state->source_highest.end()){
      const auto [pts,index]=highest->second;
      if(result.frame_pts_ns<pts||result.frame_index<index||((result.frame_pts_ns==pts)!=(result.frame_index==index)))return false;
    }
    if(highest==state->source_highest.end()||highest->second.first!=result.frame_pts_ns){
      if(!state->RetainTracks(*source_,result))return false;
      state->source_highest[source_.get()]={result.frame_pts_ns,result.frame_index};
    }
    const auto expiry=State::CoverageExpiry(frame->captured_ms,*lease->grant);bool accepted=true;
    if(source_->owed_lost){source_->owed_lost=false;
      if(mapping->second.object)state->coverage.Gap(state->CoverageScope(*source_,false),frame->captured_ms,expiry,SearchCoverageLedger::GapCause::DeferredTrackLost);}
    const bool temporal=source_->coverage_index>=0&&result.frame_pts_ns>source_->coverage_pts&&
      result.frame_pts_ns-source_->coverage_pts<=1000000000LL&&frame->captured_ms>source_->coverage_ms&&
      frame->captured_ms-source_->coverage_ms<=1000;
    bool adjacent=false;
    if(capture.observation&&source_->coverage_observation)
      adjacent=AdjacentSearchObservations(*source_->coverage_observation,*capture.observation);
    else if(!capture.observation&&!source_->coverage_observation)
      adjacent=source_->coverage_index>=0&&source_->coverage_index<INT64_MAX&&result.frame_index==source_->coverage_index+1;
    const bool consecutive=adjacent&&temporal;
    // A provided scheduler proof cannot silently fall back to raw-frame logic.
    // Missing slots/epochs or omitted EndFrame invalidate the affected window.
    const bool observation_gap=(capture.observation&&(!capture.observation->ordinal||!capture.observation->gap_epoch))||
      (source_->coverage_index>=0&&(capture.observation||source_->coverage_observation)&&!consecutive);
    using Cause=SearchCoverageLedger::GapCause;
    Cause observation_cause=Cause::Unspecified;
    if(observation_gap){
      const auto& now_ticket=capture.observation;const auto& before=source_->coverage_observation;
      if(now_ticket&&(!now_ticket->ordinal||!now_ticket->gap_epoch))observation_cause=Cause::ObsInvalidTicket;
      else if(now_ticket&&before){
        if(before->gap_epoch!=now_ticket->gap_epoch)observation_cause=Cause::ObsEpochChange;
        else if(now_ticket->ordinal!=before->ordinal+1)observation_cause=Cause::ObsOrdinalJump;
        else observation_cause=Cause::ObsTemporalBreak;
      }else if(now_ticket||before)observation_cause=Cause::ObsTicketPresenceChange;
      else observation_cause=Cause::ObsTemporalBreak;
    }
    const auto missed_events=source_->missed_end_events.load();
    const bool hook_gap=source_->missed_end_generation.load()==source_->generation&&
      (missed_events==UINT64_MAX||missed_events!=source_->handled_missed_events);
    for(bool scene:{false,true})if(scene?mapping->second.scene:mapping->second.object){
      const auto scope=state->CoverageScope(*source_,scene);
      const bool eligible=scene?(frame->analytics_status=="active"||frame->analytics_status=="detection_only"):frame->analytics_status=="active";
      if(hook_gap||observation_gap||!eligible||!(scene?scene_complete:object_complete))
        state->coverage.Gap(scope,frame->captured_ms,expiry,hook_gap?Cause::HookMissedEnd:observation_gap?observation_cause:
          !eligible?Cause::Ineligible:Cause::Incomplete);
      const bool complete=scene?scene_complete:object_complete;
      const bool previous_complete=scene?source_->coverage_scene_complete:source_->coverage_object_complete;
      std::optional<int64_t> bridge;
      if(consecutive&&previous_complete&&!hook_gap&&!observation_gap&&eligible&&complete)bridge=source_->coverage_ms+1;
      accepted=state->coverage.EndFrame(scope,frame->captured_ms,expiry,bridge)&&accepted;
    }
    if(accepted){attempt.accepted=true;source_->handled_missed_events=missed_events;
      source_->coverage_index=result.frame_index;source_->coverage_pts=result.frame_pts_ns;source_->coverage_ms=frame->captured_ms;source_->coverage_observation=capture.observation;
      source_->coverage_object_complete=!hook_gap&&!observation_gap&&object_complete&&frame->analytics_status=="active";
      source_->coverage_scene_complete=!hook_gap&&!observation_gap&&scene_complete&&(frame->analytics_status=="active"||frame->analytics_status=="detection_only");}
    return accepted;
  }catch(...){return false;}
}
SearchSamplingOwner::SearchSamplingOwner(config::SearchProducerLeaseReader reader, std::shared_ptr<SearchSamplingExecutionPort> port,
    ArchiveExecutor& executor,std::function<std::chrono::steady_clock::time_point()> clock)
    : state_(std::make_shared<State>(std::move(reader), std::move(port), executor,std::move(clock))) { state_->futures.reserve(4); }
SearchSamplingOwner::~SearchSamplingOwner() { Stop(); }
std::shared_ptr<SearchSamplingSource> SearchSamplingOwner::CreateSource(const std::string& processor) {
  if (!State::Safe(processor)) return {};
  std::lock_guard<std::mutex> lock(state_->mutex); if (state_->stopped) return {};
  auto found = state_->sources.find(processor);
  if (found != state_->sources.end()) if (auto old = found->second.lock()) {
    ++old->token; state_->ResetLocked(*old,State::ResetNewSource); old->retired = true; state_->source_highest.erase(old.get());
  }
  if (found == state_->sources.end() && state_->sources.size() >= 128) return {};
  auto source = std::make_shared<Source>(processor); state_->sources[processor] = source;
  return std::shared_ptr<SearchSamplingSource>(new SearchSamplingSource(state_, std::move(source)));
}
SearchSamplingOffer SearchSamplingOwner::Reconcile(Policy::Token token) {
  std::unique_lock<std::mutex> lock(state_->mutex, std::try_to_lock); if (!lock.owns_lock()) return {Status::Busy};
  state_->Reap(); auto i = state_->jobs.find(token); if (i == state_->jobs.end()) return {Status::Invalid};
  auto job = i->second;
  if (job->running) return {Status::Busy, token};
  if (!job->needs_reconcile || !State::Safe(job->receipt_key) || job->receipt_query.empty() ||
      job->receipt_query.size()>16384 || !state_->CurrentLocked(*job, true)) return {Status::NeedsReconcile, token};
  auto lease = state_->Lease(); if (!lease || !state_->Configure(*lease->grant)) return {Status::NotReady, token};
  auto ticket = state_->budget.TryAcquire(65536); if (!ticket) return {Status::Capacity, token};
  auto retained = std::make_shared<SearchWorkBudget::Ticket>(std::move(*ticket));
  if (!state_->Queue(job, true, std::move(retained))) return {Status::Capacity, token};
  return {Status::Queued, token};
}
SearchSamplingOffer SearchSamplingOwner::ReconcileNext() {
  Policy::Token selected = 0;
  {
    std::unique_lock<std::mutex> lock(state_->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return {Status::Busy};
    state_->Reap();state_->RetireUnknown();
    if (state_->stopped) return {Status::NotReady};
    state_->coverage_turn=!state_->coverage_turn;
    if(state_->coverage_turn&&state_->QueueCoverage())return {Status::Queued};
    if (state_->jobs.empty()) return state_->QueueCoverage()?SearchSamplingOffer{Status::Queued}:SearchSamplingOffer{Status::NotDue};
    auto i = state_->jobs.upper_bound(state_->reconcile_cursor);
    for (size_t count = 0; count < state_->jobs.size(); ++count) {
      if (i == state_->jobs.end()) i = state_->jobs.begin();
      if (i->second->needs_reconcile && !i->second->running) {
        selected = i->first; state_->reconcile_cursor = selected; break;
      }
      ++i;
    }
  }
  // Reset may retire the token between locks. Reconcile revalidates identity,
  // current lease and capacity; an absent/expired receipt never causes a write.
  if(selected)return Reconcile(selected);
  std::unique_lock<std::mutex> lock(state_->mutex,std::try_to_lock);
  return lock.owns_lock()&&state_->QueueCoverage()?SearchSamplingOffer{Status::Queued}:SearchSamplingOffer{Status::NotDue};
}
SearchSamplingOwner::Counters SearchSamplingOwner::Usage() const {
  std::lock_guard<std::mutex> lock(state_->mutex); const auto usage = state_->policy.Usage(); const auto pixels = state_->budget.Inspect();
  size_t reconcile = 0; for (const auto& [id, job] : state_->jobs) { (void)id; reconcile += job->needs_reconcile; }
  return {usage.sources, usage.tracks, usage.pending, reconcile, pixels.jobs, pixels.bytes, state_->stopped,
    state_->descriptor_account->count.load(),state_->descriptor_account->bytes.load(),
    state_->coverage.Size(),state_->coverage.Dropped(),state_->coverage.Untracked(),state_->coverage_failures,state_->retired_unknown,
    state_->coverage.Stats(),state_->deferred_offers,size_t(state_->end_lock_busy.load()),state_->reset_reasons,state_->fence_fields,[&]{std::array<uint64_t,10> a{};for(size_t i=0;i<10;++i)a[i]=state_->offer_status[i].load();return a;}()};
}
std::optional<Policy::TrackSnapshot> SearchSamplingOwner::Inspect(const SearchSamplingBinding& binding, const std::string& track) const {
  return state_->policy.Inspect(binding, track);
}
void SearchSamplingOwner::Stop() noexcept {
  std::vector<std::future<void>> pending;
  try {
    { std::lock_guard<std::mutex> lock(state_->mutex); if (state_->stopped) return;
      state_->stopped = true; state_->budget.Disable();
      for (auto& [id, weak] : state_->sources) { (void)id; if (auto s = weak.lock()) { ++s->token; state_->ResetLocked(*s,State::ResetStop); } }
      state_->jobs.clear(); state_->source_highest.clear(); pending.swap(state_->futures); }
    for (auto& future : pending) { try { future.get(); } catch (...) {} }
  } catch (...) {}
}
}  // namespace ai_service::output
