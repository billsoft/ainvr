// Synthetic bytes and fake acknowledgements only. No model, encoder or HTTP.
#include "output/search_sampling_owner.hpp"
#include "output/search_sampling_metrics.hpp"
#include "../../search-service/src/model_package.hpp"
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <thread>
using namespace ai_service;
using namespace ai_service::output;
using namespace ai_service::config;
using Status = SearchSamplingOffer::Status;
using Reply = SearchSamplingReceipt;
// Fail exactly one allocation on this calling thread. Background work keeps
// its ordinary allocator; the retirement test targets the guard-set insertion.
thread_local bool fail_next_allocation=false;
void* operator new(std::size_t size){
  if(fail_next_allocation){fail_next_allocation=false;throw std::bad_alloc();}
  if(void* allocation=std::malloc(size?size:1))return allocation;
  throw std::bad_alloc();
}
void operator delete(void* allocation) noexcept{std::free(allocation);}
void operator delete(void* allocation,std::size_t) noexcept{std::free(allocation);}
size_t checks = 0;
void Check(bool ok, const char* why) { ++checks; if (!ok) throw std::runtime_error(why); }
template<class F> void Await(F f) {
  auto until = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!f()) { if (std::chrono::steady_clock::now() > until) throw std::runtime_error("software callback timeout");
    std::this_thread::sleep_for(std::chrono::milliseconds(1)); }
}
struct Port: SearchSamplingExecutionPort {
  mutable std::mutex mutex;
  std::condition_variable cv;
  SearchEmbeddingSpace space{"candidate-package", "embedding-v1", "input-v1"};
  Reply::Result answer = Reply::Result::Committed, reconcile_answer = Reply::Result::Committed;
  bool ready = true, block = false, entered = false, fail_prepare = false, throw_submit = false, throw_receipt = false;
  std::optional<std::string> receipt_override;
  std::function<std::string(std::string)> transform_receipt;
  std::function<void(nlohmann::json&)> mutate_receipt;
  std::vector<std::string> prepared_queries, submitted_queries, reconciled_queries;
  std::weak_ptr<const std::vector<uint8_t>> encoded_body;
  size_t submits = 0, reconciles = 0;
  bool coverage_enabled=false,coverage_ack=true,coverage_block=false,coverage_entered=false;
  bool probes_enabled=false;
  std::vector<float> next_descriptor{1,0};
  size_t probes=0;
  std::function<void()> before_ready;
  std::vector<SearchCoverageRange> coverage_ranges;
  std::vector<SearchSamplingPolicy::Candidate> candidates;
  std::optional<SearchEmbeddingSpace> CurrentSpace() const override {
    if(before_ready)before_ready();
    std::lock_guard<std::mutex> lock(mutex); return ready ? std::optional(space) : std::nullopt;
  }
  bool CoverageEnabled()const noexcept override{return coverage_enabled;}
  bool SupportsProbes()const noexcept override{return probes_enabled;}
  bool PublishCoverage(const SearchCoverageRange& range,const SearchProducerLease& lease,const SearchSamplingCurrent& current)override{
    if(!lease.IsCurrent()||!current())return false;
    std::unique_lock<std::mutex> lock(mutex);coverage_entered=true;cv.notify_all();
    cv.wait(lock,[&]{return !coverage_block;});coverage_ranges.push_back(range);return coverage_ack;
  }
  struct Operation: SearchSamplingOperation {
    Port& port;
    const std::string query;
    const std::vector<float> descriptor;
    const std::shared_ptr<const std::vector<uint8_t>> body=std::make_shared<const std::vector<uint8_t>>(100,7);
    Operation(Port& p,std::string q): port(p),query(std::move(q)),descriptor(p.next_descriptor) {}
    std::span<const float> Descriptor()const noexcept override{return descriptor;}
    std::string ReceiptQuery() const override {
      if (port.throw_receipt) throw std::runtime_error("simulated metadata failure");
      return query;
    }
    size_t RetainedBytes() const noexcept override { return 100; }
    std::string ReceiptKey() const override { return "receipt-1"; }
    Reply Submit(const SearchSamplingCurrent& current) override {
      Reply::Result answer;
      { std::unique_lock<std::mutex> lock(port.mutex); port.entered = true; port.cv.notify_all();
        port.cv.wait(lock, [&] { return !port.block; }); answer = port.answer; ++port.submits; port.submitted_queries.push_back(query); }
      if (!current()) return {};
      if (port.throw_submit) throw std::runtime_error("simulated lost transport ACK");
      return {answer, answer == Reply::Result::Committed ? std::string(64, 'a') : "", "receipt-1"};
    }
  };
  std::shared_ptr<SearchSamplingOperation> Prepare(const FrozenSearchFrame& frame, const SearchEmbeddingSpace& actual,
      const SearchProducerLease&, const SearchSamplingCurrent& current) override {
    if (!current()) return {};
    std::lock_guard<std::mutex> lock(mutex);
    if (fail_prepare || !(actual == space)) return {};
    const auto& selected=frame.Selection();const auto& source=frame.Source();
    candidates.push_back(selected);
    const auto unique="00000000-0000-4000-8000-"+std::to_string(100000000000ULL+candidates.size());
    nlohmann::json sample={{"id",unique},{"channel_id",source.channel_id},{"processor_id",source.processor_id},
      {"stream_session_id",selected.frame.binding.stream_session_id},{"track_id",selected.track_id},{"model_version",actual.model_version},
      {"captured_ms",selected.frame.captured_ms},{"expires_ms",selected.frame.captured_ms+60000},{"kind",selected.slot?"object":"scene"},
      {"evidence",{{"source_input_id",source.input_stream_id},{"output_channel_id",source.channel_id},{"recording_channel_id",source.recording_channel_id},
        {"input_path",source.input_path},{"output_path",source.output_path},{"frame_id",unique},{"schema_version","1.0"},
        {"stream_session_id",selected.frame.binding.stream_session_id},{"source_pts_ns",std::to_string(selected.frame.source_pts_ns)},
        {"source_frame_index",std::to_string(selected.frame.source_frame_index)},{"frame_width",8},{"frame_height",4},{"role","match"}}}};
    nlohmann::json query={{"sample",sample},{"request_fingerprint",std::string(64,'c')}};
    if(selected.slot){query["slot"]=*selected.slot;query["replacement_token"]="receipt-1";}
    if(mutate_receipt)mutate_receipt(query);
    auto frozen=receipt_override.value_or(query.dump());if(transform_receipt)frozen=transform_receipt(std::move(frozen));prepared_queries.push_back(frozen);
    auto operation=std::make_shared<Operation>(*this,frozen);encoded_body=operation->body;return operation;
  }
  SearchSamplingProbePreparation PrepareProbe(const FrozenSearchFrame& frame,const SearchEmbeddingSpace& actual,
      const SearchProducerLease& lease,std::span<const float> baseline,const SearchSamplingCurrent& current)override{
    using R=SearchSamplingProbePreparation::Result;
    if(!current()||!lease.IsCurrent())return {};
    std::vector<float> descriptor;
    {std::lock_guard<std::mutex> lock(mutex);++probes;descriptor=next_descriptor;}
    const auto d=SearchAppearanceDistance(descriptor,baseline);if(!d)return {};
    if(*d<frame.Selection().probe_threshold)return {R::NoChange,d,{}};
    return {R::Write,d,Prepare(frame,actual,lease,current)};
  }
  Reply Reconcile(const SearchSamplingPolicy::Candidate&, const SearchProducerSource&, const SearchEmbeddingSpace&,
      const std::string& key, const std::string& query, const SearchProducerLease& lease, const SearchSamplingCurrent& current) override {
    if (!lease.IsCurrent()) return {};
    if (!current()) return {};
    std::lock_guard<std::mutex> lock(mutex); ++reconciles;reconciled_queries.push_back(query);
    return {reconcile_answer, reconcile_answer==Reply::Result::Committed?std::string(64, 'b'):"", key};
  }
  void Release() { { std::lock_guard<std::mutex> lock(mutex); block = false; } cv.notify_all(); }
};
struct Fixture {
  using Json = nlohmann::json;
  const std::string input = "00000000-0000-4000-8000-000000000001", output = "00000000-0000-4000-8000-000000000002";
  std::chrono::steady_clock::time_point now{};
  std::shared_ptr<SearchProducerGrantAuthority> authority;
  std::shared_ptr<ainvr::Nv12Frame> raw = std::make_shared<ainvr::Nv12Frame>();
  SearchFrameCapture capture;
  FrameResult result;
  Json doc;
  Fixture() {
    doc = {{"enabled", true}, {"reason", nullptr}, {"endpoint", "http://127.0.0.1:8400"}, {"api_token", std::string(64, 'b')},
      {"revision", std::string(64, 'a')}, {"model", {{"package_id", "candidate-package"}}}, {"valid_for_ms", 30000},
      {"limits", {{"producer_queue", 1}, {"producer_bytes", 134217728}, {"image_max_bytes", 8388608}, {"retention_days", 30}}},
      {"sampling", {{"mode", "all"}, {"channel_ids", Json::array()}, {"object", true}, {"scene", true}, {"object_interval_ms", 1000},
        {"scene_active_interval_ms", 10000}, {"scene_static_interval_ms", 60000}, {"scene_change_min_interval_ms", 3000}, {"track_slots", 8}}},
      {"sources", Json::array({{{"channel_id", output}, {"input_stream_id", input}, {"processor_id", "processor"},
        {"recording_channel_id", output}, {"input_path", "/live/source"}, {"output_path", "/live/result"}, {"object", true}, {"scene", true}}})}};
    authority = std::make_shared<SearchProducerGrantAuthority>([this] { return now; }); authority->Start(); Renew();
    raw->width = 8; raw->height = 4; raw->pixels.resize(48); raw->pts = 123;
    capture.worker_input_url = "rtmp://127.0.0.1/live/source"; capture.worker_output_url = "rtmp://127.0.0.1/live/result";
    auto& f = capture.fence; f.processor_id = "processor"; f.stream_session_id = "session-1"; f.input_path = "/live/source";
    f.output_path = "/live/result"; f.source_epoch = 1; f.stream_generation = 1; f.view_reset_epoch = 1;
    f.raw_width = f.observation_width = 8; f.raw_height = f.observation_height = 4;
    f.geometry = SearchFrameGeometryKind::FullFrameAxisScale; f.projection = SearchSourceProjection::RawPlanar; f.owner_allowed = true;
    result.channel_id = "processor"; result.stream_url = capture.worker_input_url; result.frame_width = 8; result.frame_height = 4;
    Detection detection; detection.class_name = detection.label_id = "person"; detection.track_id = "track-7";
    detection.bbox = {1, 0, 2, 4}; detection.confidence = .9; result.detections = {detection}; Advance(1);
  }
  void Renew() { Check(authority->Install(ParseSearchProducerGrant(doc), now), "fixture grant rejected"); }
  void Advance(int n, bool scene = false) {
    capture.mapped_pts_ns = result.frame_pts_ns = int64_t(n) * 1000000000;
    capture.capture_sequence = result.frame_index = n; capture.captured_wall = n;
    result.model_extra["analytics"] = {{"status", scene ? "detection_only" : "active"},
      {"stream_session_id", capture.fence.stream_session_id}, {"view_reset_epoch", capture.fence.view_reset_epoch}, {"tracks", Json::array()}};
    if (!scene) result.model_extra["analytics"]["tracks"].push_back({{"track_id", "track-7"}, {"state", "confirmed"},
      {"observation", "detected"}, {"last_observed_pts_ns", std::to_string(result.frame_pts_ns)}});
  }
  SearchProducerLeaseReader Reader() { std::weak_ptr<SearchProducerGrantAuthority> weak = authority;
    return [weak] { auto a = weak.lock(); return a ? a->Read() : std::nullopt; }; }
  SearchSamplingPixelRetainer Retain(int& n) { return [this, &n] { ++n; return raw; }; }
  SearchSamplingBinding Binding() { return {input,"processor",capture.fence.stream_session_id,8,4}; }
};
int main() {
  try {
    ArchiveExecutor executor(1, 8);
    for(int fault=0;fault<=5;++fault){
      Fixture f;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"planned_observation_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000-50;
      const int steps[]={6,1,2,1,7,1,2,7,1,1,2,8,1,1,1,8,1,1,4,6,1,2,4};
      int raw=1;int64_t first_ms=-1;bool crossed=false;
      for(int n=1;n<=201;++n){if(n>1)raw+=steps[(n-2)%23];
        f.Advance(raw);f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
        f.capture.mapped_pts_ns=f.result.frame_pts_ns=int64_t(raw)*33333333;
        f.capture.captured_wall=base+n*.1;
        const auto actual_ms=int64_t(static_cast<long double>(f.capture.captured_wall)*1000);
        if(first_ms<0)first_ms=actual_ms;
        if(actual_ms-first_ms>=10000)crossed=true;
        f.capture.observation=SearchObservationTicket{uint64_t(n+(fault==1&&crossed?1:0)),uint64_t(fault==2&&crossed?2:1)};
        if(fault==3&&crossed){f.capture.captured_wall+=2;f.capture.mapped_pts_ns=f.result.frame_pts_ns+=2000000000;}
        if(fault==4&&n==101)f.result.model_extra["analytics"]["status"]="detection_only";
        if(fault==5&&n==100)continue; // Dispatched observation omitted EndFrame.
        Check(source->EndFrame(token,f.result,f.capture),"planned_observation_end");
      }
      Await([&]{owner.ReconcileNext();return owner.Usage().coverage_windows==0;});
      std::lock_guard<std::mutex> lock(port->mutex);std::vector<SearchCoverageRange> ranges;
      for(const auto& r:port->coverage_ranges)if(!r.scope.scene)ranges.push_back(r);
      std::sort(ranges.begin(),ranges.end(),[](const auto& a,const auto& b){return a.from_ms<b.from_ms;});
      const bool gap=std::any_of(ranges.begin(),ranges.end(),[](const auto& r){return r.state==SearchCoverageRange::State::Gap;});
      if(fault)Check(gap,"lost_observation_epoch_gap_eligibility_or_EndFrame_falsely_sampled");
      else Check(!gap&&ranges.size()==1&&ranges.front().to_ms-ranges.front().from_ms>19000,
        "production_raw_index_steps_created_artificial_sampling_policy_holes");
      using Cause=SearchCoverageLedger::GapCause;
      const auto& causes=owner.Usage().coverage_gap.events;
      if(fault==1)Check(causes[size_t(Cause::ObsOrdinalJump)]>0,"gap_cause_ordinal_jump_attributed");
      if(fault==2)Check(causes[size_t(Cause::ObsEpochChange)]>0,"gap_cause_epoch_change_attributed");
      if(fault==3)Check(causes[size_t(Cause::ObsTemporalBreak)]>0,"gap_cause_time_break_attributed");
      if(fault==4)Check(causes[size_t(Cause::Ineligible)]>0,"gap_cause_ineligible_attributed");
      if(fault==5)Check(causes[size_t(Cause::ObsOrdinalJump)]>0,"gap_cause_missing_end_attributed");
    }
    {
      Fixture f;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"raw_identity_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000-20;
      for(int n=1;n<=2;++n){f.Advance(n==1?1:4);f.capture.mapped_pts_ns=f.result.frame_pts_ns=int64_t(f.result.frame_index)*33333333;f.capture.captured_wall=base+n*.1;
        f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
        f.capture.observation=SearchObservationTicket{uint64_t(n),1};
        Check(source->EndFrame(token,f.result,f.capture),"raw_1_4_processed_1_2");
        Check(f.result.frame_index==(n==1?1:4)&&f.capture.capture_sequence==f.result.frame_index,"proof_replaced_evidence_raw_identity");}
      Await([&]{owner.ReconcileNext();return owner.Usage().coverage_windows==0;});
      std::lock_guard<std::mutex> lock(port->mutex);
      Check(std::all_of(port->coverage_ranges.begin(),port->coverage_ranges.end(),[](const auto& r){return r.state==SearchCoverageRange::State::Sampled;}),
        "planned_1_2_mistaken_for_missing_raw_frames");
    }

    for(bool discontinuity:{false,true}){
      Fixture f;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"continuous_source_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000-40;
      int64_t first_ms=-1;bool crossed=false;
      for(int n=1;n<=610;++n){f.Advance(n);f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
        f.capture.mapped_pts_ns=f.result.frame_pts_ns=int64_t(n)*33000000;
        
        f.capture.captured_wall=base+double(n)*.033;
        const auto actual_ms=int64_t(static_cast<long double>(f.capture.captured_wall)*1000);
        if(first_ms<0)first_ms=actual_ms;
        if(actual_ms-first_ms>=10000)crossed=true;
        if(discontinuity&&crossed)f.capture.capture_sequence=f.result.frame_index=n+5;
        Check(source->EndFrame(token,f.result,f.capture),"continuous_frame_end");
      }
      Await([&]{owner.ReconcileNext();return owner.Usage().coverage_windows==0;});
      std::lock_guard<std::mutex> lock(port->mutex);std::vector<SearchCoverageRange> ranges;
      for(const auto& r:port->coverage_ranges)if(!r.scope.scene)ranges.push_back(r);
      std::sort(ranges.begin(),ranges.end(),[](const auto& a,const auto& b){return a.from_ms<b.from_ms;});
      bool hole=false;for(size_t n=1;n<ranges.size();++n)hole=hole||ranges[n].from_ms>ranges[n-1].to_ms;
      Check(discontinuity?hole:(ranges.size()==1&&ranges[0].to_ms-ranges[0].from_ms>19000),
        "continuous_bridge_swallowed_missing_frame_or_left_artificial_window_hole");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=port->coverage_block=true;
      SearchSamplingOwner owner(f.Reader(),port,executor);
      struct Release{Port& p;~Release(){std::lock_guard<std::mutex> lock(p.mutex);p.coverage_block=false;p.cv.notify_all();}} guard{*port};
      auto source=owner.CreateSource("processor");auto token=source->Token();Check(source->Bind(token,f.capture.fence),"metadata_budget_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000-20;
      f.capture.captured_wall=base;Check(source->EndFrame(token,f.result,f.capture),"metadata_close_first");
      owner.ReconcileNext();Await([&]{std::lock_guard<std::mutex> lock(port->mutex);return port->coverage_entered;});
      f.Advance(12);f.capture.captured_wall=base+11;
      const auto admitted=source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,true,{}});
      Check(admitted.status==Status::Queued,"metadata_report_consumed_single_pixel_producer_ticket");
      Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
    }
    for(bool object:{false,true}){
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->answer=port->reconcile_answer=Reply::Result::Unknown;
      std::chrono::steady_clock::time_point clock{};port->coverage_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port,executor,[&]{return clock;});
      auto source=owner.CreateSource("processor");const auto token=source->Token();Check(source->Bind(token,f.capture.fence),"retire_bind");
      auto offer=[&]{return object?source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.5):
        source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,true,{}});};
      Check(offer().status==Status::Queued,"retire_unknown_initial");Await([&]{return owner.Usage().needs_reconcile==1&&owner.Usage().retained_jobs==0;});
      const auto original=port->submitted_queries.front();clock+=std::chrono::seconds(59);owner.ReconcileNext();
      Await([&]{return owner.Usage().retained_jobs==0;});Check(owner.Usage().retired_unknown==0,"not_found_does_not_reject_early");
      clock+=std::chrono::seconds(1);
      if(object){bool failed=false;fail_next_allocation=true;
        try{owner.ReconcileNext();}catch(const std::bad_alloc&){failed=true;}
        fail_next_allocation=false;
        Check(failed&&owner.Usage().pending==1&&owner.Usage().retired_unknown==0,
          "guard_allocation_failure_dropped_unknown_slot_reservation");
        Check(offer().status==Status::NeedsReconcile,"guard_allocation_failure_restarted_same_object_slot");
      }
      owner.ReconcileNext();Check(owner.Usage().pending==0&&owner.Usage().retired_unknown==1,"bounded_local_retirement");
      {std::lock_guard<std::mutex> lock(port->mutex);port->answer=Reply::Result::Committed;}
      if(!object)Check(offer().status==Status::NotDue,"retirement_retried_same_scene_capture");
      f.Advance(12);
      if(object){Check(offer().status==Status::NotEligible,"unknown_object_slot_restarted_without_authoritative_track_retirement");
        f.Advance(13,true);source->EndFrame(token,f.result,f.capture);f.Advance(14);
        Check(offer().status==Status::Queued,"new_tracker_lifecycle_not_released");}
      else Check(offer().status==Status::Queued,"future_scene_fact_blocked_by_retired_unknown");
      Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
      Check(port->submits==2&&port->submitted_queries.back()!=original,"retirement_resent_frozen_unknown_write");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=true;port->coverage_ack=false;
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"coverage_overflow_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000-100;
      for(int n=1;n<=10;++n){f.Advance(n*11);f.capture.captured_wall=base+n*11;
        const auto admitted=source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,true,{}});
        Check(admitted.status==Status::Queued,"coverage_backlog_refused_sample");
        Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
        source->EndFrame(token,f.result,f.capture);
      }
      Check(port->submits==10&&owner.Usage().coverage_dropped>0&&owner.Usage().coverage_windows<=8,"coverage_backlog_unbounded_or_backpressured_samples");
    }
    {
      // Saturating the archive pool cannot consume default search workers.
      auto gate=std::make_shared<std::promise<void>>();auto release=gate->get_future().share();
      std::vector<std::future<void>> archive;
      for(size_t n=0;n<ArchiveWorkerCount();++n)archive.push_back(SharedArchiveExecutor().Submit([release]{release.wait();}));
      struct Release{std::shared_ptr<std::promise<void>> gate;~Release(){if(gate)gate->set_value();}} guard{gate};
      Fixture f;int retained=0;auto port=std::make_shared<Port>();SearchSamplingOwner owner(f.Reader(),port);
      auto source=owner.CreateSource("processor");auto token=source->Token();Check(source->Bind(token,f.capture.fence),"isolated_executor_bind");
      const auto offered=source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,true,{}});
      Check(offered.status==Status::Queued,"isolated_executor_admission");Await([&]{return owner.Usage().pending==0;});
      gate->set_value();guard.gate.reset();for(auto& task:archive)task.get();
    }
    {
      Fixture f;auto port=std::make_shared<Port>();
      const auto& spec=ainvr::search::FindPackageSpec("siglip2-base-full-int8");
      port->space.package_id=spec.id;port->space.input_spec_version=spec.input_spec_version;
      f.doc["model"]["package_id"]=spec.id;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(spec.input_spec_version.size()>128 && spec.input_spec_version.find(';')!=std::string::npos,"fixture did not use real input contract");
      Check(source->Bind(token,f.capture.fence),"real verified input specification could not bind");
      for(const auto& invalid:std::vector<std::string>{"",std::string(513,'x'),"version\nsecret","version\x7f"}){
        {std::lock_guard<std::mutex> lock(port->mutex);port->space.input_spec_version=invalid;}
        Check(!source->Bind(token,f.capture.fence),"unbounded/control input specification bound");
      }
      {std::lock_guard<std::mutex> lock(port->mutex);port->space.input_spec_version=spec.input_spec_version;}
      Check(source->Bind(token,f.capture.fence),"exact input specification restore failed");
    }
    {
      Fixture f; int retained = 0; SearchSamplingOwner owner(f.Reader(), {}, executor); auto source = owner.CreateSource("processor");
      Check(!source->Bind(source->Token(), f.capture.fence), "missing hardware port bound source");
      Check(source->OfferScene(source->Token(), f.result, f.capture, *f.raw, f.Retain(retained), {true,false,{}}).status == Status::NotReady,
        "default path faked readiness"); Check(retained == 0 && owner.Usage().pending == 0, "not_ready retained frame or candidate");
    }
    {
      Fixture f; int retained = 0; auto port = std::make_shared<Port>(); SearchSamplingOwner owner(f.Reader(),port,executor);
      auto source = owner.CreateSource("processor"); const auto token = source->Token(); Check(source->Bind(token,f.capture.fence),"bind failed");
      auto offer = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.5);
      Check(offer.status == Status::Queued,"first not queued"); Await([&] { return owner.Usage().pending == 0; });
      auto snapshot = owner.Inspect(f.Binding(),"track-7"); Check(snapshot && snapshot->Count() == 1 && snapshot->slots[0],"ACK failed to commit first");
      for(const auto projection:{SearchSourceProjection::ERP,SearchSourceProjection::Unverified}) {
        auto unsupported=f.capture.fence;unsupported.projection=projection;
        Check(!source->Bind(token,unsupported),"unsupported_projection_rebound_acknowledged_source");
        Check(owner.Inspect(f.Binding(),"track-7")->Count()==1,"unsupported_projection_erased_acknowledged_slot");
      }
      Check(source->Bind(token,f.capture.fence)&&owner.Inspect(f.Binding(),"track-7")->Count()==1,
        "return_to_raw_recreated_first_slot");
      f.now += std::chrono::seconds(10); f.Renew(); Check(source->Bind(token,f.capture.fence),"renewal failed bind");
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1,"normal renewal cleared slots");
      f.Advance(2); offer = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.4);
      Check(offer.status == Status::NotDue,"renewal generated another first");
      port->fail_prepare = true;
      offer = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.8);
      Check(offer.status == Status::Queued,"encoding failure fixture not queued"); Await([&] { return owner.Usage().pending == 0; });
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1,"failed encoder consumed best");
      port->fail_prepare = false; port->answer = Reply::Result::Unknown; f.Advance(3);
      offer = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.8);
      Await([&] { const auto usage=owner.Usage();return usage.needs_reconcile==1 && usage.retained_jobs==0; });
      Check(owner.Usage().retained_jobs == 0 && owner.Usage().retained_bytes == 0,"unknown ACK retained raw/encoded budget");
      Check(port->encoded_body.expired(),"unknown ACK retained prepared encoded bytes");
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1,"unknown ACK consumed slot");
      auto unsupported=f.capture.fence;unsupported.projection=SearchSourceProjection::ERP;
      Check(!source->Bind(token,unsupported),"ERP_bound_while_unknown_receipt_pending");
      Check(owner.Usage().pending==1&&owner.Usage().needs_reconcile==1,"ERP_refusal_dropped_unknown_metadata");
      Check(source->Bind(token,f.capture.fence)&&owner.Usage().needs_reconcile==1,
        "return_to_raw_dropped_original_receipt");
      f.Advance(4); auto pending = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.9);
      Check(pending.status == Status::NeedsReconcile && pending.token == offer.token,"unknown changed token/body or generated new first");
      const auto before = port->submits;
      Check(owner.ReconcileNext().status == Status::Queued,"control-tick lookup not queued"); Await([&] { return owner.Usage().pending == 0; });
      Check(port->reconciles == 1 && port->submits == before,"reconcile re-encoded or resubmitted");
      Check(port->reconciled_queries.back()==port->submitted_queries.back() &&
        port->reconciled_queries.back()==port->prepared_queries.back(),"receipt regenerated UUID/expiry/evidence after frame advanced");
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 2,"reconciled ACK not committed");
      f.Advance(5,true); f.result.detections.clear();
      auto scene = source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,false,{}});
      Check(scene.status == Status::Queued,"tracking-disabled scene not queued");
      Await([&] { const auto usage=owner.Usage();return usage.needs_reconcile==1 && usage.retained_jobs==0; });
      Check(!owner.Inspect(f.Binding(),"track-7"),"retired analytics track retained forever");
      source->Reset(); Check(!source->Bind(token,f.capture.fence),"late old token rebound source after reset");
      Check(owner.Usage().pending == 0,"reset left pending metadata");
    }
    {
      Fixture f; int retained = 0; auto port = std::make_shared<Port>(); port->block = true;
      SearchSamplingOwner owner(f.Reader(),port,executor); auto source = owner.CreateSource("processor"); auto token = source->Token();
      Check(source->Bind(token,f.capture.fence),"block fixture bind");
      auto first = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7");
      Await([&] { std::lock_guard<std::mutex> lock(port->mutex); return port->entered; });
      Check(owner.Usage().retained_jobs == 1,"running frame not budgeted");
      auto scene = source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,false,{}});
      Check(scene.status == Status::Capacity && retained == 1,"global queue cap acquired second frame");
      source->Reset(); auto newer = owner.CreateSource("processor"); Check(!source->Bind(source->Token(),f.capture.fence),"superseded handle rebound");
      port->Release(); Await([&] { return owner.Usage().retained_jobs == 0; });
      Check(owner.Reconcile(first.token).status == Status::Invalid,"late ACK resurrected reset pending");
      Check(newer->Bind(newer->Token(),f.capture.fence),"replacement handle could not bind");
      { std::lock_guard<std::mutex> lock(port->mutex); port->space.model_version = "embedding-v2"; }
      Check(newer->OfferScene(newer->Token(),f.result,f.capture,*f.raw,f.Retain(retained),{true,false,{}}).status == Status::Stale,
        "embedding space changed without rebind");
      Check(newer->Bind(newer->Token(),f.capture.fence),"new embedding space bind failed");
      owner.Stop(); Check(!newer->Bind(newer->Token(),f.capture.fence),"stopped owner rebound");
      Check(owner.Usage().retained_bytes == 0,"stop leaked pixels");
    }
    {
      Fixture f; int retained = 0; auto port = std::make_shared<Port>(); port->throw_submit = true;
      SearchSamplingOwner owner(f.Reader(),port,executor); auto source = owner.CreateSource("processor"); auto token = source->Token();
      Check(source->Bind(token,f.capture.fence),"exception fixture bind failed");
      auto first = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7");
      Await([&] { const auto usage=owner.Usage();return usage.needs_reconcile==1 && usage.retained_jobs==0; });
      Check(owner.Usage().retained_bytes == 0,"transport exception retained pixels");
      f.now += std::chrono::seconds(31);
      Check(owner.Reconcile(first.token).status == Status::NeedsReconcile && port->reconciles == 0,
        "expired scope queried old write");
      f.doc["revision"]=std::string(64,'d');f.doc["api_token"]=std::string(64,'e');f.Renew();
      Check(owner.Reconcile(first.token).status == Status::Queued,"pre-submit receipt metadata lost after exception/new credential lease");
      Await([&] { return owner.Usage().pending == 0; });
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1,"reconciled thrown write generated duplicate first");
      Check(port->reconciled_queries.back()==port->submitted_queries.back(),"new lease recomputed old receipt metadata");
      port->throw_submit = false; f.Advance(2);
      // Invalid capture cannot retire the live track or modify its high-water.
      auto malformed = f.result; malformed.model_extra["analytics"]["tracks"] = Fixture::Json::array();
      malformed.frame_pts_ns += 100;
      Check(source->OfferScene(token,malformed,f.capture,*f.raw,f.Retain(retained),{true,false,{}}).status == Status::Invalid,
        "mismatched capture accepted");
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1,"invalid frame retired healthy track");
      { std::lock_guard<std::mutex> lock(port->mutex); port->space.input_spec_version = "input-v2"; }
      Check(source->Bind(token,f.capture.fence),"input space rebind failed");
      Check(!owner.Inspect(f.Binding(),"track-7"),"input spec change carried old-space fingerprint");
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status == Status::Queued,
        "new input space failed first sample"); Await([&] { return owner.Usage().pending == 0; });
    }
    {
      Fixture f, second; int retained = 0; auto port = std::make_shared<Port>(); port->block = true;
      auto mapping = f.doc["sources"][0]; mapping["processor_id"] = "processor2";
      mapping["channel_id"] = mapping["recording_channel_id"] = "00000000-0000-4000-8000-000000000003";
      mapping["output_path"] = "/live/result2"; f.doc["sources"].push_back(mapping); f.doc["revision"] = std::string(64,'c'); f.Renew();
      second.capture.fence.processor_id = second.result.channel_id = "processor2";
      second.capture.fence.output_path = "/live/result2"; second.capture.worker_output_url = "rtmp://127.0.0.1/live/result2";
      second.Advance(1,true); second.result.detections.clear();
      SearchSamplingOwner owner(f.Reader(),port,executor); auto a = owner.CreateSource("processor"), b = owner.CreateSource("processor2");
      Check(a->Bind(a->Token(),f.capture.fence) && b->Bind(b->Token(),second.capture.fence),"shared-source fixture bind failed");
      Check(a->OfferObject(a->Token(),f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status == Status::Queued,
        "first shared job not queued"); Await([&] { std::lock_guard<std::mutex> lock(port->mutex); return port->entered; });
      Check(b->OfferScene(b->Token(),second.result,second.capture,*second.raw,second.Retain(retained),{true,false,{}}).status == Status::Capacity,
        "per-channel budgets bypassed global one-job cap"); Check(retained == 1,"capacity refusal retained second channel raw");
      std::thread stop([&] { owner.Stop(); });
      Await([&] { return owner.Usage().stopped; });
      port->Release(); stop.join();
      Check(owner.Usage().retained_bytes == 0 && owner.Usage().pending == 0,"stop/join leaked callback or pending pixels");
    }
    for (bool change_root : {false,true}) {
      Fixture f; int retained = 0; auto port = std::make_shared<Port>(); port->answer = Reply::Result::Unknown;
      SearchSamplingOwner owner(f.Reader(),port,executor); auto source = owner.CreateSource("processor"); auto token = source->Token();
      Check(source->Bind(token,f.capture.fence),"mapping fixture bind failed");
      auto pending = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7");
      Await([&] { const auto usage=owner.Usage();return usage.needs_reconcile==1 && usage.retained_jobs==0; });
      f.doc["revision"] = std::string(64,'d');
      if (change_root) f.doc["sources"][0]["input_stream_id"] = "00000000-0000-4000-8000-000000000099";
      else f.doc["sources"][0]["channel_id"] = f.doc["sources"][0]["recording_channel_id"] = "00000000-0000-4000-8000-000000000099";
      f.Renew();
      Check(owner.Reconcile(pending.token).status == Status::NeedsReconcile && port->reconciles == 0,
        "changed root/output/recording scope queried old receipt");
      Check(source->Bind(token,f.capture.fence),"new UUID mapping failed to bind same stream path");
      Check(owner.Usage().pending == 0 && !owner.Inspect(f.Binding(),"track-7"),"same-path UUID replacement carried old pending slot");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->answer=Reply::Result::Unknown;
      port->reconcile_answer=Reply::Result::Unknown;
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"not-found fixture bind");
      const auto pending=source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7");
      Await([&]{return owner.Usage().needs_reconcile==1;});
      const auto frozen=port->submitted_queries.back();
      Check(owner.Reconcile(pending.token).status==Status::Queued,"not-found lookup not queued");
      Await([&]{return owner.Usage().retained_jobs==0 && port->reconciles==1;});
      Check(owner.Usage().pending==1 && owner.Usage().needs_reconcile==1 && port->submits==1 && port->candidates.size()==1,
        "not-found treated as rejection or write retry");
      Check(port->reconciled_queries.back()==frozen && owner.Usage().retained_bytes==0,"not-found retained body or changed lookup");
      port->reconcile_answer=Reply::Result::Committed;
      Check(owner.Reconcile(pending.token).status==Status::Queued,"later authoritative lookup not queued");
      Await([&]{return owner.Usage().pending==0;});
      Check(port->submits==1 && port->reconciled_queries.back()==frozen,"receipt retry resubmitted bytes");
    }
    for(int invalid=0;invalid<15;++invalid) {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();
      if(invalid==0)port->receipt_override="";
      else if(invalid==1)port->receipt_override="{broken";
      else if(invalid==2)port->throw_receipt=true;
      else if(invalid==14)port->transform_receipt=[](std::string raw){return std::string("{\"sample\":{\"vector\":[1,2]},")+raw.substr(1);};
      else port->mutate_receipt=[invalid,&f](auto& query){
        if(invalid==3)query["sample"]["evidence"]["padding"]=std::string(17000,'x');
        if(invalid==4)query["sample"]["vector"]={1,2};
        if(invalid==5)query["sample"]["evidence"]["nested"]={{"api_token",std::string(64,'b')}};
        if(invalid==6)query["sample"]["evidence"]["Image"]="encoded-jpeg";
        if(invalid==7)query["sample"]["evidence"]["link"]="http://user:password@camera/live";
        if(invalid==8)query["sample"]["evidence"]["extra"]=f.doc["api_token"];
        if(invalid==9)query["request_fingerprint"]="not-a-hash";
        if(invalid==10)query["sample"]["channel_id"]="00000000-0000-4000-8000-000000000099";
        if(invalid==11){auto* item=&query["sample"]["evidence"]["deep"];for(int i=0;i<12;++i)item=&(*item)["nested"];*item=1;}
        if(invalid==12)query["sample"]["evidence"]["source_pts_ns"]="999999";
        if(invalid==13)query["slot"]=7;
      };
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"bad metadata fixture bind");
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status==Status::Queued,"bad metadata fixture queue");
      Await([&]{const auto usage=owner.Usage();return usage.pending==0 && usage.retained_jobs==0;});
      Check(port->submits==0 && port->reconciles==0,"invalid receipt metadata allowed write");
      const auto snapshot=owner.Inspect(f.Binding(),"track-7");
      Check(owner.Usage().retained_bytes==0 && (!snapshot || snapshot->Count()==0),
        "rejected metadata leaked pixels or consumed slot");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();
      port->mutate_receipt=[](auto& query){
        auto& pad=query["sample"]["evidence"]["padding"];pad=nlohmann::json::array();
        while(query.dump().size()+1005<16384)pad.push_back(std::string(1000,'x'));
        pad.push_back("");pad.back()=std::string(16384-query.dump().size(),'x');
      };
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"metadata boundary bind");
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status==Status::Queued,"metadata boundary queue");
      Await([&]{return owner.Usage().pending==0;});
      Check(port->submitted_queries.size()==1 && port->submitted_queries[0].size()==16384,"valid 16KiB metadata rejected");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();
      port->answer=Reply::Result::Unknown;port->reconcile_answer=Reply::Result::Unknown;
      auto second=f.result.detections.front();second.track_id="track-8";f.result.detections.push_back(second);
      auto extra=f.result.model_extra["analytics"]["tracks"].front();extra["track_id"]="track-8";
      f.result.model_extra["analytics"]["tracks"].push_back(extra);
      SearchSamplingOwner owner(f.Reader(),port,executor);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(owner.ReconcileNext().status==Status::NotDue,"idle tick did not return not_due");
      Check(source->Bind(token,f.capture.fence),"round_robin_bind");
      std::vector<SearchSamplingPolicy::Token> pending;
      for(const char* track:{"track-7","track-8"}) {
        const auto offer=source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),track);
        Check(offer.status==Status::Queued,"round_robin_object_queue");pending.push_back(offer.token);
        Await([&]{const auto u=owner.Usage();return u.needs_reconcile==pending.size()&&u.retained_jobs==0;});
      }
      const auto scene=source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,false,{}});
      Check(scene.status==Status::Queued,"round_robin_scene_queue");pending.push_back(scene.token);
      Await([&]{const auto u=owner.Usage();return u.needs_reconcile==3&&u.retained_jobs==0;});
      for(size_t i=0;i<4;++i) {
        const auto next=owner.ReconcileNext();
        Check(next.status==Status::Queued&&next.token==pending[i%3],"pending_map_round_robin_starved_token");
        Await([&]{return owner.Usage().retained_jobs==0&&port->reconciles==i+1;});
      }
      Check(port->submits==3&&owner.Usage().pending==3,"unknown_auto_tick_resent_or_dropped_pending");
      const auto queries=port->prepared_queries;
      f.now+=std::chrono::seconds(31);
      Check(!source->Bind(token,f.capture.fence),"expired_bind_succeeded");
      const auto before=port->reconciles;
      Check(owner.ReconcileNext().status==Status::NeedsReconcile&&port->reconciles==before,"expired_tick_queried_receipt");
      Check(owner.Usage().pending==3,"temporary_expiry_erased_original_metadata");
      f.Renew();Check(source->Bind(token,f.capture.fence),"same_identity_renewal_bind_failed");
      port->reconcile_answer=Reply::Result::Committed;
      for(size_t count=3;count>0;--count) {
        Check(owner.ReconcileNext().status==Status::Queued,"renewed_tick_not_queued");
        Await([&]{const auto u=owner.Usage();return u.pending==count-1&&u.retained_jobs==0;});
      }
      Check(port->submits==3&&port->prepared_queries==queries,"renewal_recomputed_or_resent_original_write");
      Check(owner.ReconcileNext().status==Status::NotDue,"completed_tick_not_idle");
    }
    {
      ArchiveExecutor saturated(1,1); std::mutex mutex; std::condition_variable cv; bool entered = false, release = false;
      auto blocker = saturated.Submit([&] { std::unique_lock<std::mutex> lock(mutex); entered = true; cv.notify_all();
        cv.wait(lock,[&] { return release; }); });
      Await([&] { std::lock_guard<std::mutex> lock(mutex); return entered; });
      auto queued = saturated.Submit([] {});
      Fixture f; int retained = 0; auto port = std::make_shared<Port>(); SearchSamplingOwner owner(f.Reader(),port,saturated);
      auto source = owner.CreateSource("processor"); auto token = source->Token();
      Check(source->Bind(token,f.capture.fence),"saturated fixture bind");
      const auto failed = source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7");
      Check(failed.status == Status::Capacity && owner.Usage().pending == 0 && owner.Usage().retained_bytes == 0,
        "executor rejection consumed first or retained pixels");
      { std::lock_guard<std::mutex> lock(mutex); release = true; } cv.notify_all(); blocker.get(); queued.get();
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status == Status::Queued,
        "failed admission consumed the same frame's first slot"); Await([&] { return owner.Usage().pending == 0; });
      Check(owner.Inspect(f.Binding(),"track-7")->Count() == 1 && port->candidates.back().slot == 0,
        "admission retry became a different slot");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"coverage_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000;
      f.capture.captured_wall=base;f.result.detections[0].bbox={1,1,1,1};
      auto quality=SearchObjectPixelSupport(f.result.detections[0].bbox,8,4,8,4);
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,quality).status==Status::Queued,"quality_first");
      Await([&]{auto u=owner.Usage();return u.pending==0&&u.retained_jobs==0;});
      Check(source->EndFrame(token,f.result,f.capture),"coverage_first_end_after_early_ack");
      f.Advance(2);f.capture.captured_wall=base+.1;f.result.detections[0].bbox={1,0,6,4};
      quality=SearchObjectPixelSupport(f.result.detections[0].bbox,8,4,8,4);
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,quality).status==Status::Queued,"geometry_best_queued");
      Await([&]{auto u=owner.Usage();return u.pending==0&&u.retained_jobs==0;});
      Check(source->EndFrame(token,f.result,f.capture),"coverage_best_end_after_early_ack");
      Check(owner.Inspect(f.Binding(),"track-7")->Count()==2&&port->candidates.back().slot==1,"real_proxy_best_slot_not_confidence");
      f.Advance(12);f.capture.captured_wall=base+10.1;
      Await([&]{return source->EndFrame(token,f.result,f.capture);});
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      {std::lock_guard<std::mutex> lock(port->mutex);const auto& range=port->coverage_ranges.front();
        Check(range.state==SearchCoverageRange::State::Sampled,"all_real_ack_window_sampled");
        Check(range.to_ms-range.from_ms<=102,"no_unobserved_tail_certified");}
      source->Reset();
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);
        return std::any_of(port->coverage_ranges.begin(),port->coverage_ranges.end(),[](const auto& r){return r.state==SearchCoverageRange::State::Gap;});});
    }
    {// Admission pressure defers a due sample; coverage stays honest in both outcomes.
      ArchiveExecutor saturated(1,1);std::mutex mutex;std::condition_variable cv;bool entered=false,release=false;
      auto blocker=saturated.Submit([&]{std::unique_lock<std::mutex> lock(mutex);entered=true;cv.notify_all();cv.wait(lock,[&]{return release;});});
      Await([&]{std::lock_guard<std::mutex> lock(mutex);return entered;});
      auto queued=saturated.Submit([]{});
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port,saturated);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"deferral_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000;
      f.capture.captured_wall=base;f.result.detections[0].bbox={1,1,1,1};
      const auto quality=SearchObjectPixelSupport(f.result.detections[0].bbox,8,4,8,4);
      const auto first=source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,quality);
      Check(first.status==Status::Capacity&&first.deferred,"executor_full_offer_is_deferred_not_lost");
      Check(source->EndFrame(token,f.result,f.capture,true,true),"deferred_frame_counts_complete");
      Check(owner.Usage().deferred_offers==1,"deferral_counted");
      { std::lock_guard<std::mutex> lock(mutex); release=true; } cv.notify_all(); blocker.get(); queued.get();
      f.Advance(2);f.capture.captured_wall=base+.1;
      f.result.detections[0].bbox={1,1,1,1};
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,quality).status==Status::Queued,"deferred_slot_offered_again");
      Await([&]{auto u=owner.Usage();return u.pending==0&&u.retained_jobs==0;});
      Check(source->EndFrame(token,f.result,f.capture),"owed_commit_end");
      f.Advance(12);f.capture.captured_wall=base+10.1;
      Await([&]{return source->EndFrame(token,f.result,f.capture);});
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      std::lock_guard<std::mutex> lock(port->mutex);const auto& range=port->coverage_ranges.front();
      Check(range.state==SearchCoverageRange::State::Sampled,"deferral_owed_window_state");
      Check(owner.Usage().coverage_gap.events[size_t(SearchCoverageLedger::GapCause::FailBudget)]==0,"deferral_not_counted_as_failure");
    }
    {// Admission pressure defers a due sample; coverage stays honest in both outcomes.
      ArchiveExecutor saturated(1,1);std::mutex mutex;std::condition_variable cv;bool entered=false,release=false;
      auto blocker=saturated.Submit([&]{std::unique_lock<std::mutex> lock(mutex);entered=true;cv.notify_all();cv.wait(lock,[&]{return release;});});
      Await([&]{std::lock_guard<std::mutex> lock(mutex);return entered;});
      auto queued=saturated.Submit([]{});
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port,saturated);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"deferral_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000;
      f.capture.captured_wall=base;f.result.detections[0].bbox={1,1,1,1};
      const auto quality=SearchObjectPixelSupport(f.result.detections[0].bbox,8,4,8,4);
      const auto first=source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,quality);
      Check(first.status==Status::Capacity&&first.deferred,"executor_full_offer_is_deferred_not_lost");
      Check(source->EndFrame(token,f.result,f.capture,true,true),"deferred_frame_counts_complete");
      Check(owner.Usage().deferred_offers==1,"deferral_counted");
      { std::lock_guard<std::mutex> lock(mutex); release=true; } cv.notify_all(); blocker.get(); queued.get();
      f.Advance(2);f.capture.captured_wall=base+.1;
      f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
      Check(source->EndFrame(token,f.result,f.capture),"owed_track_vanished_end");
      f.Advance(12);f.capture.captured_wall=base+10.1;
      Await([&]{return source->EndFrame(token,f.result,f.capture);});
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      std::lock_guard<std::mutex> lock(port->mutex);const auto& range=port->coverage_ranges.front();
      Check(range.state==SearchCoverageRange::State::Gap,"deferral_lost_window_state");
      Check(owner.Usage().coverage_gap.events[size_t(SearchCoverageLedger::GapCause::DeferredTrackLost)]>0,"lost_deferral_attributed");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->coverage_enabled=true;port->fail_prepare=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"reject_coverage_bind");
      f.capture.captured_wall=double(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status==Status::Queued,"reject_coverage_queue");
      Await([&]{return source->EndFrame(token,f.result,f.capture);});Await([&]{return owner.Usage().pending==0;});source->Reset();
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      {std::lock_guard<std::mutex> lock(port->mutex);Check(port->coverage_ranges.front().state==SearchCoverageRange::State::Gap,"encode_failure_is_gap");}
    }
    {
      Fixture f;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"missed_end_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000;
      f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();f.capture.captured_wall=base;
      Check(source->EndFrame(token,f.result,f.capture),"empty_valid_observation");
      std::mutex gate;std::condition_variable changed;bool entered=false,release=false;
      port->before_ready=[&]{std::unique_lock<std::mutex> lock(gate);entered=true;changed.notify_all();changed.wait(lock,[&]{return release;});};
      std::thread locker([&]{source->Bind(token,f.capture.fence);});
      {std::unique_lock<std::mutex> lock(gate);changed.wait(lock,[&]{return entered;});}
      const bool rejected=!source->EndFrame(token,f.result,f.capture);
      {std::lock_guard<std::mutex> lock(gate);release=true;}changed.notify_all();locker.join();port->before_ready={};
      Check(rejected,"owner_lock_contention_reproduced");
      f.Advance(2);f.capture.captured_wall=base+.1;f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
      Check(source->EndFrame(token,f.result,f.capture),"next_frame_under_one_second");
      f.Advance(12);f.capture.captured_wall=base+10.1;f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
      Check(source->EndFrame(token,f.result,f.capture),"missed_hook_close");
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      {std::lock_guard<std::mutex> lock(port->mutex);Check(port->coverage_ranges.front().state==SearchCoverageRange::State::Gap,"lock_missed_hook_not_falsely_sampled");}
    }
    {
      Fixture f;auto port=std::make_shared<Port>();port->coverage_enabled=true;
      f.doc["sampling"]["scene"]=false;f.doc["sources"][0]["scene"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"inactive_tracking_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
      f.Advance(1,true);f.capture.captured_wall=base;Check(source->EndFrame(token,f.result,f.capture),"detection_only_frame_end");
      f.Advance(12,true);f.capture.captured_wall=base+10;Check(source->EndFrame(token,f.result,f.capture),"detection_only_close");
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return !port->coverage_ranges.empty();});
      {std::lock_guard<std::mutex> lock(port->mutex);Check(port->coverage_ranges.front().state==SearchCoverageRange::State::Gap,"disabled_tracking_not_object_coverage");}
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"probe_owner_bind");
      const auto offer=[&]{return source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7",true,.5);};
      Check(offer().status==Status::Queued,"descriptor_first_queue");Await([&]{auto u=owner.Usage();return u.pending==0&&u.retained_jobs==0;});
      Check(owner.Usage().descriptor_count==1&&owner.Usage().descriptor_bytes==2*sizeof(float)+512,"ack_baseline_resident_accounted");
      f.Advance(2);Check(offer().status==Status::Queued,"same_appearance_probe_queue");Await([&]{return owner.Usage().pending==0;});
      Check(port->probes==1&&port->submits==1&&owner.Inspect(f.Binding(),"track-7")->Count()==1,"nochange_did_not_write_or_consume_slot");
      f.Advance(2);
      Check(offer().status==Status::NotDue,"probe_not_every_frame");
      f.Advance(3);{std::lock_guard<std::mutex> lock(port->mutex);port->next_descriptor={0,1};port->answer=Reply::Result::Unknown;}
      const auto unknown=offer();Check(unknown.status==Status::Queued,"changed_probe_queue");
      Await([&]{auto u=owner.Usage();return u.needs_reconcile==1&&u.retained_jobs==0;});
      Check(owner.Usage().descriptor_count==2&&owner.Usage().retained_bytes==0,"unknown_keeps_small_descriptor_not_raw_ticket");
      const auto prepared=port->candidates.size(),submits=port->submits,probes=port->probes;
      {std::lock_guard<std::mutex> lock(port->mutex);port->next_descriptor={-1,0};}
      Check(owner.Reconcile(unknown.token).status==Status::Queued,"unknown_descriptor_lookup");
      Await([&]{return owner.Usage().pending==0;});
      Await([&]{owner.ReconcileNext();return owner.Usage().descriptor_count==1;});
      Check(port->candidates.size()==prepared&&port->submits==submits&&port->probes==probes,"unknown_not_reencoded_or_resubmitted");
      {std::lock_guard<std::mutex> lock(port->mutex);port->next_descriptor={0,1};port->answer=Reply::Result::Committed;}
      f.Advance(4);Check(offer().status==Status::Queued,"reconciled_baseline_probe");Await([&]{return owner.Usage().pending==0;});
      Check(port->submits==submits&&owner.Inspect(f.Binding(),"track-7")->Count()==2,"baseline_updated_only_to_original_unknown_descriptor");
      f.Advance(5);f.result.detections.clear();f.result.model_extra["analytics"]["tracks"]=nlohmann::json::array();
      source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{false,false,{}});
      Await([&]{owner.ReconcileNext();return owner.Usage().descriptor_count==0;});
      Check(owner.Usage().tracks==0,"tracker_retire_clears_descriptor_baseline");source->Reset();
    }
    for(int malformed=0;malformed<4;++malformed){
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=true;
      port->next_descriptor=malformed==0?std::vector<float>{}:malformed==1?std::vector<float>{0,0}:
        malformed==2?std::vector<float>{std::numeric_limits<float>::quiet_NaN(),0}:std::vector<float>(4097,1);
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"invalid_descriptor_bind");
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status==Status::Queued,"invalid_descriptor_admitted");
      Await([&]{auto u=owner.Usage();return u.pending==0&&u.retained_jobs==0;});
      Check(port->submits==0&&owner.Usage().descriptor_count==0&&owner.Usage().descriptor_bytes==0,"invalid_descriptor_wrote_or_leaked");
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=true;
      port->next_descriptor.assign(1152,0);port->next_descriptor[0]=1;
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"1152_resident_bind");
      Check(source->OfferObject(token,f.result,f.capture,*f.raw,f.Retain(retained),"track-7").status==Status::Queued,"1152_descriptor_queue");
      Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
      Check(owner.Usage().descriptor_bytes==1152*sizeof(float)+512,"1152_descriptor_exact_charge");source->Reset();
      Await([&]{owner.ReconcileNext();return owner.Usage().descriptor_count==0&&owner.Usage().descriptor_bytes==0;});
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=true;
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"scene_probe_owner_bind");
      f.Advance(1,true);f.result.detections.clear();
      const auto offer=[&]{return source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,false,{}});};
      Check(offer().status==Status::Queued,"scene_first_descriptor");Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
      Check(owner.Usage().tracks==0&&owner.Usage().descriptor_count==1,"scene_without_object_baseline");
      f.Advance(4,true);Check(offer().status==Status::Queued,"static_scene_probe");Await([&]{return owner.Usage().pending==0;});
      Check(port->probes==1&&port->submits==1,"scene_nochange_no_http_write");
      {std::lock_guard<std::mutex> lock(port->mutex);port->next_descriptor={0,1};}
      f.Advance(7,true);Check(offer().status==Status::Queued,"static_scene_actual_change");Await([&]{return owner.Usage().pending==0;});
      Check(port->submits==2&&port->candidates.back().reason==SearchSamplingPolicy::Reason::SceneProbe,"scene_change_written");
      f.Advance(67,true);Check(offer().status==Status::Queued,"periodic_scene_after_change");Await([&]{return owner.Usage().pending==0;});
      Check(port->submits==3&&port->candidates.back().reason==SearchSamplingPolicy::Reason::SceneInterval,"periodic_scene_remains_valid");
      source->Reset();Await([&]{owner.ReconcileNext();return owner.Usage().descriptor_count==0;});
    }
    {
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=port->coverage_enabled=true;
      f.doc["sampling"]["object"]=false;f.doc["sources"][0]["object"]=false;f.doc["revision"]=std::string(64,'c');f.Renew();
      SearchSamplingOwner owner(f.Reader(),port);auto source=owner.CreateSource("processor");const auto token=source->Token();
      Check(source->Bind(token,f.capture.fence),"slow_scene_bind");
      const auto base=double(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())/1000;
      for(int n=0;n<=20;n+=2){f.Advance(n,true);f.result.detections.front().track_id.clear();f.capture.captured_wall=base+n;
        const auto offer=source->OfferScene(token,f.result,f.capture,*f.raw,f.Retain(retained),{true,true,{}});
        Check(offer.status==Status::Queued||offer.status==Status::NotDue,"slow_scene_offer");
        if(offer.status==Status::Queued)Await([&]{return owner.Usage().pending==0&&owner.Usage().retained_jobs==0;});
        Check(source->EndFrame(token,f.result,f.capture),"slow_scene_explicit_end");
      }
      Check(port->submits==3&&port->probes==4,"slow_scene_actual_time_cadence");
      Await([&]{owner.ReconcileNext();std::lock_guard<std::mutex> lock(port->mutex);return port->coverage_ranges.size()>=2;});
      {std::lock_guard<std::mutex> lock(port->mutex);
        Check(port->coverage_ranges.size()==2&&std::all_of(port->coverage_ranges.begin(),port->coverage_ranges.end(),[](const auto& r){
          return r.state==SearchCoverageRange::State::Sampled&&r.to_ms-r.from_ms<10000;}),"slow_legal_scene_false_gap_or_wallclock_padding");}
    }
    {
      // Four uncertain scene writes consume metadata only. Revoking those kinds
      // must not consume every physical slot or block another authorized source.
      Fixture f;int retained=0;auto port=std::make_shared<Port>();port->probes_enabled=port->coverage_enabled=true;port->answer=Reply::Result::Unknown;
      f.doc["sources"]=nlohmann::json::array();
      for(int i=0;i<5;++i)f.doc["sources"].push_back({{"channel_id","00000000-0000-4000-8000-"+std::string(11,'0')+std::to_string(i+2)},
        {"input_stream_id",f.input},{"processor_id","processor-"+std::to_string(i)},
        {"recording_channel_id","00000000-0000-4000-8000-"+std::string(11,'0')+std::to_string(i+2)},
        {"input_path","/live/source"},{"output_path","/live/result-"+std::to_string(i)},{"object",i==4},{"scene",i<4}});
      f.doc["revision"]=std::string(64,'c');f.Renew();SearchSamplingOwner owner(f.Reader(),port);
      struct Part{SearchFrameCapture capture;FrameResult result;std::shared_ptr<SearchSamplingSource> source;uint64_t token=0,pending=0;};
      std::vector<Part> parts;parts.reserve(5);
      for(int i=0;i<5;++i){
        f.Advance(1,i<4);Part p;p.capture=f.capture;p.result=f.result;
        const auto processor="processor-"+std::to_string(i),session="session-"+std::to_string(i),path="/live/result-"+std::to_string(i);
        p.capture.fence.processor_id=p.result.channel_id=processor;p.capture.fence.stream_session_id=session;
        p.result.model_extra["analytics"]["stream_session_id"]=session;
        p.capture.fence.output_path=path;p.capture.worker_output_url="rtmp://127.0.0.1"+path;
        p.source=owner.CreateSource(processor);p.token=p.source->Token();Check(p.source->Bind(p.token,p.capture.fence),"metadata_sources_bind");
        if(i<4){const auto offered=p.source->OfferScene(p.token,p.result,p.capture,*f.raw,f.Retain(retained),{true,true,{}});
          Check(offered.status==Status::Queued,"uncertain_scene_queue");p.pending=offered.token;
          Await([&]{auto u=owner.Usage();return u.needs_reconcile==size_t(i+1)&&u.retained_jobs==0;});}
        parts.push_back(std::move(p));
      }
      auto& first=parts.front();first.capture.capture_sequence=first.result.frame_index=2;
      first.capture.mapped_pts_ns=first.result.frame_pts_ns=2000000000LL;first.capture.captured_wall=2;
      const auto same=first.source->OfferScene(first.token,first.result,first.capture,*f.raw,f.Retain(retained),{true,true,{}});
      Check(same.status==Status::NeedsReconcile&&same.token==first.pending&&port->submits==4,"uncertain_scene_did_not_keep_original_token");
      for(int i=0;i<4;++i)f.doc["sources"][i]["scene"]=false;
      f.doc["revision"]=std::string(64,'d');f.Renew();
      Check(owner.Reconcile(first.pending).status==Status::NeedsReconcile&&port->reconciles==0,"revoked_receipt_scope_used_or_faked_failed");
      {std::lock_guard<std::mutex> lock(port->mutex);port->answer=Reply::Result::Committed;}
      auto& other=parts.back();const auto offered=other.source->OfferObject(other.token,other.result,other.capture,*f.raw,f.Retain(retained),"track-7",true,.5);
      Check(offered.status==Status::Queued,"revoked_unknown_kind_globally_blocks_other_authorized_source");
      Await([&]{auto u=owner.Usage();return u.pending==4&&u.needs_reconcile==4&&u.retained_jobs==0;});
      Check(port->submits==5&&owner.Usage().descriptor_count==5,"other_source_not_committed_or_uncertain_descriptors_lost");
      const SearchSamplingBinding binding{f.input,"processor-4","session-4",8,4};
      Check(owner.Inspect(binding,"track-7")->Count()==1,"other_authorized_source_first_not_committed");
      Check(first.source->OfferScene(first.token,first.result,first.capture,*f.raw,f.Retain(retained),{true,true,{}}).status==Status::NotEligible&&
        owner.Usage().pending==4&&port->submits==5,"revoked_scene_first_was_recreated");
      owner.Stop();Await([&]{return owner.Usage().descriptor_count==0&&owner.Usage().retained_bytes==0;});
    }
    std::cout << "search sampling owner: " << checks << " software checks passed; hardware/HTTP port remains not_ready by default\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
