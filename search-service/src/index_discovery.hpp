#pragma once
#include "history_mongo.hpp"
#include <chrono>
#include <ctime>
#include <functional>
#include <map>
#include <set>
namespace ainvr::search {
struct IndexDiscoveryOptions {
  // A shard being written is refreshed at most this often: every refresh rebuilds that whole UTC day from Mongo,
  // and the live projection already holds new samples. The first refresh of a shard is sent at once.
  std::chrono::seconds refresh_interval{600};
  // After catching up the cursor stays at the newest ordinal. A full pass from ordinal 0 runs this often: ordinals
  // are allocated before the insert commits, so a lower one can become visible after a higher one was scanned.
  std::chrono::seconds full_pass_interval{1800};
};
// A metadata cursor over the existing Mongo authority, not another work queue.
// PG refresh coalesces durable per-shard requested watermarks. Watermarks not yet sent stay pending in memory;
// a restart begins with a full pass and rediscovers them.
class IndexDiscovery {
 public:
  using Scan = std::function<HistoryIndexChanges(int64_t, size_t)>;
  using Refresh = std::function<void(const std::string&, const std::string&, int64_t)>;
  using Clock = std::function<std::chrono::steady_clock::time_point()>;
  IndexDiscovery(std::set<std::string> channels, Scan scan, Refresh refresh, IndexDiscoveryOptions options = {}, Clock clock = {})
      : channels_(std::move(channels)), scan_(std::move(scan)), refresh_(std::move(refresh)), options_(options), clock_(std::move(clock)) {
    if (channels_.empty() || channels_.size() > 1024 || !scan_ || !refresh_ ||
        options_.refresh_interval.count() < 0 || options_.full_pass_interval.count() < 1)
      throw std::invalid_argument("invalid_index_discovery");
    if (!clock_) clock_ = [] { return std::chrono::steady_clock::now(); };
    next_full_pass_ = clock_() + options_.full_pass_interval;   // the first pass from 0 is already a full pass
  }
  // Returns false only when caught up; the owner then backs off before the next step.
  bool Step(const std::function<bool()>& cancelled = {}) {
    if (cancelled && cancelled()) return true;
    const auto batch = scan_(checkpoint_, 32);
    if (batch.items.size() > 32 || batch.checkpoint < checkpoint_ || batch.checkpoint > 9007199254740991LL)
      throw std::runtime_error("invalid_index_discovery_page");
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
    // The whole validated page is now held as pending watermarks, so the cursor may advance even if a refresh fails.
    for (const auto& [key, ordinal] : watermarks) { auto& value = pending_[key]; value = std::max(value, ordinal); }
    const bool caught_up = batch.checkpoint == checkpoint_;
    checkpoint_ = batch.checkpoint;
    Flush(cancelled);
    if (caught_up && clock_() >= next_full_pass_) {
      checkpoint_ = 0;
      next_full_pass_ = clock_() + options_.full_pass_interval;
    }
    return !caught_up;
  }
  int64_t Checkpoint() const { return checkpoint_; }
  size_t Pending() const { return pending_.size(); }
 private:
  using Key = std::pair<std::string, std::string>;
  void Flush(const std::function<bool()>& cancelled) {
    const auto now = clock_();
    for (auto it = pending_.begin(); it != pending_.end();) {
      if (cancelled && cancelled()) return;
      const auto sent = last_sent_.find(it->first);
      if (sent != last_sent_.end() && now - sent->second < options_.refresh_interval) { ++it; continue; }
      refresh_(it->first.first, it->first.second, it->second);   // a failure keeps this and later watermarks pending
      last_sent_[it->first] = now;
      it = pending_.erase(it);
    }
    // Bounded: a shard not refreshed for a whole interval no longer needs its timestamp.
    for (auto it = last_sent_.begin(); it != last_sent_.end();)
      it = now - it->second >= options_.refresh_interval && !pending_.count(it->first) ? last_sent_.erase(it) : std::next(it);
  }
  std::set<std::string> channels_;
  Scan scan_; Refresh refresh_;
  IndexDiscoveryOptions options_;
  Clock clock_;
  int64_t checkpoint_ = 0;
  std::chrono::steady_clock::time_point next_full_pass_{};
  std::map<Key, int64_t> pending_;
  std::map<Key, std::chrono::steady_clock::time_point> last_sent_;
};
} // namespace ainvr::search
