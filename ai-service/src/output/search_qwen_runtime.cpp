#include "output/search_qwen_runtime.hpp"
#include "platform/bpu.hpp"
#include "../../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../../shared/cpp/bpu_dma_buffer.hpp"
#include "../../../shared/cpp/bpu_reserved_pool.hpp"
#include "../../../shared/cpp/embed_ipc.hpp"
#include <unistd.h>
#include <cerrno>

namespace ai_service::output {
namespace {
ainvr::SharedRuntimeCache<QwenEmbeddingRuntime>& QwenModels(){static auto* cache=new ainvr::SharedRuntimeCache<QwenEmbeddingRuntime>();return *cache;}
constexpr uint64_t kHeadroom = 256ULL << 20;
constexpr std::chrono::seconds kKeepAlive{90};

std::string ReadHeld(const ainvr::search::VerifiedPackage& package, const std::string& relative, uint64_t maximum) {
  uint64_t length = 0;
  for (const auto& artifact : package.artifacts) if (artifact.relative_path == relative) length = artifact.bytes;
  if (!length || length > maximum) throw std::runtime_error("search_model_artifact_invalid");
  const int fd = package.BorrowedFileDescriptor(relative);
  std::string out(size_t(length), '\0');
  size_t done = 0;
  while (done < out.size()) {
    const auto n = pread(fd, out.data() + done, out.size() - done, off_t(done));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) throw std::runtime_error("search_model_artifact_unavailable");
    done += size_t(n);
  }
  return out;
}

nlohmann::json Identity(const SearchEmbeddingSpace& space) {
  return {{"package_id", space.package_id}, {"model_version", space.model_version},
          {"dimensions", ainvr::embedding::kEmbeddingDimensions}, {"input_spec_version", space.input_spec_version}};
}
}  // namespace

std::shared_ptr<QwenEmbeddingRuntime> QwenEmbeddingRuntime::Load(const std::string& package_id,
    const std::optional<ainvr::search::RuntimeModelPin>& expected, const SearchSamplingCurrent& current) {
  if (!current || !current()) throw std::runtime_error("search_hardware_stale");
  if (expected && (!ainvr::search::ValidRuntimeModelPin(*expected) || expected->package_id != package_id))
    throw std::runtime_error("search_hardware_model_pin_mismatch");
  std::shared_ptr<QwenEmbeddingRuntime> runtime(new QwenEmbeddingRuntime());
  runtime->package_ = std::make_unique<ainvr::search::VerifiedPackage>(ainvr::search::VerifyPackage(package_id));
  const auto& package = *runtime->package_;
  if (!package.spec || package.spec->kind != ainvr::search::PackageKind::QwenEmbedding)
    throw std::runtime_error("search_hardware_model_pin_mismatch");
  if (expected) {
    const ainvr::search::RuntimeModelPin actual{package.spec->id, package.model_version.substr(10), package.model_version};
    if (!ainvr::search::MatchesRuntimeModelPin(*expected, actual)) throw std::runtime_error("search_hardware_model_pin_mismatch");
  }
  // Verification takes seconds: a stop, expired lease or changed pin meanwhile must not allocate the model.
  if (!current()) throw std::runtime_error("search_hardware_stale");
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  // The reservation precedes every SDK allocation, exactly like the other search encoders.
  ainvr::IonPolicy policy;
  policy.pool_bytes = ainvr::ReadBpuIonBudgetBytes();
  policy.min_free = kHeadroom;
  runtime->reservation_ = std::make_unique<ainvr::BpuCoexistReservation>("/run/ainvr", "search-service", package.spec->reservation_bytes, policy);
  if (!ainvr::search::VerifyStillCurrent(package)) throw std::runtime_error("search_model_artifact_changed");
  ainvr::embedding::EmbeddingFiles files;
  const auto* held = runtime->package_.get();
  files.path = [held](const std::string& relative) { return "/proc/self/fd/" + std::to_string(held->BorrowedFileDescriptor(relative)); };
  files.read = [held](const std::string& relative) { return ReadHeld(*held, relative, 64ULL << 20); };
  runtime->embedder_ = ainvr::embedding::Qwen3VlEmbedder::Load(files);
  if (!ainvr::search::VerifyStillCurrent(package)) throw std::runtime_error("search_model_artifact_changed");
  { ainvr::BpuDmaBuffer headroom(kHeadroom); }   // same-size allocation probe, additional to the byte-accounted policy
  runtime->reservation_->Loaded();
  runtime->space_ = {package_id, package.model_version, package.spec->input_spec_version};
  return runtime;
}

QwenEmbeddingRuntime::~QwenEmbeddingRuntime() {
  if (!ainvr::BpuRuntimeHealthy()) {
    // Unknown task/DMA custody was already quarantined by BpuProgram/BpuPack; keep the reservation and the held
    // descriptors alive for the watchdog, as the SigLIP encoders do.
    (void)embedder_.release();
    (void)package_.release();
    (void)reservation_.release();
  }
}

