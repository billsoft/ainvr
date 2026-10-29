#pragma once
#include "index_projection.hpp"
#include "text_embedding_cache.hpp"
#include "model_migration_authorization.hpp"
#include "source_admission.hpp"
#include <httplib.h>
#include <atomic>
#include <mutex>
#include <map>

namespace ainvr::search {
// Production adapters must execute a verified, paired text HBM on BPU. There is
// deliberately no default embedding, CPU model or automatically selected model.
// Only bounded user-input errors cross the HTTP boundary verbatim.
class QueryTextError final : public std::runtime_error {
 public:
  enum class Reason { InvalidUtf8, TooLarge, TooLong, Unrepresentable };
  explicit QueryTextError(Reason reason) : std::runtime_error("invalid_search_text"), reason_(reason) {}
  const char* Code() const noexcept {
    switch (reason_) {
      case Reason::InvalidUtf8: return "query_invalid_utf8";
      case Reason::TooLarge: return "query_too_large";
      case Reason::TooLong: return "query_too_long";
      case Reason::Unrepresentable: return "query_unrepresentable";
    }
    return "invalid_search_text";
  }
 private:
  Reason reason_;
};
class TextEncoder {
 public:
  virtual ~TextEncoder() = default;
  virtual std::string ModelVersion() const = 0;
  virtual size_t Dimensions() const = 0;
  virtual bool Healthy() const { return true; }
  virtual std::vector<float> Encode(const std::string& text) = 0;
};

class MatchEngine {
 public:
  MatchEngine(HistoryMongo& history, TextEncoder& encoder, size_t capacity);
  void Start(const Scope& window);
  size_t Warm(const std::vector<Record>& records);
  uint64_t CacheEpoch(){return projection_.CacheEpoch();}
  std::optional<uint64_t> Resident(const std::vector<Record>& rows){return projection_.Resident(rows);}
  void Rebuild(const Scope& window);
  void Put(const Sample& sample);
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot, const std::string& expected_fingerprint,
                               const std::string& replacement_token);
  nlohmann::json Match(const std::string& text, const Scope& scope);
  const std::string& ModelVersion() const { return model_; }
  bool Healthy() const { return encoder_.Healthy(); }
  bool Ready() const { return loaded_.load() && Healthy(); }
 private:
  const std::string model_;
  const size_t dimensions_;
  TextEncoder& encoder_;
  IndexProjection projection_;
  BoundedTextEmbeddingCache text_cache_;
  std::mutex inference_;
  std::atomic<bool> loaded_{false};
};

struct ProducerSource {
  std::string input_stream_id, processor_id, recording_channel_id;
  bool object = false, scene = false;
  // Empty only in explicitly constructed legacy test fixtures. Managed runtime
  // configuration requires both actual processor stream paths.
  std::string input_path{}, output_path{};
};
// AINVR's existing channel contract permits 1..128 ASCII app/stream names.
// This is an identity string, never a URL or a filesystem path to execute.
inline bool ValidProducerStreamPath(const std::string& path) {
  if (path.size() < 4 || path.size() > 258 || path.front() != '/') return false;
  const auto divider = path.find('/', 1);
  if (divider == std::string::npos || divider < 2 || divider > 129 || path.size() - divider - 1 < 1 ||
      path.size() - divider - 1 > 128 || path.find('/', divider + 1) != std::string::npos) return false;
  for (size_t index = 1; index < path.size(); ++index) {
    if (index == divider) continue;
    const auto c = static_cast<unsigned char>(path[index]);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
  }
  return true;
}
struct HttpAccess {
  std::string console_key, producer_key, management_key, revision;
  bool enabled = false;
  std::shared_ptr<std::atomic<bool>> admitted = std::make_shared<std::atomic<bool>>(true);
  // Production binds its durable source-writer controller; legacy in-process
  // fixtures leave this null and cannot advertise a wired ingestion fence.
  std::shared_ptr<SourceAdmission> source_admission;
  std::string unavailable_reason = "config_pending";
  std::string ingestion_model;
  std::map<std::string, ProducerSource> sources;
  std::function<nlohmann::json()> model_catalog = [] {
    return nlohmann::json{{"items", nlohmann::json::array()}, {"service_ready", true}, {"reason", nullptr}};
  };
  std::function<nlohmann::json(const std::string&)> model_verification = [](const std::string&) -> nlohmann::json {
    throw std::runtime_error("search_model_pending");
  };
  // Uses the existing authenticated config-center transport and fixed worker
  // route. The HTTP caller supplies work identity, never an authority callback.
  std::function<nlohmann::json(const nlohmann::json&)> migration_authorization = [](const nlohmann::json&) {
    return nlohmann::json{{"grant",nullptr}};
  };
  int64_t search_ttl_s = 3600;
  size_t workers = 4, queue = 4, image_max_bytes = 8 * 1024 * 1024;
};

// Internal authenticated transport. The owner binds only to loopback and owns
// service configuration, BPU admission and the single-writer process lifetime.
// These are compute/storage operations, not a second user/job/session authority.
class HttpService {
 public:
  HttpService(HistoryMongo* history, HttpAccess access, MatchEngine* engine = nullptr);
  void Register(httplib::Server& server);
  // Bound once before Register; the existing maintenance owner performs work.
  void SetMigrationArtifacts(std::function<nlohmann::json(const MigrationWriteProof&,const MigrationWriteGrant&)> callback){migration_artifacts_=std::move(callback);}
 private:
  std::optional<SourceAdmission::Permit> EnterSourceWrite();
  bool AllowedSample(const Sample& sample) const;
  HistoryMongo* history_;
  const HttpAccess access_;
  MatchEngine* engine_;
  std::mutex model_verification_mutex_;
  std::mutex migration_write_mutex_;
  std::function<nlohmann::json(const MigrationWriteProof&,const MigrationWriteGrant&)> migration_artifacts_ =
    [](const auto&,const auto&)->nlohmann::json{throw std::runtime_error("migration_artifacts_unavailable");};
};
}  // namespace ainvr::search
