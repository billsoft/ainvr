#pragma once
#include "history_mongo.hpp"
#include <ctime>
#include <functional>
#include <map>
#include <set>
namespace ainvr::search {
// A metadata cursor over the existing Mongo authority, not another work queue.
// PG refresh coalesces durable per-shard requested watermarks. A failed call
// leaves this cursor unchanged; restart deterministically rediscovers samples.
class IndexDiscovery {
 public:
  using Scan = std::function<HistoryIndexChanges(int64_t, size_t)>;
  using Refresh = std::function<void(const std::string&, const std::string&, int64_t)>;
  IndexDiscovery(std::set<std::string> channels, Scan scan, Refresh refresh)
      : channels_(std::move(channels)), scan_(std::move(scan)), refresh_(std::move(refresh)) {
    if (channels_.empty() || channels_.size() > 1024 || !scan_ || !refresh_)
      throw std::invalid_argument("invalid_index_discovery");
  }
  // Returns false only when caught up. The owner then backs off before a full
  // reconciliation pass, which also rediscovers TTL/restart/config boundaries.
  bool Step(const std::function<bool()>& cancelled = {}) {
    if (cancelled && cancelled()) return true;
    const auto batch = scan_(checkpoint_, 32);
    if (batch.items.size() > 32 || batch.checkpoint < checkpoint_ || batch.checkpoint > 9007199254740991LL)
      throw std::runtime_error("invalid_index_discovery_page");
    using Key = std::pair<std::string, std::string>;
    std::map<Key, int64_t> watermarks;
    int64_t previous = checkpoint_;
    for (const auto& row : batch.items) {
      if (!channels_.count(row.channel) || row.ordinal <= previous || row.ordinal > batch.checkpoint ||
          row.captured_ms < 0 || row.captured_ms > 9007199254740991LL)
        throw std::runtime_error("invalid_index_discovery_page");
      previous = row.ordinal;
      const std::time_t seconds = row.captured_ms / 1000;
      std::tm utc{}; char day[11]{};
      if (!gmtime_r(&seconds, &utc) || strftime(day, sizeof(day), "%Y-%m-%d", &utc) != 10)
        throw std::runtime_error("invalid_index_discovery_day");
      auto& watermark = watermarks[{row.channel, day}]; watermark = std::max(watermark, row.ordinal);
    }
    // The page contains only at most 32 bounded metadata rows. Nothing retains
    // encoded images, vectors, model handles or credentials between ticks.
    for (const auto& item : watermarks) {
      if (cancelled && cancelled()) return true;
      refresh_(item.first.first, item.first.second, item.second);
    }
    const bool caught_up = batch.checkpoint == checkpoint_;
    checkpoint_ = caught_up ? 0 : batch.checkpoint;
    return !caught_up;
  }
  int64_t Checkpoint() const { return checkpoint_; }
 private:
  std::set<std::string> channels_;
  Scan scan_; Refresh refresh_;
  int64_t checkpoint_ = 0;
};
} // namespace ainvr::search