std::shared_ptr<QwenEmbeddingRuntime> QwenEmbeddingHost::FakeForTest(SearchEmbeddingSpace space) {
  std::shared_ptr<QwenEmbeddingRuntime> runtime(new QwenEmbeddingRuntime());
  runtime->space_ = std::move(space);
  return runtime;
}

QwenEmbeddingHost& QwenEmbeddingHost::Instance() {
  static QwenEmbeddingHost* host = new QwenEmbeddingHost();
  return *host;
}

QwenEmbeddingHost::QwenEmbeddingHost() {
  loader_ = [](const std::string& id, const std::optional<ainvr::search::RuntimeModelPin>& pin, const SearchSamplingCurrent& current) {
    return QwenEmbeddingRuntime::Load(id, pin, current);
  };
  std::thread([this] { ReaperLoop(); }).detach();
}

bool QwenEmbeddingHost::HasOwnersLocked(const std::string& package_id) const {
  const auto now=std::chrono::steady_clock::now();
  for(const auto& [owner,lease]:owners_)
    if(lease.package_id==package_id && lease.expires>now)return true;
  return false;
}

void QwenEmbeddingHost::ReaperLoop() {
  for (;;) {
    std::this_thread::sleep_for(std::chrono::seconds(5));
    std::shared_ptr<QwenEmbeddingRuntime> drop;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const auto now=std::chrono::steady_clock::now();
      for(auto it=owners_.begin();it!=owners_.end();)if(it->second.expires<=now)it=owners_.erase(it);else ++it;
      if (keep_ && !HasOwnersLocked(keep_->Space().package_id)) drop = std::move(keep_);
    }
    drop.reset();   // frees the weights when no sampling session still shares them
  }
}

void QwenEmbeddingHost::ResetForTest() {
  std::lock_guard<std::mutex> lock(mutex_);
  runtime_.reset(); keep_.reset(); owners_.clear(); loading_ = false; error_.clear();
}

std::shared_ptr<QwenEmbeddingRuntime> QwenEmbeddingHost::Loaded() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return runtime_.lock();
}

std::shared_ptr<QwenEmbeddingRuntime> QwenEmbeddingHost::Acquire(const std::string& package_id,
    const std::optional<ainvr::search::RuntimeModelPin>& expected, const SearchSamplingCurrent& current) {
  if(!current||!current())throw std::runtime_error("search_hardware_stale");
  std::lock_guard<std::mutex> load(load_mutex_);   // waits for a background load already in flight
  if(!current())throw std::runtime_error("search_hardware_stale");
  if (auto existing = Loaded()) {
    if (existing->Space().package_id == package_id) {
      if (expected && (expected->model_version != existing->Space().model_version ||
                       expected->package_sha256 != existing->Space().model_version.substr(10)))
        throw std::runtime_error("search_hardware_model_pin_mismatch");
      return existing;
    }
    throw std::runtime_error("search_model_pending"); // old configured/in-flight owner must drain first
  }
  Loader loader;
  { std::lock_guard<std::mutex> lock(mutex_); loader = loader_; }
  // One host slot also serializes destruction across package changes. A weak
  // runtime may expire before the old SDK destructor has returned its ION.
  auto fresh = QwenModels().Acquire("embedding-runtime",[&]{return loader(package_id, expected, current);});
  if(fresh->Space().package_id!=package_id)throw std::runtime_error("search_model_pending");
  if(!current())throw std::runtime_error("search_hardware_stale");
  if(expected&&(expected->model_version!=fresh->Space().model_version||expected->package_sha256!=fresh->Space().model_version.substr(10)))
    throw std::runtime_error("search_hardware_model_pin_mismatch");
  { std::lock_guard<std::mutex> lock(mutex_); runtime_ = fresh; }
  return fresh;
}

void QwenEmbeddingHost::Release(const std::string& owner) {
  std::shared_ptr<QwenEmbeddingRuntime> drop;
  {std::lock_guard<std::mutex> lock(mutex_);owners_.erase(owner);if(keep_&&!HasOwnersLocked(keep_->Space().package_id))drop=std::move(keep_);}
}

