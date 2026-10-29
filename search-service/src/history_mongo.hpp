#pragma once
#include "sample_contract.hpp"
#include "source_writer_epoch.hpp"
#include <nlohmann/json.hpp>
#include <memory>
#include <optional>
#include <map>
namespace ainvr::search {
struct MigrationCoverageDefinition;
struct MigrationCoverageBatch;
enum class TrackSlotReceiptState { Committed, Replaced, Expired, Deleted, NotFound, ScopeMismatch, WriteMismatch };
struct TrackSlotReceipt { TrackSlotReceiptState state; std::string fingerprint{}; };
struct SourceWriterCommit {
  SourceWriterEpoch epoch;
  bool durable=false,migration_safe=false;
  SourceWriterReason reason=SourceWriterReason::PreviousUnclean;
};
struct HistoryBudget {
  int64_t max_samples = 100000;
  int64_t max_bytes = 1024LL * 1024 * 1024;
  int64_t retention_ms = 30LL * 86400000;
  int64_t max_coverage = 100000;
  int64_t max_searches = 1000;
  // Rolling retention: a full store evicts its oldest evidence, never rows younger than this.
  int64_t evict_min_age_ms = 10LL * 60000;
};
struct HistoryIndexChange { std::string channel; int64_t captured_ms = 0, ordinal = 0; };
struct HistoryIndexChanges { std::vector<HistoryIndexChange> items; int64_t checkpoint = 0; };
struct HistoryStamp { uint64_t revision = 0; bool settled = true; };
struct HistoryBatch {
  std::vector<Sample> samples; int64_t checkpoint = 0;
  bool exhausted = false; HistoryStamp stamp{};
};
struct HistoryMetadataRow {
  Sample sample;int64_t ordinal=0;std::string jpeg_sha256;
  size_t dimensions=0;std::string vector_format{};
};
struct HistoryMetadataBatch {
  std::vector<HistoryMetadataRow> items;int64_t checkpoint=0;bool exhausted=false;
};
struct SearchSessionRequest {
  std::string id, actor, query, model;
  Scope scope;
  bool verify = false;
  int64_t expires_ms = 0;
};
struct SearchSessionEvidenceRef { std::string sample_id, fingerprint; };
struct SearchSessionCandidate { std::string sample_id; double similarity; std::string fingerprint{}; std::vector<SearchSessionEvidenceRef> evidence_refs{}; };
struct SearchSessionItem { Sample sample; double similarity; std::optional<bool> relevant; std::optional<nlohmann::json> verification{}; nlohmann::json frames = nlohmann::json::array(); int64_t started_ms = 0, ended_ms = 0; };
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
  // Bootstrap pin guard: metadata-only existence check, no old HBM/vector/JPEG
  // reads. Any retained foreign model space conservatively requires migration.
  bool ModelSpaceCompatible(const std::string& model);
  // One bounded control document, independent of history TTL/retention. Reads
  // never grant admission; every Begin/recovery/clean genuinely mutates a
  // nonce with journal acknowledgement. Default bootstrap is conservative.
  SourceWriterTopology ReadSourceWriterTopology();
  std::optional<SourceWriterEpoch> ReadSourceWriterEpoch();
  SourceWriterCommit BeginSourceWriterEpoch(const std::string& owner_uuid,
      SourceWriterBootstrap bootstrap=SourceWriterBootstrap::Denied,
      int64_t resume_after_ms=0);
  bool MarkSourceWriterUnknown(const std::string& owner_uuid);
  SourceWriterCommit CleanSourceWriterEpoch(const std::string& owner_uuid,
      bool known_calls_drained=false);
  void Put(const Sample& sample);
  // Empty expected fingerprint creates an unused slot. Replacements require the
  // exact acknowledged generation; retries use the same token and identical body.
  // The JPEG, vector and metadata replace one document, never append a history.
  std::string ReplaceTrackSlot(const Sample& sample, size_t slot,
                               const std::string& expected_fingerprint,
                               const std::string& replacement_token);
  // Metadata-only exact write lookup. No mutation, re-encoding or submission.
  // NotFound/Expired/Replaced do NOT prove a write was rejected. A retired
  // generation has no receipt ledger and never returns its replacement's hash.
  TrackSlotReceipt ReadTrackSlotReceipt(const Sample& metadata, size_t slot,
      const std::string& replacement_token, const std::string& request_fingerprint);
  // Immutable scene writes use the same bounded metadata-only receipt proof.
  // Absence/expiry never authorizes resubmission or a new identity.
  TrackSlotReceipt ReadSceneReceipt(const Sample& metadata, const std::string& request_fingerprint);
  std::optional<Sample> Get(const std::string& id, bool include_image = true);
  // One authoritative visibility batch; no JPEG payload. All values are
  // rechecked against their immutable fingerprints by the projection.
  std::map<std::string, Sample> ReadVisibleSamples(const std::string& model,
      const Scope& scope, const std::vector<std::string>& ids);
  // Valid only for this single-writer process. An uncertain dispatched write
  // never certifies completeness, including if its response arrived late.
  HistoryStamp ProjectionStamp();
  // At most 64 exact identities in one metadata-only visibility batch. Current
  // fingerprints exclude expired/deleted rows; no JPEG or vector is fetched.
  std::map<std::string, std::string> ReadVisibleFingerprints(const std::string& model,
                                                           const std::vector<std::string>& ids);
  HistoryBatch Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit);
  // Bounded old-space migration reads. They never load/validate the old vector
  // or extend retention, and do not authorize writing into a different space.
  int64_t MetadataWatermark(const std::string& model,const Scope& scope);
  nlohmann::json MetadataExtent(const std::string& model,const std::set<std::string>& channels);
  HistoryMetadataBatch ScanMetadata(const std::string& model,const Scope& scope,
      int64_t after,int64_t through,size_t limit);
  std::optional<Sample> ReencodeImage(const std::string& id,const std::string& fingerprint,
      const std::string& model,const Scope& scope);
  std::optional<HistoryMetadataRow> ReadReencodeSource(const std::string& id,const std::string& fingerprint,
      const std::string& model,const Scope& scope,bool include_image=true);
  // New-space derivative only; the source is rechecked under the existing
  // Mongo writer lock. Ordinary expiry pruning and the shared hard quota apply;
  // no unexpired source/history is evicted to make room for migration.
  std::string WriteReencodedSample(const Sample& target,const HistoryMetadataRow& source);
  // Derived coverage cursor/snapshot only. Callers must validate the existing
  // PG artifact/read authority; a stored report never grants work permission.
  nlohmann::json BeginMigrationCoverage(const std::string& job_id,int64_t generation,const std::string& actor,
      const MigrationCoverageDefinition&);
  nlohmann::json AdvanceMigrationCoverage(const std::string& job_id,int64_t generation,const std::string& actor,
      const MigrationCoverageDefinition&,int64_t expected_checkpoint);
  nlohmann::json ReadMigrationCoverage(const std::string& job_id,int64_t generation,const std::string& actor,
      const MigrationCoverageDefinition&,const std::optional<std::string>& after=std::nullopt);
  // Background index discovery reuses the sample append/CAS ordinal. At most
  // 64 metadata rows, including changed track slots; never reads image/vector
  // payloads, creates a queue or certifies semantic/temporal coverage.
  HistoryIndexChanges ScanIndexChanges(const std::string& model,
      const std::set<std::string>& channels, int64_t after, size_t limit = 32);
  void PutCoverage(const std::string& id, const std::string& model, const std::string& channel,
                   int64_t from, int64_t to, bool scene, const std::string& state, int64_t expires);
  nlohmann::json Coverage(const std::string& model, const Scope& scope);
  // Deletion intent commits before removal. Replayed old frames remain denied.
  void DeleteRange(const std::string& channel, int64_t from, int64_t to);
  nlohmann::json Usage();
  nlohmann::json Capacity();
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
  // Bounded verification state/cache over the same owned immutable shortlist.
  // A durable begin marker precedes the external read-only model operation.
  nlohmann::json SearchVerification(const nlohmann::json& request);
 private:
  TrackSlotReceipt ReadReceipt(const Sample&, std::optional<size_t> slot,
      const std::string& token, const std::string& request_fingerprint);
  MigrationCoverageBatch ReadCoverageBatch(const MigrationCoverageDefinition&,int64_t after);
  std::string WriteSample(const Sample& sample, std::optional<size_t> slot,
                          const std::string& expected_fingerprint,
                          const std::string& replacement_token,
                          const HistoryMetadataRow* migration_source=nullptr);
  struct State;
  std::unique_ptr<State> state_;
};
}  // namespace ainvr::search
