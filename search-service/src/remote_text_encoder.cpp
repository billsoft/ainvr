#include "remote_text_encoder.hpp"
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <atomic>
#include <unistd.h>

namespace ainvr::search {
namespace {
[[noreturn]] void Translate(const std::string& code) {
  using Reason = QueryTextError::Reason;
  if (code == "query_invalid_utf8") throw QueryTextError(Reason::InvalidUtf8);
  if (code == "query_too_large") throw QueryTextError(Reason::TooLarge);
  if (code == "query_too_long") throw QueryTextError(Reason::TooLong);
  if (code == "query_unrepresentable" || code == "query_empty") throw QueryTextError(Reason::Unrepresentable);
  if (code == "search_model_pending" || code == "search_model_changed" || code == "search_ipc_failed" ||
      code == "search_bpu_runtime_fault") throw std::runtime_error("search_model_pending");
  if (code == "search_busy") throw std::runtime_error("search_busy");
  throw std::runtime_error("search_encoding_failed");
}
}  // namespace

std::unique_ptr<RemoteTextEncoder> RemoteTextEncoder::Connect(const VerifiedPackage& declared) { return Connect(declared, Options{}); }

std::unique_ptr<RemoteTextEncoder> RemoteTextEncoder::Connect(const VerifiedPackage& declared, const Options& options) {
  if (!declared.files_verified || !declared.spec || declared.spec->kind != PackageKind::QwenEmbedding)
    throw std::runtime_error("search_encoder_identity_invalid");
  return ConnectIdentity(declared.spec->id, declared.model_version, declared.spec->dimensions, options);
}

std::unique_ptr<RemoteTextEncoder> RemoteTextEncoder::ConnectIdentity(const std::string& package_id, const std::string& model_version,
    size_t dimensions, const Options& options) {
  static std::atomic<uint64_t> serial{0};
  const auto lease=std::to_string(getpid())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+"-"+std::to_string(++serial);
  struct Guard {
    const Options& options;const std::string& lease;bool active=true;
    ~Guard(){if(active)try{(void)EmbedIpcCall(options.socket_path,{{"op","release"},{"lease_id",lease}},1000);}catch(...) {}}
  } guard{options,lease};
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(options.load_wait_ms);
  for (;;) {
    EmbedIpcReply reply;
    try { reply = EmbedIpcCall(options.socket_path, {{"op", "ensure"}, {"package_id", package_id}, {"lease_id", lease}}, 5000); }
    catch (const std::runtime_error& error) { Translate(error.what()); }
    catch (const std::exception&) { throw std::runtime_error("search_model_pending"); }
    const auto state = reply.header.value("state", std::string());
    if (state == "ready") {
      if (reply.header.value("model_version", std::string()) != model_version ||
          reply.header.value("package_id", std::string()) != package_id ||
          reply.header.value("dimensions", size_t(0)) != dimensions)
        throw std::runtime_error("search_model_pending");   // the owner is on another vector space (switch in progress)
      break;
    }
    // A reported load error ends the wait: the owner already retries in the background; the service loop retries this encoder.
    if (state != "loading" || reply.header.contains("load_error") || std::chrono::steady_clock::now() >= deadline)
      throw std::runtime_error("search_model_pending");
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  auto encoder=std::unique_ptr<RemoteTextEncoder>(new RemoteTextEncoder(package_id, model_version, dimensions, options, lease));
  guard.active=false;return encoder;
}

RemoteTextEncoder::RemoteTextEncoder(std::string package, std::string version, size_t dimensions, Options options, std::string lease)
    : package_id_(std::move(package)), model_version_(std::move(version)), lease_id_(std::move(lease)), dimensions_(dimensions), options_(std::move(options)) {
  heartbeat_ = std::thread([this] { Heartbeat(); });
}

RemoteTextEncoder::~RemoteTextEncoder() {
  { std::lock_guard<std::mutex> lock(mutex_); stopping_ = true; }
  wake_.notify_all();
  if (heartbeat_.joinable()) heartbeat_.join();
  try{(void)EmbedIpcCall(options_.socket_path,{{"op","release"},{"lease_id",lease_id_}},1000);}catch(...) {}
}

void RemoteTextEncoder::Heartbeat() {
  std::unique_lock<std::mutex> lock(mutex_);
  while (!stopping_) {
    if (wake_.wait_for(lock, std::chrono::milliseconds(options_.heartbeat_ms), [this] { return stopping_; })) break;
    lock.unlock();
    // Also restarts the load after an owner restart, so the first query after it is not the one that waits.
    try { (void)EmbedIpcCall(options_.socket_path, {{"op", "ensure"}, {"package_id", package_id_}, {"lease_id", lease_id_}}, 5000); } catch (...) {}
    lock.lock();
  }
}

std::vector<float> RemoteTextEncoder::Encode(const std::string& text) {
  EmbedIpcReply reply;
  try { reply = EmbedIpcCall(options_.socket_path, {{"op", "query"}, {"text", text}, {"expect", model_version_}, {"package_id", package_id_}, {"lease_id", lease_id_}}, options_.call_timeout_ms); }
  catch (const QueryTextError&) { throw; }
  catch (const std::runtime_error& error) { Translate(error.what()); }
  if (reply.payload.size() != dimensions_) throw std::runtime_error("search_encoding_failed");
  for (float v : reply.payload) if (!std::isfinite(v)) throw std::runtime_error("search_encoding_failed");
  return std::move(reply.payload);
}

}  // namespace ainvr::search