QwenEmbeddingHost::Status QwenEmbeddingHost::Ensure(const std::string& package_id, std::chrono::seconds keep, const std::string& owner) {
  std::lock_guard<std::mutex> lock(mutex_);
  if(owner.empty()||owner.size()>128||(!owners_.count(owner)&&owners_.size()>=64))throw std::runtime_error("invalid_request");
  if(auto existing=runtime_.lock();existing&&existing->Space().package_id!=package_id)
    return {false,false,"search_model_pending",{}};
  if(loading_&&loading_package_!=package_id)return {false,false,"search_model_pending",{}};
  const auto now=std::chrono::steady_clock::now();
  if(auto it=owners_.find(owner);it!=owners_.end() && it->second.expires>now && it->second.package_id!=package_id)
    throw std::runtime_error("invalid_request"); // A live lease cannot change model identity.
  owners_[owner]={package_id,now+keep};
  if (auto existing = runtime_.lock(); existing && existing->Space().package_id == package_id) {
    keep_ = existing;
    return {true, false, {}, existing->Space()};
  }
  const std::string previous_error = error_;   // reported with the retry that follows a failed load
  if (!loading_) {
    loading_ = true; error_.clear(); loading_package_ = package_id;
    std::thread([this, package_id] {
      std::shared_ptr<QwenEmbeddingRuntime> runtime;
      std::string error;
      try {
        // Both entry points use the same locked identity check. Revalidate
        // after waiting: another package may have loaded while we were queued.
        runtime = Acquire(package_id, std::nullopt, [this, package_id] {
          std::lock_guard<std::mutex> lock(mutex_);
          return loading_ && loading_package_ == package_id && HasOwnersLocked(package_id);
        });
      } catch (const std::exception& e) { error = std::string(e.what()).substr(0, 64); }
      catch (...) { error = "search_model_load_failed"; }
      std::lock_guard<std::mutex> lock(mutex_);
      if (runtime) { runtime_ = runtime; if(HasOwnersLocked(package_id))keep_ = runtime; }
      error_ = HasOwnersLocked(package_id) ? error : std::string();
      loading_ = false;
    }).detach();
  }
  return {false, true, previous_error, {}};
}

nlohmann::json QwenEmbeddingHost::Handle(const nlohmann::json& request, std::vector<float>& payload) {
  const auto op = request.at("op").get<std::string>();
  const auto package_of = [&]() -> std::string {
    const auto id = request.value("package_id", std::string());
    if (id.empty()) return id;
    if (ainvr::search::FindPackageSpec(id).kind != ainvr::search::PackageKind::QwenEmbedding) throw std::runtime_error("invalid_request");
    return id;
  };
  const auto owner=request.value("lease_id",std::string("legacy"));
  if(op=="release") {if(owner=="legacy")throw std::runtime_error("invalid_request");Release(owner);return {{"released",true}};}
  if (op == "hello") {
    auto runtime = Loaded();
    if (!runtime) throw std::runtime_error("search_model_pending");
    return Identity(runtime->Space());
  }
  if (op == "ensure") {
    const auto id = package_of();
    if (id.empty()) throw std::runtime_error("invalid_request");
    const auto status = Ensure(id, kKeepAlive, owner);
    nlohmann::json header = status.ready ? Identity(status.space) : nlohmann::json::object();
    header["state"] = status.ready ? "ready" : status.loading ? "loading" : "failed";
    if (!status.error.empty()) header["load_error"] = status.error;
    return header;
  }
  if (op != "query") throw std::runtime_error("invalid_request");
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  auto runtime = Loaded();
  if (!runtime) {
    if (const auto id = package_of(); !id.empty()) Ensure(id, kKeepAlive, owner);   // a query after idle unload restarts the load
    throw std::runtime_error("search_model_pending");
  }
  if (const auto requested=package_of(); !requested.empty() && requested!=runtime->Space().package_id)
    throw std::runtime_error("search_model_changed");
  if (const auto expect = request.value("expect", std::string()); !expect.empty() && expect != runtime->Space().model_version)
    throw std::runtime_error("search_model_changed");
  Ensure(runtime->Space().package_id, kKeepAlive, owner);   // queries keep the weights resident
  try {
    payload = runtime->Embedder().EmbedQuery(request.at("text").get<std::string>());
  } catch (const ainvr::embedding::TokenizerError& error) {
    const std::string code = error.what();
    if (code == "tokenizer_invalid_utf8") throw std::runtime_error("query_invalid_utf8");
    if (code == "tokenizer_input_too_large") throw std::runtime_error("query_too_large");
    if (code == "tokenizer_query_too_long") throw std::runtime_error("query_too_long");
    throw std::runtime_error("query_unrepresentable");
  }
  return Identity(runtime->Space());
}

void QwenEmbeddingHost::StartIpc(const std::string& socket_path) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (ipc_) return;
  try {
    ipc_ = std::make_unique<ainvr::EmbedIpcServer>(socket_path, [this](const nlohmann::json& request) {
      ainvr::EmbedIpcReply reply;
      reply.header = Handle(request, reply.payload);
      return reply;
    });
  } catch (const std::exception&) { /* unwritable run directory: in-process use only, queries report model_pending */ }
}

}  // namespace ai_service::output
