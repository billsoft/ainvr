#pragma once
#include "vector_index.hpp"
#include <nlohmann/json.hpp>
#include <memory>
#include <optional>
namespace ainvr::search {
struct Sample {
  Record record;
  nlohmann::json evidence;
  std::vector<uint8_t> jpeg;
  int64_t expires_ms = 0;
  // Internal immutable reference generation, populated when decoding storage.
  // Never included in producer metadata or used as a model similarity score.
  std::string fingerprint{};
  // Present only for bounded, atomically replaceable object-track samples.
  std::optional<size_t> track_slot{};
};
struct HistoryBudget {
  int64_t max_samples = 100000;
  int64_t max_bytes = 1024LL * 1024 * 1024;
  int64_t retention_ms = 30LL * 86400000;
  int64_t max_coverage = 100000;
  int64_t max_searches = 1000;
};
struct HistoryBatch { std::vector<Sample> samples; int64_t checkpoint = 0; };
struct SearchSessionRequest {
  std::string id, actor, query, model;
  Scope scope;
  bool verify = false;
  int64_t expires_ms = 0;
};
struct SearchSessionCandidate { std::string sample_id; double similarity; std::string fingerprint{}; };
struct SearchSessionItem { Sample sample; double similarity; std::optional<bool> relevant; };
struct SearchSessionPage {
  SearchSessionRequest request;
  std::string version, coverage = "unknown";
  bool published = false;
  std::vector<SearchSessionItem> items;
  std::optional<size_t> next_offset;
};

// Single owning search-service process per namespace. Calls are serialized;
// deployments must not enable multiple writers to the same history namespace.
// Metadata, original embedding and JPEG commit as one acknowledged document.
class HistoryMongo {
 public:
  HistoryMongo(const std::string& uri, const std::string& database, HistoryBudget budget = {});
  ~HistoryMongo();
  HistoryMongo(const HistoryMongo&) = delete;
  HistoryMongo& operator=(const HistoryMongo&) = delete;
  void Initialize();
  void Ping();
  void Put(const Sample& sample);
  // Empty expected fingerprint creates an unused slot. Replacements require the
  // exact acknowledged generation; retries use the same token and identical body.
  // The JPEG, vector and metadata replace one document, never append a history.
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot,
                               const std::string& expected_fingerprint,
                               const std::string& replacement_token);
  std::optional<Sample> Get(const std::string& id, bool include_image = true);
  HistoryBatch Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit);
  void PutCoverage(const std::string& id, const std::string& model, const std::string& channel,
                   int64_t from, int64_t to, bool scene, const std::string& state, int64_t expires);
  nlohmann::json Coverage(const std::string& model, const Scope& scope);
  // Deletion intent commits before removal. Replayed old frames remain denied.
  void DeleteRange(const std::string& channel, int64_t from, int64_t to);
  nlohmann::json Usage();
  // Short-lived immutable shortlist, not a task queue. References reuse sample
  // storage; ordering never changes when feedback arrives or evidence expires.
  std::string BeginSearch(const SearchSessionRequest& request);
  bool PublishSearch(const std::string& id, const std::string& actor, const std::string& version,
                     const std::vector<SearchSessionCandidate>& candidates, const std::string& coverage);
  std::optional<SearchSessionPage> ReadSearch(const std::string& id, const std::string& actor,
                                            size_t offset = 0, size_t limit = 20);
  bool SearchFeedback(const std::string& id, const std::string& actor, const std::string& sample_id, bool relevant);
  std::optional<Sample> SearchImage(const std::string& id, const std::string& actor,
                                    const std::string& sample_id, const std::string& frame_id);
  void CancelSearch(const std::string& id, const std::string& actor);
 private:
  std::string WriteSample(const Sample& sample, std::optional<size_t> slot,
                          const std::string& expected_fingerprint,
                          const std::string& replacement_token);
  struct State;
  std::unique_ptr<State> state_;
};
}  // namespace ainvr::search
