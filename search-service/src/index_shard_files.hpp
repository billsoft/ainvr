#pragma once
#include "vector_index.hpp"
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
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
  // Views per record (a scene sample stores several unit-norm views). Not part of the
  // PG identity: the writer sets it from the model package; 0 when reading means
  // "take it from the file" (a v1 file is treated as one view).
  size_t views = 0;
};
struct ShardPublication {
  std::string manifest_key, manifest_sha256;
  int64_t checkpoint = 0;
  uint64_t record_count = 0, byte_count = 0;
};
// Read-only columns of one published shard: memory-mapped from a v2 (int8) file, or
// converted into owned memory from a v1 (float32) file during the transition. Rows are
// sorted by id. Vectors are `views` int8 blocks per row with one scale per block.
struct ShardView {
  IndexShardIdentity identity;
  ShardPublication publication;
  size_t count = 0, dimensions = 0, views = 1, per = 0;
  const char* ids = nullptr;                    // count x 36
  const unsigned char* fingerprints = nullptr;  // count x 32 (binary sha-256)
  const int64_t* captured_ms = nullptr;         // count
  const uint8_t* scene = nullptr;               // count
  const unsigned char* groups = nullptr;        // count x 16 (RecordGroup)
  const float* scales = nullptr;                // count x views
  const int8_t* vectors = nullptr;              // count x dimensions
  bool converted = false;                       // true: a v1 file held in owned memory
  std::shared_ptr<const void> storage;          // keeps the mapping or owned bytes alive
  std::string Id(size_t row) const { return std::string(ids + 36 * row, 36); }
  std::string Fingerprint(size_t row) const {
    static const char* hex = "0123456789abcdef"; std::string out(64, '0');
    for (size_t i = 0; i < 32; ++i) { out[2*i] = hex[fingerprints[32*row+i] >> 4]; out[2*i+1] = hex[fingerprints[32*row+i] & 15]; }
    return out;
  }
  // Binary search over the sorted id column.
  std::optional<size_t> Find(const std::string& id) const {
    if (id.size() != 36) return std::nullopt;
    size_t low = 0, high = count;
    while (low < high) {
      const size_t mid = low + (high - low) / 2; const int c = std::memcmp(ids + 36 * mid, id.data(), 36);
      if (c == 0) return mid;
      if (c < 0) low = mid + 1; else high = mid;
    }
    return std::nullopt;
  }
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
  // Verifies the publication once (manifest and data hash), then serves its columns
  // without reading the file again: a v2 file is memory-mapped, a v1 file converted.
  std::shared_ptr<const ShardView> Open(const IndexShardIdentity& identity, const ShardPublication& publication);
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
