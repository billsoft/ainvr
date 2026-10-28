#include "search_producer_grant.hpp"
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <algorithm>
#include <limits>
#include <regex>
#include <set>
#include <stdexcept>
namespace ai_service::config {
namespace {
using Json = nlohmann::json;
[[noreturn]] void Invalid() { throw std::invalid_argument("invalid_search_producer_grant"); }
void Keys(const Json& object, std::initializer_list<const char*> keys) {
  if (!object.is_object() || object.size() != keys.size()) Invalid();
  for (const auto* key : keys) if (!object.contains(key)) Invalid();
}
std::string Text(const Json& value, size_t min, size_t max) {
  if (!value.is_string()) Invalid();
  auto text = value.get<std::string>();
  if (text.size() < min || text.size() > max || std::any_of(text.begin(), text.end(), [](unsigned char c) { return c < 32 || c == 127; })) Invalid();
  return text;
}
int64_t Integer(const Json& value, int64_t min, int64_t max) {
  if (!value.is_number_integer() || value < min || value > max) Invalid();
  return value.get<int64_t>();
}
bool Boolean(const Json& value) { if (!value.is_boolean()) Invalid(); return value.get<bool>(); }
std::string Uuid(const Json& value) {
  auto text = Text(value, 36, 36);
  static const std::regex pattern("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
  if (!std::regex_match(text, pattern)) Invalid();
  return text;
}
std::string Path(const Json& value) {
  auto path = Text(value, 4, 2048);
  if (path.front() != '/' || path.find_first_of("?#\\ \t\r\n") != std::string::npos) Invalid();
  const auto separator = path.find('/', 1);
  if (separator == std::string::npos || separator == 1 || separator + 1 == path.size() || path.find('/', separator + 1) != std::string::npos) Invalid();
  const auto app = path.substr(1, separator - 1), stream = path.substr(separator + 1);
  if (app == "." || app == ".." || stream == "." || stream == "..") Invalid();
  return path;
}
std::string Fingerprint(const Json& document) {
  const auto body = document.dump();
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  unsigned char bytes[EVP_MAX_MD_SIZE]; unsigned int size = 0;
  if (!context || EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(context.get(), body.data(), body.size()) != 1 || EVP_DigestFinal_ex(context.get(), bytes, &size) != 1)
    throw std::runtime_error("search_producer_digest_failed");
  std::string digest; const char* hex = "0123456789abcdef";
  for (unsigned int n = 0; n < size; ++n) { digest += hex[bytes[n] >> 4]; digest += hex[bytes[n] & 15]; }
  return digest;
}
}  // namespace
ParsedSearchProducerGrant ParseSearchProducerGrant(const Json& document) {
  try {
    Keys(document, {"enabled", "reason", "endpoint", "api_token", "revision", "model", "sampling", "sources", "valid_for_ms", "limits"});
    Keys(document.at("model"), {"package_id"});
    if (!Boolean(document.at("enabled"))) {
      const auto reason = Text(document.at("reason"), 1, 32);
      if ((reason != "disabled" && reason != "config_pending") || !document.at("endpoint").is_null() ||
          !document.at("api_token").is_null() || !document.at("revision").is_null() ||
          !document.at("model").at("package_id").is_null() || !document.at("sampling").is_null() ||
          !document.at("limits").is_null() || !document.at("sources").is_array() || !document.at("sources").empty() ||
          Integer(document.at("valid_for_ms"), 0, 0) != 0) Invalid();
      return {nullptr, "", reason, std::chrono::milliseconds(0)};
    }
    if (!document.at("reason").is_null() || Integer(document.at("valid_for_ms"), 30000, 30000) != 30000) Invalid();
    auto grant = std::make_shared<SearchProducerGrant>();
    grant->endpoint = Text(document.at("endpoint"), 1, 64);
    if (grant->endpoint != "http://127.0.0.1:8400") Invalid();
    grant->api_token = Text(document.at("api_token"), 32, 512);
    if (grant->api_token.rfind("${secret:", 0) == 0) Invalid();
    grant->revision = Text(document.at("revision"), 64, 64);
    if (!std::regex_match(grant->revision, std::regex("[a-f0-9]{64}"))) Invalid();
    grant->package_id = Text(document.at("model").at("package_id"), 1, 128);
    if (!std::regex_match(grant->package_id, std::regex("[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}"))) Invalid();
    const auto& limits = document.at("limits");
    Keys(limits, {"producer_queue", "producer_bytes", "image_max_bytes", "retention_days"});
    grant->limits = {Integer(limits.at("producer_queue"), 1, 4), Integer(limits.at("producer_bytes"), 8388608, 268435456),
      Integer(limits.at("image_max_bytes"), 65536, 8388608), Integer(limits.at("retention_days"), 1, 365)};
    const auto& sampling = document.at("sampling");
    Keys(sampling, {"mode", "channel_ids", "object", "scene", "object_interval_ms", "scene_active_interval_ms",
      "scene_static_interval_ms", "scene_change_min_interval_ms", "track_slots"});
    auto& selected = grant->sampling;
    selected.mode = Text(sampling.at("mode"), 1, 8);
    if (selected.mode != "all" && selected.mode != "selected") Invalid();
    if (!sampling.at("channel_ids").is_array() || sampling.at("channel_ids").size() > 100) Invalid();
    std::set<std::string> ids;
    for (const auto& id : sampling.at("channel_ids")) {
      auto value = Uuid(id); if (!ids.insert(value).second) Invalid(); selected.channel_ids.push_back(std::move(value));
    }
    if ((selected.mode == "all" && !ids.empty()) || (selected.mode == "selected" && ids.empty())) Invalid();
    selected.object = Boolean(sampling.at("object")); selected.scene = Boolean(sampling.at("scene"));
    if (!selected.object && !selected.scene) Invalid();
    selected.object_interval_ms = Integer(sampling.at("object_interval_ms"), 250, 60000);
    selected.scene_active_interval_ms = Integer(sampling.at("scene_active_interval_ms"), 1000, 300000);
    selected.scene_static_interval_ms = Integer(sampling.at("scene_static_interval_ms"), 1000, 3600000);
    selected.scene_change_min_interval_ms = Integer(sampling.at("scene_change_min_interval_ms"), 1000, 300000);
    selected.track_slots = Integer(sampling.at("track_slots"), 8, 8);
    if (selected.scene_static_interval_ms < selected.scene_active_interval_ms || selected.scene_change_min_interval_ms > selected.scene_active_interval_ms) Invalid();
    const auto& sources = document.at("sources");
    if (!sources.is_array() || sources.size() > 1024) Invalid();
    std::set<std::string> channels, outputs;
    for (const auto& value : sources) {
      Keys(value, {"channel_id", "input_stream_id", "processor_id", "recording_channel_id", "input_path", "output_path", "object", "scene"});
      SearchProducerSource source{Uuid(value.at("channel_id")), Uuid(value.at("input_stream_id")), Text(value.at("processor_id"), 1, 128),
        Uuid(value.at("recording_channel_id")), Path(value.at("input_path")), Path(value.at("output_path")),
        Boolean(value.at("object")), Boolean(value.at("scene"))};
      if (source.channel_id != source.recording_channel_id || source.channel_id == source.input_stream_id ||
          (source.object && !selected.object) || (source.scene && !selected.scene) ||
          (selected.mode == "selected" && !ids.count(source.channel_id)) || !channels.insert(source.channel_id).second ||
          !outputs.insert(source.output_path).second || !grant->sources.emplace(source.processor_id, source).second) Invalid();
    }
    return {std::move(grant), Fingerprint(document), "", std::chrono::milliseconds(30000)};
  } catch (...) { throw std::invalid_argument("invalid_search_producer_grant"); }
}
SearchProducerGrantAuthority::SearchProducerGrantAuthority(SearchProducerClock clock)
  : clock_(clock ? std::move(clock) : SearchProducerClock([] { return std::chrono::steady_clock::now(); })) {}
std::chrono::steady_clock::time_point SearchProducerGrantAuthority::Now() const { return clock_(); }
void SearchProducerGrantAuthority::ClearLocked() {
  grant_.reset(); valid_until_ = {};
  if (fence_ != std::numeric_limits<uint64_t>::max()) ++fence_;
}
bool SearchProducerGrantAuthority::FreshLocked() {
  if (!accepting_ || !grant_) return false;
  if (Now() >= valid_until_) { ClearLocked(); return false; }
  return true;
}
void SearchProducerGrantAuthority::Start() { std::lock_guard<std::mutex> lock(mutex_); ClearLocked(); accepting_ = true; }
void SearchProducerGrantAuthority::Stop() { std::lock_guard<std::mutex> lock(mutex_); accepting_ = false; ClearLocked(); }
void SearchProducerGrantAuthority::Invalidate() { std::lock_guard<std::mutex> lock(mutex_); ClearLocked(); }
bool SearchProducerGrantAuthority::Install(const ParsedSearchProducerGrant& parsed, std::chrono::steady_clock::time_point request_started) {
  // Allocate small strings before the atomic publication lock. An allocation
  // failure cannot expose a partially replaced grant to inference-side readers.
  std::string revision = parsed.grant ? parsed.grant->revision : "";
  std::string content_fingerprint = parsed.content_fingerprint;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!accepting_) return false;
  if (!parsed.grant) { ClearLocked(); return true; }
  const auto now = Now();
  if (grant_ && now >= valid_until_) ClearLocked(); // A renewal after an expired gap cannot resurrect old leases.
  const auto expires = request_started + parsed.valid_for;
  if (parsed.valid_for != std::chrono::milliseconds(30000) || request_started > now || now >= expires || fence_ == std::numeric_limits<uint64_t>::max()) {
    ClearLocked(); return false;
  }
  if (parsed.grant->revision == last_revision_ && parsed.content_fingerprint != last_content_fingerprint_) {
    ClearLocked(); return false;
  }
  if (!grant_ || parsed.grant->revision != last_revision_) {
    grant_ = parsed.grant; ++fence_;
  }
  last_revision_ = std::move(revision); last_content_fingerprint_ = std::move(content_fingerprint);
  valid_until_ = expires;
  return true;
}
std::optional<SearchProducerLease> SearchProducerGrantAuthority::Read() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!FreshLocked()) return std::nullopt;
  SearchProducerLease lease; lease.grant = grant_; lease.fence = fence_; lease.valid_until = valid_until_; lease.authority_ = weak_from_this();
  return lease;
}
bool SearchProducerGrantAuthority::IsCurrent(const SearchProducerLease& lease) {
  std::lock_guard<std::mutex> lock(mutex_);
  return FreshLocked() && lease.fence == fence_ && lease.grant == grant_;
}
bool SearchProducerLease::IsCurrent() const {
  const auto authority = authority_.lock(); return authority && authority->IsCurrent(*this);
}
}  // namespace ai_service::config
