#pragma once
#include "index_shard_files.hpp"
#include "model_migration_authorization.hpp"
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
namespace ainvr::config { class ConfigTransport; }
namespace ainvr::search {
namespace index_job_detail { struct JobProof; struct BuildProof; }
// Frozen effective configuration and verified embedding space, not browser input.
struct IndexJobContext {
  std::string revision, storage_generation, package_id, model_version;
  std::vector<std::string> channels;
  int retention_days = 30;
  // Only a PG-authorized migration may access its explicitly bounded older
  // retained scope. Ordinary contexts keep current retention semantics.
  std::optional<MigrationWriteProof> migration_lease{};
  std::optional<Scope> migration_scope{};
};
struct IndexJob {
  std::string id, worker;
  uint64_t generation = 0;
  std::string kind;
  IndexShardIdentity shard;
  std::string config_revision, package_id, lease_until, expires_at;
  std::shared_ptr<const index_job_detail::JobProof> proof{};
  int64_t minimum_checkpoint=0; // Claimed processing watermark, not scene coverage.
};
struct IndexBuildLease {
  IndexShardIdentity shard;
  std::string job_id, worker;
  uint64_t job_generation = 0;
  std::string manifest_key;
  std::shared_ptr<const index_job_detail::BuildProof> proof{};
};
struct PublishedIndexShard {
  IndexShardIdentity shard;
  ShardPublication publication;
  bool partial = true;
};
struct IndexJobEnqueued { std::string job_id, shard_id, state; };
struct IndexRefreshAccepted { std::string job_id,shard_id,state;int64_t accepted_checkpoint=0; };
struct IndexRetiredRef { IndexShardIdentity shard;std::string manifest_key; };
struct IndexRetiredCatalogPage { std::vector<IndexRetiredRef> shards;std::optional<std::string> next_cursor; };
struct IndexCatalogPage {
  std::vector<PublishedIndexShard> shards;
  std::optional<std::string> next_cursor;
};
class IndexJobError : public std::runtime_error {
 public:
  explicit IndexJobError(const char* fixed_code) : std::runtime_error(fixed_code) {}
};
// PG owns the only job lease and publication authority. Implementations do not
// retry writes, schedule jobs, or infer success from an HTTP timeout.
class IndexJobPort {
 public:
  virtual ~IndexJobPort() = default;
  virtual IndexJobEnqueued Enqueue(const std::string& request_key, const std::string& channel,
      const std::string& model, const std::string& utc_day, const std::string& kind = "index") = 0;
  virtual std::optional<IndexJob> Claim(const std::string& worker, const std::string& kind = "index") = 0;
  virtual bool Renew(const IndexJob&) = 0;
  virtual IndexBuildLease Begin(const IndexJob&) = 0;
  virtual bool Publish(const IndexBuildLease&, const ShardPublication&) = 0;
  virtual bool Fail(const IndexJob&, const std::string& error_code) = 0;
  virtual std::optional<PublishedIndexShard> Published(const std::string& shard_id) = 0;
  // Optional control-plane extension: nullopt means unsupported by a legacy
  // port, not an empty catalog. One bounded page per explicit caller step.
  virtual std::optional<IndexCatalogPage> Catalog(const std::optional<std::string>&,size_t=16) { return std::nullopt; }
  virtual std::optional<IndexRefreshAccepted> Refresh(const std::string&,const std::string&,int64_t) { return std::nullopt; }
  virtual std::optional<IndexRetiredRef> Retired(const std::string&) { return std::nullopt; }
  virtual std::optional<IndexRetiredCatalogPage> RetiredCatalog(const std::optional<std::string>&,size_t=16) { return std::nullopt; }
  virtual bool ConfirmCleanup(const IndexRetiredRef&) { return false; }
  virtual bool DiscardBuild(const IndexBuildLease&) { return false; }
};
// Reuses a dedicated instance of the existing management transport. The caller
// must not concurrently share that instance with runtime configuration polling.
class IndexJobClient final : public IndexJobPort {
 public:
  IndexJobClient(ainvr::config::ConfigTransport&, IndexJobContext);
  IndexJobEnqueued Enqueue(const std::string&, const std::string&, const std::string&,
      const std::string&, const std::string& kind = "index") override;
  std::optional<IndexJob> Claim(const std::string&, const std::string& kind = "index") override;
  bool Renew(const IndexJob&) override;
  IndexBuildLease Begin(const IndexJob&) override;
  bool Publish(const IndexBuildLease&, const ShardPublication&) override;
  bool Fail(const IndexJob&, const std::string&) override;
  std::optional<PublishedIndexShard> Published(const std::string&) override;
  std::optional<IndexCatalogPage> Catalog(const std::optional<std::string>& cursor,size_t limit=16) override;
  std::optional<IndexRefreshAccepted> Refresh(const std::string& channel,const std::string& utc_day,int64_t minimum_checkpoint) override;
  std::optional<IndexRetiredRef> Retired(const std::string& shard_id) override;
  std::optional<IndexRetiredCatalogPage> RetiredCatalog(const std::optional<std::string>& cursor,size_t limit=16) override;
  bool ConfirmCleanup(const IndexRetiredRef&) override;
  bool DiscardBuild(const IndexBuildLease&) override;
 private:
  nlohmann::json Request(nlohmann::json);
  ainvr::config::ConfigTransport& transport_;
  const IndexJobContext context_;
};
}  // namespace ainvr::search
