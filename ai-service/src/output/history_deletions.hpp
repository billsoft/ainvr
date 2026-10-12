#pragma once

#include <atomic>
#include <cmath>
#include <fstream>
#include <limits>
#include <nlohmann/json.hpp>
#include "../config/durable_file.hpp"

namespace ai_service::output {
// Caller holds history_mutex_ except for Epoch(). Every job carries the epoch
// at capture acceptance. Persist intent before deleting Mongo documents; replay
// honors the same intent after a crash, including old files with epoch zero.
class HistoryDeletions {
 public:
  void Load(const std::string& directory) {
    if (directory.empty()) return;  // In-memory/test store.
    auto path = std::filesystem::path(directory) / "deletions.json";
    if (!std::filesystem::exists(path)) { path_ = path; return; }
    std::ifstream input(path);
    auto state = nlohmann::json::parse(input);
    if (state.at("schema") != 1 || !state.at("rules").is_array() ||
        !state.at("epoch").is_number_unsigned() ||
        state.at("epoch").get<uint64_t>() > uint64_t(std::numeric_limits<int64_t>::max()))
      throw std::runtime_error("invalid history deletion journal");
    const auto epoch = state.at("epoch").get<uint64_t>();
    uint64_t previous = 0;
    // Reject corrupt intent rather than silently replaying deleted images.
    for (const auto& rule : state.at("rules")) {
      if (!rule.at("epoch").is_number_unsigned() || rule.at("epoch").get<uint64_t>() > epoch ||
          rule.at("epoch").get<uint64_t>() <= previous)
        throw std::runtime_error("invalid deletion rule epoch");
      ValidateFilter(rule.at("filter"));
      previous = rule.at("epoch").get<uint64_t>();
    }
    if (previous != epoch) throw std::runtime_error("incomplete history deletion journal");
    // Commit loaded state only after all rules are validated.
    rules_ = state.at("rules"); epoch_.store(epoch); path_ = std::move(path); dirty_ = false;
  }
  uint64_t Epoch() const { return epoch_.load(); }
  void Add(nlohmann::json filter) {
    ValidateFilter(filter);
    if (Epoch() >= static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
      throw std::runtime_error("history deletion epoch exhausted");
    const auto next = Epoch() + 1;
    if (filter.empty()) rules_ = nlohmann::json::array(); // Clear subsumes prior rules.
    rules_.push_back({{"epoch", next}, {"filter", std::move(filter)}});
    // If persistence fails, keep the intent in memory and block writes until a
    // successful retry. New frames get the new epoch and are not discarded.
    epoch_.store(next);
    dirty_ = true;
    Flush();
  }
  void Flush() {
    if (!dirty_) return;
    if (!path_.empty()) {
      std::filesystem::create_directories(path_.parent_path());
      config::WriteDurableFile(path_, nlohmann::json{
          {"schema", 1}, {"epoch", Epoch()}, {"rules", rules_}}.dump());
    }
    dirty_ = false;
  }
  bool Matches(uint64_t epoch, const std::string& id, double timestamp) const {
    if (epoch >= Epoch()) return false;  // Normal new frames never scan old tombstones.
    for (const auto& rule : rules_) {
      if (epoch >= rule.at("epoch").get<uint64_t>()) continue;
      const auto& filter = rule.at("filter");
      if (filter.empty()) return true;
      if (filter.contains("image_id") && filter.at("image_id") == id) return true;
      if (filter.contains("timestamp")) {
        const auto& range = filter.at("timestamp");
        if (timestamp >= range.at("$gte").get<double>() && timestamp <= range.at("$lte").get<double>()) return true;
      }
    }
    return false;
  }
  const nlohmann::json& Rules() const { return rules_; }
 private:
  static void ValidateFilter(const nlohmann::json& filter) {
    if (!filter.is_object()) throw std::invalid_argument("deletion filter must be an object");
    if (filter.empty()) return;
    if (filter.size() != 1) throw std::invalid_argument("unsupported compound deletion filter");
    if (filter.contains("image_id")) {
      const auto& id = filter.at("image_id");
      if (!id.is_string() || id.get_ref<const std::string&>().empty())
        throw std::invalid_argument("invalid deletion image ID");
      return;
    }
    if (filter.contains("timestamp")) {
      const auto& range = filter.at("timestamp");
      if (!range.is_object() || range.size() != 2 || !range.contains("$gte") || !range.contains("$lte") ||
          !range.at("$gte").is_number() || !range.at("$lte").is_number())
        throw std::invalid_argument("invalid deletion time range");
      double from = range.at("$gte").get<double>(), to = range.at("$lte").get<double>();
      if (!std::isfinite(from) || !std::isfinite(to) || from > to)
        throw std::invalid_argument("invalid deletion time bounds");
      return;
    }
    throw std::invalid_argument("unsupported deletion filter");
  }
  std::filesystem::path path_;
  std::atomic<uint64_t> epoch_{0};
  nlohmann::json rules_ = nlohmann::json::array();
  bool dirty_ = false;
};
}  // namespace ai_service::output
