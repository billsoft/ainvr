// AINVR. Local text-query channel of the search embedding owner.
// The ai-service process owns every Qwen3-VL-Embedding weight (image sampling and text queries share the
// text groups); search-service never loads a second copy and asks over a 0600 Unix socket inside the
// 0700 /run/ainvr directory. Request: one JSON line. Response: one JSON line, then `payload` raw bytes
// (float32 little-endian, L2-normalised). Operating-system permissions are the authority; there is no token.
#pragma once
#include <nlohmann/json.hpp>
#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace ainvr {

// Fixed rendezvous inside the 0700 /run/ainvr directory (owner: ainvr-ai, client: ainvr-search; same user).
inline constexpr const char* kSearchEmbedSocket = "/run/ainvr/search-embed.sock";

struct EmbedIpcReply {
  nlohmann::json header;
  std::vector<float> payload;
};
// The handler must be thread-safe against the owner thread's image calls and must throw only
// std::runtime_error whose what() is a bounded error code (mapped to {"ok":false,"error":code}).
using EmbedIpcHandler = std::function<EmbedIpcReply(const nlohmann::json& request)>;

class EmbedIpcServer {
 public:
  EmbedIpcServer(std::string socket_path, EmbedIpcHandler handler);
  ~EmbedIpcServer();
  EmbedIpcServer(const EmbedIpcServer&) = delete;
  EmbedIpcServer& operator=(const EmbedIpcServer&) = delete;
  const std::string& Path() const { return path_; }
 private:
  void Serve();
  std::string path_;
  EmbedIpcHandler handler_;
  int listen_fd_ = -1, wake_[2] = {-1, -1};
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

// Client used by search-service and the tests. Throws std::runtime_error with the server error code,
// "search_model_pending" when nobody listens, "search_ipc_failed" for transport faults.
EmbedIpcReply EmbedIpcCall(const std::string& socket_path, const nlohmann::json& request, int timeout_ms);

}  // namespace ainvr
