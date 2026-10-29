#include "runtime_config.hpp"
#include "model_catalog.hpp"
#include "runtime_text.hpp"
#include "index_runtime.hpp"
#include "source_ingestion_runtime.hpp"
#if defined(AINVR_SEARCH_WITH_BPU_TEXT) && AINVR_SEARCH_WITH_BPU_TEXT
#include "bpu_text_encoder.hpp"
#endif
#include "../../shared/cpp/config_center_client.hpp"
#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <memory>
#include <thread>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
namespace {
using Json = nlohmann::json;
using namespace ainvr::search;
volatile std::sig_atomic_t stopping = 0;
void Stop(int) { stopping = 1; }
constexpr const char* model_root = "/home/sunrise/ainvr/ai-service/models/search";
constexpr bool ProductionTextSupported() {
#if defined(AINVR_SEARCH_WITH_BPU_TEXT) && AINVR_SEARCH_WITH_BPU_TEXT
  return true;
#else
  return false;
#endif
}
RuntimeTextLoader ProductionTextLoader(const EffectiveRuntime& runtime,HistoryMongo& history) {
#if defined(AINVR_SEARCH_WITH_BPU_TEXT) && AINVR_SEARCH_WITH_BPU_TEXT
  return [&runtime,&history](const std::string& id) -> std::unique_ptr<TextEncoder> {
    auto package = VerifyPackage(id);
    const auto version = package.model_version;
    const RuntimeModelPin candidate{id,version.substr(10),version};
    // Real package verification precedes authority checks; authority checks
    // precede every SDK allocation/load. Missing old weights never prevent
    // the independently admitted metadata/original-image recovery routes.
    return LoadAuthorizedRuntimeTextEncoder(runtime,candidate,
      [&](const auto& model){return history.ModelSpaceCompatible(model);},
      [&]()->std::unique_ptr<TextEncoder>{return BpuTextEncoder::Load(std::move(package));});
  };
#else
  (void)runtime;(void)history;
  return {};
#endif
}
// Immutable HTTP generations: stop accepting, drain handlers, then destroy
// history/encoder objects. A hot apply cannot leave requests using freed state.
class Generation {
 public:
  Generation(HttpAccess access, std::unique_ptr<HistoryMongo> history,
             std::unique_ptr<TextEncoder> encoder = nullptr, std::unique_ptr<MatchEngine> engine = nullptr,
             std::unique_ptr<IndexShardFiles> files = nullptr, IndexJobContext index_context = {},
             const Json& bootstrap = Json::object(), size_t dimensions = 0,
             SourceIngestionRuntime::Report source_report = {})
      : history_(std::move(history)), encoder_(std::move(encoder)), engine_(std::move(engine)),
        admitted_(access.admitted), source_admission_(access.source_admission), api_(history_.get(), std::move(access), engine_.get()) {
    if(source_admission_){
      if(!history_)throw std::invalid_argument("source_ingestion_history_required");
      source_runtime_=std::make_unique<SourceIngestionRuntime>(*history_,source_admission_,
        std::set<std::string>(index_context.channels.begin(),index_context.channels.end()),std::move(source_report));
    }
    if (files && history_)
      index_ = std::make_unique<ManagedIndexRuntime>(bootstrap, *history_, engine_.get(), std::move(files),
        std::move(index_context), dimensions, admitted_);
    api_.SetMigrationArtifacts([this](const auto&p,const auto&g){
      if(!index_)throw std::runtime_error("migration_artifacts_unavailable");
      return index_->ActivateMigration(p,g);
    });
    api_.Register(server_);
    if (!server_.bind_to_port("127.0.0.1", 8400)) throw std::runtime_error("search_bind_failed");
    listener_ = std::thread([this] { server_.listen_after_bind(); });
    for (int n = 0; n < 200 && !server_.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    if (!server_.is_running()) { server_.stop(); listener_.join(); throw std::runtime_error("search_listener_failed"); }
  }
  bool RuntimeFaulted() const { return engine_ && !engine_->Healthy(); }
  // Operational gates are intentionally outside the definition revision. Poll
  // them even when the model/config is unchanged, only from verified runtime
  // documents. A failed control call keeps this generation fenced and retries
  // the same report; it must not trigger a model unload/reload loop.
  void ObserveSource(const std::optional<RuntimeIngestionGate>&gate,int64_t wall_ms)noexcept{
    if(!source_runtime_)return;
    try{source_runtime_->Observe(gate,wall_ms);source_error_=false;}
    catch(...){if(!source_error_)std::cerr<<"search_source_fence_pending\n";source_error_=true;}
  }
  ~Generation() {
    Drain();
  }
  // The authorization/config generation still drains fully. A healthy model
  // can outlive it on the same owner thread, without retaining old HTTP grants.
  std::unique_ptr<TextEncoder> TakeEncoder() {
    Drain();engine_.reset();
    return std::move(encoder_);
  }
 private:
  void Drain() {
    if(drained_)return;
    drained_=true;
    if(source_admission_)source_admission_->Seal();
    admitted_->store(false); server_.stop(); if (listener_.joinable()) listener_.join();
    if (index_) index_->Stop(); // drain background users before engine/history destruction
    if(source_runtime_)source_runtime_->Stop();
  }
  bool drained_=false;
  std::unique_ptr<HistoryMongo> history_;
  // Destruction follows listener drain, then engine, then encoder, then Mongo.
  // Load and destruction occur on the managed main thread; Encode is guarded
  // by MatchEngine and BpuTextEncoder's non-queuing mutexes on HTTP workers.
  std::unique_ptr<TextEncoder> encoder_;
  std::unique_ptr<MatchEngine> engine_;
  std::unique_ptr<ManagedIndexRuntime> index_;
  std::shared_ptr<std::atomic<bool>> admitted_;
  std::shared_ptr<SourceAdmission> source_admission_;
  std::unique_ptr<SourceIngestionRuntime> source_runtime_;
  bool source_error_=false;
  HttpService api_;
  httplib::Server server_;
  std::thread listener_;
};
class ProcessLock {
 public:
  ProcessLock() {
    fd_ = open("/run/ainvr/search-service.lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd_ < 0 || flock(fd_, LOCK_EX | LOCK_NB)) { if (fd_ >= 0) close(fd_); throw std::runtime_error("search_writer_already_running"); }
  }
  ~ProcessLock() { close(fd_); }
 private: int fd_ = -1;
};
}  // namespace
int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--models") { std::cout << ModelCatalog(model_root).dump(2) << '\n'; return 0; }
  if (argc != 3 || std::string(argv[1]) != "--managed-config") {
    std::cerr << "Usage: ainvr_search_service --managed-config <private-bootstrap.json> | --models\n"; return 2;
  }
  std::signal(SIGTERM, Stop); std::signal(SIGINT, Stop);
  try {
    const auto bootstrap = ainvr::config::ReadPrivateJson(argv[2]);
    ainvr::config::ConfigTransport config(bootstrap); ProcessLock process_lock;
    const auto management = bootstrap.at("service_token").get<std::string>();
    HttpAccess initial; initial.management_key = management; initial.revision = std::string(64, '0');
    initial.model_catalog = [] { return ModelCatalog(model_root); };
    initial.model_verification = [](const std::string& id) { return VerifyModelProfile(model_root,id); };
    auto generation = std::make_unique<Generation>(initial, nullptr);
    std::string applied_revision; int applied_version = 0;
    auto fresh = std::chrono::steady_clock::now(); bool configured = false;
    auto retry_text_at = std::chrono::steady_clock::time_point::max();
    std::optional<RuntimeModelPin> applied_model;
    while (!stopping) {
      // Unknown vendor task custody latches the process unhealthy. Do not
      // reload a second model in this same poisoned runtime; exit so the
      // bounded service supervisor can restart and release process ownership.
      if (generation && generation->RuntimeFaulted()) {
        std::cerr << "search_bpu_runtime_fault\n";
        return 1;
      }
      int requested_version = 0; std::string requested_revision;
      try {
        auto runtime = ReadEffectiveRuntime(config.RequestAt("/api/internal/search/runtime-config"), management);
        requested_version = runtime.version; requested_revision = runtime.revision;
        fresh = std::chrono::steady_clock::now();
        if (runtime.revision != applied_revision || runtime.version != applied_version || !configured ||
            std::chrono::steady_clock::now() >= retry_text_at) {
          runtime.access.model_catalog = [] { return ModelCatalog(model_root); };
          runtime.access.model_verification = [](const std::string& id) { return VerifyModelProfile(model_root,id); };
          runtime.access.migration_authorization = [&config](const Json& request) {
            return config.RequestAt("/api/internal/search/model-migrations",&request);
          };
          // Close old admission before opening a new Mongo/config generation.
          std::unique_ptr<TextEncoder> retained_encoder;
          const auto desired_pin=runtime.approved_model_transition?
            std::optional<RuntimeModelPin>(runtime.approved_model_transition->target):runtime.active_model_pin;
          if(generation&&applied_model&&desired_pin&&*applied_model==*desired_pin&&applied_model->package_id==runtime.package_id)
            retained_encoder=generation->TakeEncoder();
          generation.reset();
          std::unique_ptr<HistoryMongo> history;
          std::unique_ptr<IndexShardFiles> files;
          std::string error;
          if (runtime.access.enabled && runtime.access.unavailable_reason.empty()) {
            try {
              if (!runtime.index_storage) throw std::runtime_error("search_index_storage_unavailable");
              IndexShardFileLimits file_limits;
              // One file plus the bounded RAM working set can coexist. This
              // quota is a derived cache, distinct from Mongo image retention.
              file_limits.max_records = std::min(size_t(10000), size_t(runtime.budget.max_samples));
              file_limits.max_shard_bytes = 128ULL * 1024 * 1024;
              file_limits.max_temporary_bytes = file_limits.max_shard_bytes + 65536;
              files = IndexShardFiles::OpenProduction(*runtime.index_storage, file_limits);
              history = std::make_unique<HistoryMongo>(runtime.uri, runtime.database, runtime.budget);
              history->Initialize();
            } catch (...) {
              error = files ? "history_unavailable" : "storage_unavailable";
              files.reset(); history.reset(); runtime.access.unavailable_reason = error;
            }
          } else if (runtime.access.enabled) error = runtime.access.unavailable_reason;
          std::unique_ptr<TextEncoder> encoder;
          std::unique_ptr<MatchEngine> engine;
          bool text_ready = false;
          if (history && runtime.access.enabled && runtime.access.unavailable_reason.empty() && ProductionTextSupported()) {
            if (runtime.access.sources.empty() || runtime.access.sources.size() > 1024)
              runtime.access.unavailable_reason = "config_pending";
            try {
              const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::system_clock::now().time_since_epoch()).count();
              // Start a bounded working set; historical discovery and SSD shards
              // must not turn startup into an unbounded full Mongo scan.
              const auto window = RuntimeProjectionWindow(runtime, now);
              if(retained_encoder&&retained_encoder->Healthy()) {
                const RuntimeModelPin candidate{runtime.package_id,retained_encoder->ModelVersion().substr(10),retained_encoder->ModelVersion()};
                RequireRuntimeModelAuthority(runtime,candidate,[&](const auto& model){return history->ModelSpaceCompatible(model);});
                encoder=std::move(retained_encoder);
              } else encoder = LoadConfiguredTextEncoder(runtime, ProductionTextLoader(runtime,*history));
              if (encoder) {
                engine = std::make_unique<MatchEngine>(*history, *encoder,
                    RuntimeProjectionCapacity(runtime, encoder->Dimensions()));
                runtime.access.ingestion_model = encoder->ModelVersion();
                engine->Start(window);
                text_ready = true;
              }
            } catch (...) {
              // A model/resource failure is distinct from configuration ACK.
              // No vendor error, URI or token is exposed; no fallback is used.
              engine.reset();encoder.reset();runtime.access.ingestion_model.clear();
            }
          }
          retry_text_at = runtime.access.enabled && history && ProductionTextSupported() && !text_ready ?
              std::chrono::steady_clock::now() + std::chrono::seconds(30) :
              std::chrono::steady_clock::time_point::max();
          runtime.access.admitted = std::make_shared<std::atomic<bool>>(false);
          IndexJobContext index_context;
          size_t dimensions = 0;
          if (files && history) {
            index_context.revision = runtime.revision;
            index_context.storage_generation = files->StorageGeneration();
            index_context.package_id = runtime.package_id;
            if(encoder&&engine)index_context.model_version = encoder->ModelVersion();
            index_context.retention_days = int(runtime.budget.retention_ms / 86400000);
            for (const auto& source : runtime.access.sources) index_context.channels.push_back(source.first);
            if(encoder&&engine)dimensions = encoder->Dimensions();
          }
          applied_model.reset();
          if(text_ready&&encoder)applied_model=RuntimeModelPin{runtime.package_id,encoder->ModelVersion().substr(10),encoder->ModelVersion()};
          if(history&&!index_context.channels.empty())runtime.access.source_admission=std::make_shared<SourceAdmission>();
          generation = std::make_unique<Generation>(runtime.access, std::move(history), std::move(encoder), std::move(engine),
            std::move(files), std::move(index_context), bootstrap, dimensions,runtime.access.migration_authorization);
          Json state{{"desired_version", runtime.version}, {"revision", runtime.revision}, {"status", error.empty() ? "applied" : "failed"}};
          if (!error.empty()) state["error_code"] = error;
          if(error.empty()&&applied_model)state["active_model"]=RuntimeModelPinJson(*applied_model);
          config.RequestAt("/api/internal/search/runtime-state", &state);
          bool current=error.empty();
          if(current){
            const auto confirmed=ReadEffectiveRuntime(config.RequestAt("/api/internal/search/runtime-config"),management);
            current=RuntimeAckStillCurrent(runtime,confirmed);
            if(current)generation->ObserveSource(confirmed.ingestion_gate,std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::system_clock::now().time_since_epoch()).count());
          }
          runtime.access.admitted->store(current);
          // Failed dependency applies are retried with a bounded poll interval.
          configured = current; applied_revision = runtime.revision; applied_version = runtime.version;
        } else {
          Json state{{"desired_version", runtime.version}, {"revision", runtime.revision}, {"status", "applied"}};
          if(applied_model)state["active_model"]=RuntimeModelPinJson(*applied_model);
          config.RequestAt("/api/internal/search/runtime-state", &state);
          generation->ObserveSource(runtime.ingestion_gate,std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
        }
      } catch (...) {
        // Never keep accepting an obsolete mapping indefinitely during an
        // outage. Secrets, URIs and vendor exception text do not enter logs.
        if (requested_version > 0 && !requested_revision.empty()) {
          // An ACK rejection can mean the desired/dependency revision advanced.
          // Do not expose this unacknowledged generation for even one poll.
          generation.reset(); generation = std::make_unique<Generation>(initial, nullptr); configured = false;
          try { Json state{{"desired_version", requested_version}, {"revision", requested_revision}, {"status", "failed"}, {"error_code", "runtime_apply_failed"}};
            config.RequestAt("/api/internal/search/runtime-state", &state); } catch (...) {}
        }
        if (!generation || std::chrono::steady_clock::now() - fresh > std::chrono::seconds(30)) {
          generation.reset(); generation = std::make_unique<Generation>(initial, nullptr); configured = false;
        }
      }
      for (int n = 0; n < 50 && !stopping; ++n) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  } catch (...) { std::cerr << "search_service_start_failed\n"; return 1; }
  return 0;
}
