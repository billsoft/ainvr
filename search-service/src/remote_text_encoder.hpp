// AINVR. Text encoder of the Qwen3-VL-Embedding package: the vectors come from the single weight owner
// (ai-service) over its 0600 local socket. This process never loads a second copy of the model. While the
// encoder exists it asks the owner to keep the weights resident (periodic `ensure`); when search stops
// asking, the owner releases the ION after about 90 s.
#pragma once
#include "http_service.hpp"
#include "model_package.hpp"
#include "../../shared/cpp/embed_ipc.hpp"
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace ainvr::search {

class RemoteTextEncoder final : public TextEncoder {
 public:
  struct Options {
    std::string socket_path = kSearchEmbedSocket;
    int call_timeout_ms = 20000;     // one query
    int load_wait_ms = 120000;       // how long Connect waits for a cold owner to finish loading the weights
    int heartbeat_ms = 20000;
  };
  // The owner must serve exactly this vector space (version string from the declared package identity).
  // An absent or different owner, or a load that does not finish in time, is "search_model_pending" and is
  // retried by the service loop.
  static std::unique_ptr<RemoteTextEncoder> Connect(const VerifiedPackage& declared, const Options& options);
  static std::unique_ptr<RemoteTextEncoder> Connect(const VerifiedPackage& declared);
  // Same handshake from a bare identity (package id, vector-space version, dimensions).
  static std::unique_ptr<RemoteTextEncoder> ConnectIdentity(const std::string& package_id, const std::string& model_version,
      size_t dimensions, const Options& options);
  ~RemoteTextEncoder() override;
  std::string ModelVersion() const override { return model_version_; }
  size_t Dimensions() const override { return dimensions_; }
  // Process-level health only. A restarting owner surfaces per request as model_pending.
  bool Healthy() const override { return true; }
  std::vector<float> Encode(const std::string& text) override;
 private:
  RemoteTextEncoder(std::string package, std::string version, size_t dimensions, Options options);
  void Heartbeat();
  std::string package_id_, model_version_;
  size_t dimensions_;
  Options options_;
  std::mutex mutex_;
  std::condition_variable wake_;
  bool stopping_ = false;
  std::thread heartbeat_;
};

}  // namespace ainvr::search
