#pragma once
#include <cstdint>
#include <map>
#include <optional>
#include <string>
namespace ainvr::search {
// Which published shard files are worth reading again into the RAM projection.
// Reading a file can only add rows that are missing and fit: the projection never
// replaces a resident row from a file and stops inserting once it is full. So:
// - a full projection reads nothing (every row would be refused);
// - a file is read again when it changed, when a row of its own channel and day was
//   dropped to make room (its shard epoch moved), or when its last read was cut off
//   because the projection was full and room has appeared since.
// Rows outside the retention window or held in a newer version are not a reason to
// read the same file again.
class ShardWarmRecord {
 public:
  explicit ShardWarmRecord(size_t limit = 3200) : limit_(limit) {}
  bool NeedsLoad(const std::string& shard, const std::string& manifest_sha256,
                 std::optional<uint64_t> shard_epoch, bool projection_full) const {
    if (projection_full) return false;
    if (!shard_epoch) return true;
    const auto found = entries_.find(shard);
    return found == entries_.end() || found->second.manifest != manifest_sha256 ||
           found->second.epoch != *shard_epoch || found->second.truncated;
  }
  // `truncated`: the projection was full when the read ended, so rows may be missing.
  void Loaded(const std::string& shard, const std::string& manifest_sha256,
              std::optional<uint64_t> shard_epoch, bool truncated) {
    if (!shard_epoch) { entries_.erase(shard); return; }
    if (entries_.size() >= limit_ && !entries_.count(shard)) entries_.clear();
    entries_[shard] = {manifest_sha256, *shard_epoch, truncated};
  }
  size_t Size() const { return entries_.size(); }
 private:
  struct Entry { std::string manifest; uint64_t epoch = 0; bool truncated = false; };
  size_t limit_;
  std::map<std::string, Entry> entries_;
};
// A stage that failed (a dependency briefly unavailable, for example while the
// backend restarts) left its state behind; before this the state changed again only
// on the next publication, so an idle board reported the fault for hours. A pass in
// which every stage succeeded clears such a transient fault.
inline const char* RecoveredIndexState(const std::string& current, bool every_stage_ok) {
  const bool transient = current == "dependency_unavailable" || current == "cache_unavailable" ||
                         current == "discovery_pending" || current == "cleanup_pending";
  return every_stage_ok && transient ? "working" : nullptr;
}
}  // namespace ainvr::search
