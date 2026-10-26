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
#include "adapters/detection_decode.hpp"
#include <httplib.h>
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
    auto manager = std::make_shared<ai_service::api::ChannelManager>(config, store,
      [model_root=std::string(argv[3])](const cfg::ChannelConfig& ch, const cfg::SnapshotStoreConfig& snapshots) {
        return std::make_shared<ai_service::pipeline::ReusedChannelWorker>(ch,snapshots,model_root);
      }, [&] { return license.IsLicensed(); });
    // Preserve the original callback: compare restart requirements with the
    // boot configuration, even if the same changed value was already persisted.
    auto config_client=cfg::ClientFromEnv("ai-service",
      [store,config](const nlohmann::json& patch)->cfg::ApplyResult {
        const auto old_config=store->Load();
        cfg::ValidateSnapshotStoreConnection(old_config,patch);
        cfg::ApplyConfigCenterPatch(*store,patch);
        return {true,cfg::SnapshotStoreRestartRequired(config,patch)};
      });
    httplib::Server server;
    server.set_pre_routing_handler([](const httplib::Request& q, httplib::Response&) {
      const_cast<httplib::Request&>(q).headers.erase("Accept-Encoding");
      return httplib::Server::HandlerResponse::Unhandled;
    });
    server.set_payload_max_length(1024 * 1024);
    server.set_read_timeout(5); server.set_write_timeout(5);
    ai_service::api::RegisterRoutes(server, manager, [&] {
      auto space = std::filesystem::space(std::filesystem::path(argv[2]).parent_path());
      const auto applied=config_client?config_client->AppliedVersion():std::nullopt;
      auto business = manager->BusinessHealth();
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
    });
    if(config_client)config_client->Start();
    std::signal(SIGTERM, Signal); std::signal(SIGINT, Signal);
    std::thread control([&] {
      while (!stopping) {
        if (license.IsLicensed()) manager->ScheduleAllEnabled();
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
    stopping = 1; control.join(); license.Stop();
    return listened ? 0 : 1;
  } catch (const std::exception& e) {
    std::cerr << "AINVR control service: " << e.what() << '\n';
    return 1;
  }
}
