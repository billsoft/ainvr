#pragma once
#include "vector_index.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ainvr::search {
struct IndexStorageAuthorization {
  std::string volume_id, relative_path, resolved_path, generation;
};
struct IndexShardIdentity {
  std::string id;
  uint64_t revision = 0;
  std::string channel_id, model_version, utc_day;
  size_t dimensions = 0;
  int64_t checkpoint = 0;
  std::string storage_generation;
};
struct ShardPublication {
  std::string manifest_key, manifest_sha256;
  int64_t checkpoint = 0;
  uint64_t record_count = 0, byte_count = 0;
};
struct IndexShardFileLimits {
  uint64_t max_total_bytes = 1024ULL * 1024 * 1024;
  uint64_t max_shard_bytes = 512ULL * 1024 * 1024;
  size_t max_files = 8192, max_records = 100000;
  size_t max_temporary_files = 2;
  uint64_t max_temporary_bytes = 512ULL * 1024 * 1024 + 65536;
};

// Immutable, rebuildable file projection; PG remains the publication/lease
// authority and Mongo remains the authoritative vector/history store.
class IndexShardFiles {
 public:
  static std::unique_ptr<IndexShardFiles> OpenProduction(
      const IndexStorageAuthorization& authorization, IndexShardFileLimits limits = {});
#ifdef AINVR_SHARD_FILES_TESTING
  // Compiled only into the separate software test target. Never an HTTP or
  // runtime fallback. The existing private directory must be owned mode0700.
  static std::unique_ptr<IndexShardFiles> OpenForTesting(
      const std::string& private_directory, IndexShardFileLimits limits = {});
#endif
  ~IndexShardFiles();
  IndexShardFiles(const IndexShardFiles&) = delete;
  IndexShardFiles& operator=(const IndexShardFiles&) = delete;
  const std::string& StorageGeneration() const;
  ShardPublication Publish(const IndexShardIdentity& identity, const std::vector<Record>& records);
  std::vector<Record> Load(const IndexShardIdentity& identity, const ShardPublication& publication);
  // Caller must first hide/delete this exact generation in PG. This method
  // never decides business visibility or performs directory-wide deletion.
  void DeleteAuthorized(const IndexShardIdentity& identity, const ShardPublication& publication);
  // Only the PG atomic retired slot authorizes this exact key. This is cleanup
  // of derived bytes, NOT a claim that dimensions/content hashes were verified.
  void DeleteRetired(const IndexShardIdentity& identity,const std::string& manifest_key);
  // For a catalog-authorized cancelled/unpublished build only. A complete
  // manifest requires DeleteAuthorized and the catalog's visibility decision;
  // the mere existence of a file never means PG has adopted it.
  void DiscardUnpublished(const IndexShardIdentity& identity);
  static std::string ManifestKey(const IndexShardIdentity& identity);
 private:
  struct Impl;
  explicit IndexShardFiles(std::unique_ptr<Impl> impl);
  void DeleteExact(const IndexShardIdentity& identity);
  std::unique_ptr<Impl> impl_;
};
}  // namespace ainvr::search
