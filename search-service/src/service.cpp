#include "runtime_config.hpp"
#include "model_catalog.hpp"
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
// Immutable HTTP generations: stop accepting, drain handlers, then destroy
// history/encoder objects. A hot apply cannot leave requests using freed state.
class Generation {
 public:
  Generation(HttpAccess access, std::unique_ptr<HistoryMongo> history)
      : history_(std::move(history)), api_(history_.get(), std::move(access)) {
    api_.Register(server_);
    if (!server_.bind_to_port("127.0.0.1", 8400)) throw std::runtime_error("search_bind_failed");
    listener_ = std::thread([this] { server_.listen_after_bind(); });
    for (int n = 0; n < 200 && !server_.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    if (!server_.is_running()) { server_.stop(); listener_.join(); throw std::runtime_error("search_listener_failed"); }
  }
  ~Generation() { server_.stop(); if (listener_.joinable()) listener_.join(); }
 private:
  std::unique_ptr<HistoryMongo> history_;
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
    auto generation = std::make_unique<Generation>(initial, nullptr);
    std::string applied_revision; int applied_version = 0;
    auto fresh = std::chrono::steady_clock::now(); bool configured = false;
    while (!stopping) {
      int requested_version = 0; std::string requested_revision;
      try {
        auto runtime = ReadEffectiveRuntime(config.RequestAt("/api/internal/search/runtime-config"), management);
        requested_version = runtime.version; requested_revision = runtime.revision;
        fresh = std::chrono::steady_clock::now();
        if (runtime.revision != applied_revision || runtime.version != applied_version || !configured) {
          runtime.access.model_catalog = [] { return ModelCatalog(model_root); };
          // Close old admission before opening a new Mongo/config generation.
          generation.reset();
          std::unique_ptr<HistoryMongo> history;
          std::string error;
          if (runtime.access.enabled && runtime.access.unavailable_reason.empty()) {
            try {
              history = std::make_unique<HistoryMongo>(runtime.uri, runtime.database, runtime.budget);
              history->Initialize();
            } catch (...) { history.reset(); runtime.access.unavailable_reason = "storage_unavailable"; error = "history_unavailable"; }
          } else if (runtime.access.enabled) error = runtime.access.unavailable_reason;
          runtime.access.admitted = std::make_shared<std::atomic<bool>>(false);
          generation = std::make_unique<Generation>(runtime.access, std::move(history));
          Json state{{"desired_version", runtime.version}, {"revision", runtime.revision}, {"status", error.empty() ? "applied" : "failed"}};
          if (!error.empty()) state["error_code"] = error;
          config.RequestAt("/api/internal/search/runtime-state", &state);
          runtime.access.admitted->store(error.empty());
          // Failed dependency applies are retried with a bounded poll interval.
          configured = error.empty(); applied_revision = runtime.revision; applied_version = runtime.version;
        } else {
          const Json state{{"desired_version", runtime.version}, {"revision", runtime.revision}, {"status", "applied"}};
          config.RequestAt("/api/internal/search/runtime-state", &state);
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
