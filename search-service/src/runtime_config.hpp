#pragma once
#include "http_service.hpp"
#include "index_shard_files.hpp"
#include "model_pin.hpp"
#include "source_admission.hpp"
#include "sample_contract.hpp"
#include <regex>
#include <set>
namespace ainvr::search {
struct RuntimeModelTransition {
  std::string job_id,payload_fingerprint;
  int64_t generation=0;
  RuntimeModelPin source,target;
};
inline RuntimeModelPin ReadRuntimeModelPin(const nlohmann::json& value) {
  if(!value.is_object()||value.size()!=3||!value.contains("package_id")||
      !value.contains("package_sha256")||!value.contains("model_version"))
    throw std::invalid_argument("invalid_runtime_model_pin");
  RuntimeModelPin pin{value.at("package_id").get<std::string>(),value.at("package_sha256").get<std::string>(),
    value.at("model_version").get<std::string>()};
  if(!ValidRuntimeModelPin(pin))
    throw std::invalid_argument("invalid_runtime_model_pin");
  return pin;
}
inline nlohmann::json RuntimeModelPinJson(const RuntimeModelPin& pin) {
  return {{"package_id",pin.package_id},{"package_sha256",pin.package_sha256},{"model_version",pin.model_version}};
}
struct EffectiveRuntime {
  int version = 0;
  std::string revision, uri, database, package_id;
  HttpAccess access;
  HistoryBudget budget;
  bool history_ready = false;
  std::optional<IndexStorageAuthorization> index_storage;
  std::optional<RuntimeModelPin> active_model_pin;
  std::optional<RuntimeModelTransition> approved_model_transition;
  std::optional<RuntimeIngestionGate> ingestion_gate;
};
// The configuration center remains the only config/secret authority. This is
// validation of the resolved boundary, not a second settings database.
inline EffectiveRuntime ReadEffectiveRuntime(const nlohmann::json& document, const std::string& management_key) {
  EffectiveRuntime out;
  out.version = document.at("desired_version").get<int>();
  out.revision = document.at("revision").get<std::string>();
  if (out.version <= 0 || !std::regex_match(out.revision, std::regex("[a-f0-9]{64}")))
    throw std::invalid_argument("invalid_runtime_identity");
  if(document.contains("active_model_pin")&&!document.at("active_model_pin").is_null())
    out.active_model_pin=ReadRuntimeModelPin(document.at("active_model_pin"));
  if(document.contains("approved_model_transition")&&!document.at("approved_model_transition").is_null()) {
    const auto& value=document.at("approved_model_transition");
    if(!value.is_object()||value.size()!=5||!value.contains("job_id")||!value.contains("generation")||
        !value.contains("payload_fingerprint")||!value.contains("source")||!value.contains("target")||
        !value.at("generation").is_number_integer()||value.at("generation")<1||value.at("generation")>9007199254740991LL)
      throw std::invalid_argument("invalid_runtime_model_transition");
    RuntimeModelTransition transition{value.at("job_id").get<std::string>(),value.at("payload_fingerprint").get<std::string>(),
      value.at("generation").get<int64_t>(),ReadRuntimeModelPin(value.at("source")),ReadRuntimeModelPin(value.at("target"))};
    if(!std::regex_match(transition.job_id,std::regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))||
        !std::regex_match(transition.payload_fingerprint,std::regex("[a-f0-9]{64}")))
      throw std::invalid_argument("invalid_runtime_model_transition");
    out.approved_model_transition=std::move(transition);
  }
  auto& access = out.access;
  access.revision = out.revision; access.management_key = management_key;
  const auto& settings = document.at("settings");
  if (settings.at("schema_version") != "1.0" || settings.at("listen").at("host") != "127.0.0.1" ||
      settings.at("listen").at("port") != 8400 || settings.at("history").at("source") != "ai-history" ||
      settings.at("sampling").at("track_slots") != 8)
    throw std::invalid_argument("unsupported_runtime_settings");
  access.enabled = settings.at("enabled").get<bool>();
  const auto& package = settings.at("model").at("package_id");
  if (!package.is_null()) {
    out.package_id = package.get<std::string>();
    if (out.package_id.empty() || out.package_id.size() > 128 ||
        !std::regex_match(out.package_id, std::regex("[a-z0-9][a-z0-9-]*")))
      throw std::invalid_argument("invalid_runtime_model");
  }
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
  // The backend resolves the selected external volume; the native file owner
  // independently verifies its mount/UUID/inode and never falls back to eMMC.
  if (document.contains("index_directory")) {
    const auto& directory = document.at("index_directory");
    if (!directory.at("ready").is_boolean()) throw std::invalid_argument("invalid_runtime_storage");
    if (directory.at("ready").get<bool>()) {
      IndexStorageAuthorization selected{directory.at("volume_id").get<std::string>(),
        directory.at("relative_path").get<std::string>(), directory.at("resolved_path").get<std::string>(),
        directory.at("generation").get<std::string>()};
      const auto& definition = settings.at("index_storage");
      if (definition.at("volume_id") != selected.volume_id || definition.at("relative_path") != selected.relative_path ||
          !std::regex_match(selected.volume_id, std::regex("[a-zA-Z0-9_-]{1,128}")) ||
          !std::regex_match(selected.generation, std::regex("[a-f0-9]{64}")) || selected.relative_path.empty() ||
          selected.relative_path.size() > 1024 || selected.resolved_path.empty() || selected.resolved_path.size() > 4096 ||
          selected.relative_path.find_first_of("\r\n") != std::string::npos ||
          selected.resolved_path.find_first_of("\r\n") != std::string::npos)
        throw std::invalid_argument("invalid_runtime_storage");
      out.index_storage = std::move(selected);
    }
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
  if(document.contains("ingestion_gate")&&!document.at("ingestion_gate").is_null()) {
    const auto& value=document.at("ingestion_gate");
    if(!value.is_object()||value.size()!=8||!value.contains("paused")||!value.contains("plan_id")||
        !value.contains("epoch")||!value.contains("generation")||!value.contains("worker")||!value.contains("source")||
        !value.contains("source_ids_sha256")||!value.contains("expires_ms")||
        !value.at("paused").is_boolean()||!value.at("paused").get<bool>()||
        !value.at("generation").is_number_integer()||value.at("generation")<1||value.at("generation")>9007199254740991LL||
        !value.at("expires_ms").is_number_integer()||value.at("expires_ms")<0||value.at("expires_ms")>9007199254740991LL)
      throw std::invalid_argument("invalid_runtime_ingestion_gate");
    RuntimeIngestionGate gate{value.at("plan_id").get<std::string>(),value.at("epoch").get<std::string>(),
      value.at("worker").get<std::string>(),value.at("source_ids_sha256").get<std::string>(),
      value.at("generation").get<int64_t>(),value.at("expires_ms").get<int64_t>(),ReadRuntimeModelPin(value.at("source"))};
    // Node hashes UTF-8 JSON.stringify([...selectedChannelIds].sort()). UUIDs
    // are ASCII, so the ordered map plus compact JSON is byte-for-byte equal.
    nlohmann::json selected_ids=nlohmann::json::array();
    for(const auto& entry:access.sources)selected_ids.push_back(entry.first);
    const auto& transition=out.approved_model_transition;
    const bool selected_source=out.package_id==gate.source.package_id;
    // Publication selects the target before its Ready ACK; the actual active
    // pin and gate remain on source until that ACK completes the PG transaction.
    const bool selected_target=transition&&transition->job_id==gate.plan_id&&transition->generation==gate.generation&&
      MatchesRuntimeModelPin(transition->source,gate.source)&&out.package_id==transition->target.package_id;
    if(!std::regex_match(gate.plan_id,uuid)||!std::regex_match(gate.epoch,uuid)||!std::regex_match(gate.worker,uuid)||
        !std::regex_match(gate.source_ids_sha256,std::regex("[a-f0-9]{64}"))||access.sources.empty()||
        gate.source_ids_sha256!=SampleSha256(selected_ids.dump())||!out.active_model_pin||
        !MatchesRuntimeModelPin(*out.active_model_pin,gate.source)||(!selected_source&&!selected_target))
      throw std::invalid_argument("invalid_runtime_ingestion_gate");
    // Expiration forbids a drain ACK, but never removes the admission latch.
    // Preserve the full gate for the trusted runtime controller, including an
    // already expired gate; only its durable writer-epoch resume may clear it.
    out.ingestion_gate=std::move(gate);
  }
  access.unavailable_reason.clear();
  const auto dependency = document.at("dependency_status");
  if (!dependency.is_null()) {
    const auto reason = dependency.get<std::string>();
    if (reason == "storage_unavailable" || reason == "history_unavailable") access.unavailable_reason = "storage_unavailable";
    else if (reason == "source_catalog_unavailable") access.unavailable_reason = "config_pending";
    else throw std::invalid_argument("invalid_runtime_dependency");
  }
  if (access.enabled && (!out.history_ready || !out.index_storage)) access.unavailable_reason = "storage_unavailable";
  // Model load and paired-encoder readiness are deliberately separate from ACK.
  // Without a production encoder, no producer model is authorized for ingestion.
  return out;
}
}  // namespace ainvr::search
