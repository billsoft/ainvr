// Copyright AINVR. Original business controller with explicit S100P runtime gating.
#include "control_server.hpp"
#include "pipeline/reused_channel_worker.hpp"
#include "output/face_enhancer_bpu.hpp"
#include "licensing/license_client.hpp"
#include "config/config_center_apply.hpp"
#include "config/config_center_client.hpp"
#include "utils/crash_handler.hpp"
#include "utils/systemd_watchdog.hpp"
#include "utils/log.hpp"
#include "platform/bpu.hpp"
#include "output/search_execution_port.hpp"
#include "output/search_observation.hpp"
#include "output/search_producer_http.hpp"
#include "analytics/tracking_cadence.hpp"
#include "analytics/observation_journal.hpp"
#include "search_reencode_handler.hpp"
#include "adapters/detection_decode.hpp"
#include <httplib.h>
#include <atomic>
#include <chrono>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <thread>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
}
namespace cfg = ai_service::config;
namespace lic = ai_service::licensing;
static volatile std::sig_atomic_t stopping = 0;
static void Signal(int) { stopping = 1; }
static constexpr const char* kServiceVersion="ainvr-s100p-reused-control-0.14";
static nlohmann::json FfmpegRuntimeInfo() {
  return {{"version",av_version_info()},{"avformat_version",avformat_version()},
    {"avcodec_version",avcodec_version()},{"avutil_version",avutil_version()}};
}
int main(int argc, char** argv) {
  try {
    ai_service::utils::InstallCrashHandler();
    if(argc==2 && std::string(argv[1])=="--runtime-info") {
      std::cout<<nlohmann::json{{"version",kServiceVersion},
        {"ffmpeg",FfmpegRuntimeInfo()}}.dump()<<'\n';
      return 0;
    }
    if (argc != 5) throw std::runtime_error("usage: ainvr_ai_service CONFIG OVERLAY MODEL_ROOT LICENSE_ENV");
    ai_service::log::EnableWarningFileLog((std::filesystem::path(argv[2]).parent_path()/"diagnostics").string());
    auto store = std::make_shared<cfg::ConfigStore>(argv[1], argv[2]);
    auto config = store->Load();
    // Configuration and bounded retry state stay local; history is stored in MongoDB.
    std::filesystem::current_path(std::filesystem::path(argv[2]).parent_path());
    ai_service::output::RegisterFaceEnhancerBpu(argv[3]);
    ai_service::api::SetLocateAnythingModelRoot(argv[3]);
    if (config.server.host != "127.0.0.1") throw std::runtime_error("Control API must bind loopback");
    if (!config.server.api_key || config.server.api_key->size() < 32)
      throw std::runtime_error("Control API key of at least 32 characters required");
    auto license_config = lic::LoadConfigFromEnv(argv[4]);
    lic::LicenseClient license(license_config, lic::MakeHttpFetcher(license_config));
    license.Start();
    // Preserve the original callback: compare restart requirements with the
    // boot configuration, even if the same changed value was already persisted.
    auto config_client=cfg::ClientFromEnv("ai-service",
      [store,config](const nlohmann::json& patch)->cfg::ApplyResult {
        const auto old_config=store->Load();
        cfg::ValidateSnapshotStoreConnection(old_config,patch);
        cfg::ApplyConfigCenterPatch(*store,patch);
        return {true,cfg::SnapshotStoreRestartRequired(config,patch)};
      });
    // Construct the existing config owner before workers, but start its polling
    // at the same point below. Readers capture weak authority, not this client.
    // One process owner holds the global sampling budget. The affine hardware
    // owner stays idle until an effective, revocable producer grant is present.
    auto search_reader = config_client ? config_client->SearchProducerReader() : cfg::SearchProducerLeaseReader{};
    auto search_hardware = ai_service::output::MakeNativeSearchHardwareOwner();
    auto search_port = ai_service::output::MakeSearchExecutionPort(search_hardware);
    auto search_owner = std::make_shared<ai_service::output::SearchSamplingOwner>(search_reader, search_port);
    std::atomic<uint64_t> search_control_failures{0};
    auto manager = std::make_shared<ai_service::api::ChannelManager>(config, store,
      [model_root=std::string(argv[3])](const cfg::ChannelConfig& ch, const cfg::SnapshotStoreConfig& snapshots) {
        return std::make_shared<ai_service::pipeline::ReusedChannelWorker>(ch,snapshots,model_root);
      }, [&] { return license.IsLicensed(); },
      std::function<void(const cfg::SnapshotStoreConfig&, const std::string&)>{},
      search_reader, search_owner);
    httplib::Server server;
    server.set_pre_routing_handler([](const httplib::Request& q, httplib::Response&) {
      const_cast<httplib::Request&>(q).headers.erase("Accept-Encoding");
      return httplib::Server::HandlerResponse::Unhandled;
    });
    // Raw retained JPEGs use the fixed reencode endpoint. Wrap still limits
    // every ordinary control/configuration request to the previous 1 MiB.
    server.set_payload_max_length(8 * 1024 * 1024);
    server.set_read_timeout(5); server.set_write_timeout(5);
    ai_service::api::RegisterRoutes(server, manager, [&] {
      auto space = std::filesystem::space(std::filesystem::path(argv[2]).parent_path());
      const auto applied=config_client?config_client->AppliedVersion():std::nullopt;
      auto business = manager->BusinessHealth();
      const auto sampling = search_owner->Usage();
      const auto search_space = search_hardware->CurrentSpace();
      business["search_sampling"] = {{"ready", bool(search_space)},
        {"model_version", search_space ? nlohmann::json(search_space->model_version) : nlohmann::json(nullptr)},
        {"pending", sampling.pending}, {"needs_reconcile", sampling.needs_reconcile},
        {"retained_jobs", sampling.retained_jobs}, {"retained_bytes", sampling.retained_bytes},
        {"control_failures", search_control_failures.load()},
        {"coverage_windows",sampling.coverage_windows},{"coverage_dropped",sampling.coverage_dropped},
        {"coverage_untracked",sampling.coverage_untracked},{"coverage_failures",sampling.coverage_failures},
        {"retired_unknown",sampling.retired_unknown}};
      {
        nlohmann::json causes_events=nlohmann::json::object(),causes_windows=nlohmann::json::object();
        for(size_t i=0;i<ai_service::output::SearchCoverageLedger::kGapCauses;++i){
          const auto name=ai_service::output::SearchCoverageLedger::GapCauseName(
            ai_service::output::SearchCoverageLedger::GapCause(i));
          causes_events[name]=sampling.coverage_gap.events[i];causes_windows[name]=sampling.coverage_gap.windows[i];}
        nlohmann::json observation_gaps=nlohmann::json::object();
        auto& counters=ai_service::output::SearchObservationCounters();
        for(size_t i=0;i<size_t(ai_service::output::SearchObservationGapReason::Count);++i)
          observation_gaps[ai_service::output::SearchObservationGapReasonName(ai_service::output::SearchObservationGapReason(i))]=
            counters.gaps[i].load(std::memory_order_relaxed);
        business["search_sampling"]["coverage_gap_events"]=std::move(causes_events);
        business["search_sampling"]["coverage_gap_windows"]=std::move(causes_windows);
        business["search_sampling"]["coverage_windows_reported"]={
          {"sampled",sampling.coverage_gap.reported_sampled},{"gap",sampling.coverage_gap.reported_gap},
          {"pending",sampling.coverage_gap.reported_pending}};
        nlohmann::json observation_slips=nlohmann::json::object();
        for(size_t i=0;i<size_t(ai_service::output::SearchObservationGapReason::Count);++i)
          observation_slips[ai_service::output::SearchObservationGapReasonName(ai_service::output::SearchObservationGapReason(i))]=
            counters.slips[i].load(std::memory_order_relaxed);
        business["search_sampling"]["observation_slips"]=std::move(observation_slips);
        business["search_sampling"]["deferred_offers"]=sampling.deferred_offers;
        business["search_sampling"]["lock_busy_after_bounded_wait"]=sampling.end_frame_lock_busy;
        {static constexpr const char* names[]={"not_ready","not_bound","stale","queued","needs_reconcile","busy","not_due","not_eligible","capacity","invalid"};
          nlohmann::json o=nlohmann::json::object();for(size_t i=0;i<10;++i)o[names[i]]=sampling.offer_status[i];
          business["search_sampling"]["offer_status"]=std::move(o);}
        {static constexpr const char* fields[]={"first_bind","session","paths","source_epoch","stream_generation","view_reset_epoch","dimensions","other"};
          nlohmann::json o=nlohmann::json::object();for(size_t i=0;i<8;++i)o[fields[i]]=sampling.fence_fields[i];
          business["search_sampling"]["fence_change_fields"]=std::move(o);}
        {static constexpr const char* names[]={"invalid","not_monotonic","source_gap_over_1s","wall_gap_over_1s","too_many_intervals","ready_lost_low_rate"};
          nlohmann::json o=nlohmann::json::object();auto& c=ai_service::analytics::CadenceResetCounters();
          for(size_t i=0;i<size_t(ai_service::analytics::CadenceReset::Count);++i)o[names[i]]=c[i].load(std::memory_order_relaxed);
          business["search_sampling"]["tracking_cadence_resets"]=std::move(o);}
        {auto& d=ai_service::analytics::JournalDiag();auto ld=[](const std::atomic<uint64_t>& v){return v.load(std::memory_order_relaxed);};
          business["search_sampling"]["observation_journal_stalls"]={
            {"state_writes",ld(d.state_writes)},{"state_over_250ms",ld(d.state_over_250ms)},{"state_over_1000ms",ld(d.state_over_1000ms)},{"state_max_ms",ld(d.state_max_ms)},
            {"async_failures",ld(d.async_failures)},
            {"record_writes",ld(d.record_writes)},{"record_over_250ms",ld(d.record_over_250ms)},{"record_over_1000ms",ld(d.record_over_1000ms)},{"record_max_ms",ld(d.record_max_ms)}};}
        {static constexpr const char* names[]={"committed","repeated_submit","lease_not_alive","not_attempted_rejected","prewrite_rejected","http_status_0","http_5xx","http_other_non200","lease_lost_after_reply","ack_mismatch","exception","reserved"};
          const auto outcomes=ai_service::output::SearchSubmitOutcomes();nlohmann::json o=nlohmann::json::object();
          for(size_t i=0;i<12;++i)o[names[i]]=outcomes[i];business["search_sampling"]["sample_write_outcomes"]=std::move(o);}
        business["search_sampling"]["source_resets"]={{"explicit",sampling.reset_reasons[0]},{"embedding_space_changed",sampling.reset_reasons[1]},
          {"fence_changed",sampling.reset_reasons[2]},{"new_source",sampling.reset_reasons[3]},{"stop",sampling.reset_reasons[4]}};
        business["search_sampling"]["observation_gaps"]=std::move(observation_gaps);
        business["search_sampling"]["observation_dispatched"]=counters.dispatched.load(std::memory_order_relaxed);
      }
      business["license_phase"] = license.Phase();
      business["license_error"] = license.LastError();
      const auto decode=ainvr::GetDetectionDecodeStats();
      return nlohmann::json{{"version",kServiceVersion},
        {"bpu",{{"healthy",ainvr::BpuRuntimeHealthy()},{"quarantined_bytes",ainvr::BpuQuarantinedBytes()}}},
        {"warning_file_failures",ai_service::log::WarningFileFailures()},
        {"detection_decode",{{"clamped_probabilities",decode.clamped_probabilities},
          {"clamped_distances",decode.clamped_distances},{"rejected_geometry",decode.rejected_geometry}}},
        {"media",{{"ffmpeg",FfmpegRuntimeInfo()}}},
        {"disk_free_bytes",space.free},{"disk_total_bytes",space.capacity},
        {"business",std::move(business)},
        {"config_center",{{"enabled",bool(config_client)},
          {"applied_version",applied?nlohmann::json(*applied):nlohmann::json(nullptr)}}},
        {"capabilities",{{"codecs",{"h264","h265"}},
          {"publish_formats",{"codec12","enhanced"}},
          {"model_providers",{"bpu"}},
          {"model_adapters",{"yolo26_bpu","yoloface_bpu","scrfd_bpu","yoloe_bpu"}},
          {"required_model_provider","bpu"},{"model_manifest_required",true},
          {"snapshot_archive",true},{"sei_publish",true}}}};
    },ai_service::api::MakeSearchReencodeHandler(search_hardware,
      [&]{return license.IsLicensed();},[]{return !stopping;}));
    if(config_client)config_client->Start();
    std::signal(SIGTERM, Signal); std::signal(SIGINT, Signal);
    std::thread control([&] {
      auto next_search_reconcile = std::chrono::steady_clock::now();
      while (!stopping) {
        const bool licensed = license.IsLicensed();
        try {
          search_hardware->Refresh(licensed && search_reader ? search_reader() : std::nullopt);
          const auto now = std::chrono::steady_clock::now();
          if (now >= next_search_reconcile) {
            search_owner->ReconcileNext();
            next_search_reconcile = now + std::chrono::milliseconds(200);
          }
        } catch (...) {
          // Optional search admission cannot stop channel scheduling/recording.
          ++search_control_failures;
        }
        if (licensed) manager->ScheduleAllEnabled();
        else manager->StopAll();
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
      manager->StopAll(); server.stop();
    });
    ai_service::utils::SystemdWatchdog watchdog([&] {
      if(!server.is_running() || !ainvr::BpuRuntimeHealthy())return false;
      httplib::Client probe(config.server.host,config.server.port);
      probe.set_connection_timeout(1,0);probe.set_read_timeout(2,0);probe.set_write_timeout(1,0);
      const auto response=probe.Get("/livez");
      return response&&response->status==200&&response->body=="alive";
    });
    const bool listened = server.listen(config.server.host.c_str(), config.server.port);
    watchdog.Stop();
    if(config_client)config_client->Stop();
    stopping = 1; control.join(); search_owner->Stop(); search_hardware->Stop(); license.Stop();
    return listened ? 0 : 1;
  } catch (const std::exception& e) {
    std::cerr << "AINVR control service: " << e.what() << '\n';
    return 1;
  }
}
