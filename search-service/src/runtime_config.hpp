#pragma once
#include "http_service.hpp"
#include <regex>
#include <set>
namespace ainvr::search {
struct EffectiveRuntime {
  int version = 0;
  std::string revision, uri, database;
  HttpAccess access;
  HistoryBudget budget;
  bool history_ready = false;
};
// The configuration center remains the only config/secret authority. This is
// validation of the resolved boundary, not a second settings database.
inline EffectiveRuntime ReadEffectiveRuntime(const nlohmann::json& document, const std::string& management_key) {
  EffectiveRuntime out;
  out.version = document.at("desired_version").get<int>();
  out.revision = document.at("revision").get<std::string>();
  if (out.version <= 0 || !std::regex_match(out.revision, std::regex("[a-f0-9]{64}")))
    throw std::invalid_argument("invalid_runtime_identity");
  auto& access = out.access;
  access.revision = out.revision; access.management_key = management_key;
  const auto& settings = document.at("settings");
  if (settings.at("schema_version") != "1.0" || settings.at("listen").at("host") != "127.0.0.1" ||
      settings.at("listen").at("port") != 8400 || settings.at("history").at("source") != "ai-history" ||
      settings.at("sampling").at("track_slots") != 8)
    throw std::invalid_argument("unsupported_runtime_settings");
  access.enabled = settings.at("enabled").get<bool>();
  const auto& callers = settings.at("callers");
  if (!callers.is_array() || callers.size() > 2) throw std::invalid_argument("invalid_runtime_callers");
  std::set<std::string> roles;
  for (const auto& caller : callers) {
    const auto role = caller.at("scope").get<std::string>();
    if (caller.at("name") != role || !roles.insert(role).second) throw std::invalid_argument("invalid_runtime_callers");
    const auto key = caller.at("key").get<std::string>();
    if (role == "console") access.console_key = key;
    else if (role == "producer") access.producer_key = key;
    else throw std::invalid_argument("invalid_runtime_callers");
  }
  const auto& limits = settings.at("limits");
  auto integer = [&](const char* name, int64_t lo, int64_t hi) {
    const auto& value = limits.at(name);
    if (!value.is_number_integer() || value < lo || value > hi) throw std::invalid_argument("invalid_runtime_limits");
    return value.get<int64_t>();
  };
  access.workers = size_t(integer("http_workers", 1, 8)); access.queue = size_t(integer("http_queue", 1, 32));
  access.image_max_bytes = size_t(integer("image_max_bytes", 65536, 8 * 1024 * 1024));
  out.budget.max_samples = integer("max_samples", 100, 1000000);
  out.budget.max_bytes = integer("max_bytes", 134217728, 1099511627776LL);
  out.budget.retention_ms = integer("retention_days", 1, 365) * 86400000;
  out.budget.max_coverage = integer("max_coverage", 100, 1000000);
  out.budget.max_searches = integer("max_searches", 1, 10000);
  access.search_ttl_s = integer("search_ttl_s", 60, 86400);
  const auto& history = document.at("history_connection");
  if (history.at("uri").is_string() && history.at("database").is_string()) {
    out.uri = history.at("uri").get<std::string>(); out.database = history.at("database").get<std::string>();
    if (out.uri.size() > 16384 || out.uri.find_first_of("\r\n") != std::string::npos ||
        !std::regex_match(out.database, std::regex("[a-zA-Z0-9_-]{1,64}")))
      throw std::invalid_argument("invalid_history_connection");
    out.history_ready = !out.uri.empty();
  }
  const auto& sources = document.at("sources");
  if (!sources.is_array() || sources.size() > 1024) throw std::invalid_argument("invalid_runtime_sources");
  const std::regex uuid("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
  for (const auto& source : sources) {
    const auto channel = source.at("channel_id").get<std::string>();
    ProducerSource binding{source.at("input_stream_id").get<std::string>(), source.at("processor_id").get<std::string>(),
      source.at("recording_channel_id").get<std::string>(), source.at("object").get<bool>(), source.at("scene").get<bool>()};
    binding.input_path = source.at("input_path").get<std::string>();
    binding.output_path = source.at("output_path").get<std::string>();
    if (!std::regex_match(channel, uuid) || !std::regex_match(binding.input_stream_id, uuid) ||
        !std::regex_match(binding.recording_channel_id, uuid) || binding.recording_channel_id != channel ||
        binding.processor_id.empty() || binding.processor_id.size() > 256 ||
        !ValidProducerStreamPath(binding.input_path) || !ValidProducerStreamPath(binding.output_path) ||
        !access.sources.emplace(channel, binding).second)
      throw std::invalid_argument("invalid_runtime_sources");
  }
  access.unavailable_reason.clear();
  const auto dependency = document.at("dependency_status");
  if (!dependency.is_null()) {
    const auto reason = dependency.get<std::string>();
    if (reason == "storage_unavailable" || reason == "history_unavailable") access.unavailable_reason = "storage_unavailable";
    else if (reason == "source_catalog_unavailable") access.unavailable_reason = "config_pending";
    else throw std::invalid_argument("invalid_runtime_dependency");
  }
  if (access.enabled && !out.history_ready) access.unavailable_reason = "storage_unavailable";
  // Model load and paired-encoder readiness are deliberately separate from ACK.
  // Without a production encoder, no producer model is authorized for ingestion.
  return out;
}
}  // namespace ainvr::search
