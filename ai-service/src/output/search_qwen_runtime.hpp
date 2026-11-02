// AINVR. The single owner of the Qwen3-VL-Embedding weights in this process and its local text-query channel.
//
// Two parties want the model: the image sampler (producer lease, owner thread) and search-service (text
// queries). Neither may be a precondition of the other: the producer only starts after search-service pins
// the model, and search-service can only pin after it reached a working text encoder. So the weights are
// loaded on demand by whoever asks first, shared, and released again once nobody wants them:
//   - the sampling session holds a reference while it exists;
//   - search-service keeps the runtime alive with periodic `ensure` requests (and every query);
//   - without any holder the runtime is destroyed ~90 s after the last request and its ION is returned.
#pragma once
#include "embedding/qwen3vl_embedder.hpp"
#include "output/search_sampling_owner.hpp"
#include "../../../search-service/src/model_package.hpp"
#include <nlohmann/json.hpp>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace ainvr { class BpuCoexistReservation; class EmbedIpcServer; }

namespace ai_service::output {

class QwenEmbeddingRuntime {
  friend class QwenEmbeddingHost;
 public:
  // Verifies the package (full hash), checks the optional pin, takes the shared ION reservation, loads the nine
  // HBM packages and probes allocation headroom. Blocking (tens of seconds); throws std::runtime_error codes.
  static std::shared_ptr<QwenEmbeddingRuntime> Load(const std::string& package_id,
      const std::optional<ainvr::search::RuntimeModelPin>& expected, const SearchSamplingCurrent& current);
  ~QwenEmbeddingRuntime();
  QwenEmbeddingRuntime(const QwenEmbeddingRuntime&) = delete;
  QwenEmbeddingRuntime& operator=(const QwenEmbeddingRuntime&) = delete;
  const SearchEmbeddingSpace& Space() const { return space_; }
  ainvr::embedding::Qwen3VlEmbedder& Embedder() { return *embedder_; }
 private:
  QwenEmbeddingRuntime() = default;
  SearchEmbeddingSpace space_;
  // Reverse declaration order is destruction order: embedder, package descriptors, reservation.
  std::unique_ptr<ainvr::BpuCoexistReservation> reservation_;
  std::unique_ptr<ainvr::search::VerifiedPackage> package_;
  std::unique_ptr<ainvr::embedding::Qwen3VlEmbedder> embedder_;
};

class QwenEmbeddingHost {
 public:
  struct Status { bool ready = false, loading = false; std::string error; SearchEmbeddingSpace space; };
  // Process-lifetime object (intentionally never destroyed: BPU/SDK teardown order at exit is not ours to manage).
  static QwenEmbeddingHost& Instance();
  // Starts the local text-query socket; idempotent. A busy or unwritable path leaves the host usable in-process.
  void StartIpc(const std::string& socket_path);
  // Blocking: returns the shared runtime, loading it if no one else already has. Owner-thread (sampling) entry.
  std::shared_ptr<QwenEmbeddingRuntime> Acquire(const std::string& package_id,
      const std::optional<ainvr::search::RuntimeModelPin>& expected, const SearchSamplingCurrent& current);
  // Non-blocking: loads in the background if needed and keeps the runtime for `keep` after the last request.
  Status Ensure(const std::string& package_id, std::chrono::seconds keep);
  std::shared_ptr<QwenEmbeddingRuntime> Loaded() const;
  // Test seam: how a runtime is produced (default QwenEmbeddingRuntime::Load).
  using Loader = std::function<std::shared_ptr<QwenEmbeddingRuntime>(const std::string&,
      const std::optional<ainvr::search::RuntimeModelPin>&, const SearchSamplingCurrent&)>;
  void SetLoaderForTest(Loader loader) { std::lock_guard<std::mutex> lock(mutex_); loader_ = std::move(loader); }
  // Test seam: a runtime with an identity but no weights (host lifecycle tests only; Embedder() is invalid).
  static std::shared_ptr<QwenEmbeddingRuntime> FakeForTest(SearchEmbeddingSpace space);
  // Forget everything (tests).
  void ResetForTest();
 private:
  QwenEmbeddingHost();
  void ReaperLoop();
  nlohmann::json Handle(const nlohmann::json& request, std::vector<float>& payload);
  mutable std::mutex mutex_;                // state below
  std::mutex load_mutex_;                   // one load at a time
  std::weak_ptr<QwenEmbeddingRuntime> runtime_;
  std::shared_ptr<QwenEmbeddingRuntime> keep_;
  std::chrono::steady_clock::time_point keep_until_{};
  bool loading_ = false;
  std::string error_, loading_package_;
  Loader loader_;
  std::unique_ptr<ainvr::EmbedIpcServer> ipc_;
};

}  // namespace ai_service::output
