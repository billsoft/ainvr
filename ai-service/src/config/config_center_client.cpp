// Copyright AINVR. Adapted for the S100P service.
#include "../utils/log.hpp"
#include "config_center_client.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>
#include <chrono>
#include <regex>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace ai_service::config {

using nlohmann::json;

std::string ServiceTokenEnvName(const std::string& service_name) {
  std::string upper = service_name;
  std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  std::replace(upper.begin(), upper.end(), '-', '_');
  return "CONFIG_SERVICE_TOKEN_" + upper;
}

ConfigCenterClient::ConfigCenterClient(std::string base_url, std::string service_name,
                                       std::string service_token, ApplyCallback on_apply,
                                       int poll_interval_seconds, SearchProducerClock producer_clock)
    : base_url_(std::move(base_url)),
      service_name_(std::move(service_name)),
      service_token_(std::move(service_token)),
      on_apply_(std::move(on_apply)),
      poll_interval_(poll_interval_seconds),
      producer_authority_(std::make_shared<SearchProducerGrantAuthority>(std::move(producer_clock))) {
  if (poll_interval_ < 1 || poll_interval_ > 300 ||
      !std::regex_match(service_name_, std::regex("[a-z0-9][a-z0-9_-]{0,63}")) || service_token_.size() > 512 ||
      std::any_of(service_token_.begin(), service_token_.end(), [](unsigned char c) { return c < 32 || c == 127; }))
    throw std::invalid_argument("invalid_configuration_client_settings");
}

ConfigCenterClient::~ConfigCenterClient() { Stop(); }

void ConfigCenterClient::Start() {
  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  if (thread_.joinable()) return;
  stop_event_.store(false);
  producer_authority_->Start();
  thread_ = std::thread([this] { RunLoop(); });
}

void ConfigCenterClient::Stop() {
  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  stop_event_.store(true);
  producer_authority_->Stop();
  wait_cond_.notify_all();
  if (thread_.joinable()) thread_.join();
}

std::optional<int64_t> ConfigCenterClient::AppliedVersion() const {
  std::lock_guard<std::mutex> lock(version_mutex_);
  return applied_version_;
}

std::optional<SearchProducerLease> ConfigCenterClient::GetSearchProducerGrant() const {
  return service_name_ == "ai-service" ? producer_authority_->Read() : std::nullopt;
}
SearchProducerLeaseReader ConfigCenterClient::SearchProducerReader() const {
  if (service_name_ != "ai-service") return {};
  return [authority = std::weak_ptr<SearchProducerGrantAuthority>(producer_authority_)] {
    const auto current = authority.lock();
    return current ? current->Read() : std::nullopt;
  };
}

void ConfigCenterClient::RunLoop() {
  AI_LOG(kInfo, "ai-service.config-center", "[config-center] started service=" << service_name_
            << " poll=" << poll_interval_ << "s");
  TryUpdate();  // 启动先试一次

  while (!stop_event_.load()) {
    double wait_s;
    {
      std::lock_guard<std::mutex> lock(version_mutex_);
      wait_s = (retry_delay_s_ > kRetryBaseSeconds) ? retry_delay_s_
                                                    : static_cast<double>(poll_interval_);
    }
    std::unique_lock<std::mutex> lock(wait_mutex_);
    wait_cond_.wait_for(lock, std::chrono::duration<double>(wait_s),
                        [this] { return stop_event_.load(); });
    if (stop_event_.load()) return;
    lock.unlock();
    TryUpdate();
  }
}

void ConfigCenterClient::TryUpdate() {
  try {
    DoUpdate();
  } catch (...) {
    AI_LOG(kError, "ai-service.config-center", "[config-center] config_update_failed");
    BumpRetry();
  }
  // Same owner and existing poll/backoff; unchanged AI config versions still
  // refresh this independent projection. No additional thread or scheduler.
  if (service_name_ == "ai-service" && !stop_event_.load()) RefreshSearchProducerGrant();
}

void ConfigCenterClient::RefreshSearchProducerGrant() {
  try {
    const auto started = producer_authority_->Now();
    RequestFailure failure = RequestFailure::Transport;
    auto document = Request("", "GET", nullptr, RequestTarget::SearchProducer, &failure);
    if (!document) {
      // A temporary network failure cannot extend the original lease. Explicit
      // rejection, malformed data and disable/pending revoke immediately.
      if (failure != RequestFailure::Transport) producer_authority_->Invalidate();
      return;
    }
    auto parsed = ParseSearchProducerGrant(*document);
    if (!stop_event_.load() && !producer_authority_->Install(parsed, started))
      AI_LOG(kWarning, "ai-service.config-center", "[config-center] producer_grant_rejected");
  } catch (...) {
    producer_authority_->Invalidate();
    AI_LOG(kWarning, "ai-service.config-center", "[config-center] invalid_producer_grant");
  }
}

void ConfigCenterClient::BumpRetry() {
  std::lock_guard<std::mutex> lock(version_mutex_);
  retry_delay_s_ = std::min(retry_delay_s_ * 2.0, kRetryMaxSeconds);
}

void ConfigCenterClient::ResetRetry() {
  std::lock_guard<std::mutex> lock(version_mutex_);
  retry_delay_s_ = kRetryBaseSeconds;
}

std::optional<nlohmann::json> ConfigCenterClient::Request(const std::string& path,
                                                          const std::string& method,
                                                          const nlohmann::json* body,
                                                          RequestTarget target, RequestFailure* failure) {
  constexpr size_t maximum = 8 * 1024 * 1024;
  auto mark = [&](RequestFailure value) { if (failure) *failure = value; };
  mark(RequestFailure::Transport);
  try {
    if (stop_event_.load()) return std::nullopt;
    std::string full_path;
    if (target == RequestTarget::SearchProducer) {
      if (service_name_ != "ai-service" || method != "GET" || body || !path.empty()) {
        mark(RequestFailure::Invalid); return std::nullopt;
      }
      full_path = "/api/internal/search/producer-config";
    } else {
      if ((method != "GET" && method != "POST") || path.empty() || path.front() != '/' ||
          path.size() > 1024 || path.find_first_of("\r\n") != std::string::npos) {
        mark(RequestFailure::Invalid); return std::nullopt;
      }
      full_path = "/api/v1/config" + path;
    }
    httplib::Client cli(base_url_);
    cli.set_connection_timeout(3); cli.set_read_timeout(3); cli.set_write_timeout(3);
    cli.set_follow_location(false); cli.set_keep_alive(false); cli.set_compress(false); cli.set_decompress(false);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    const auto proceed = [&] { return !stop_event_.load() && std::chrono::steady_clock::now() < deadline; };
    httplib::Request request; request.method = method; request.path = full_path;
    if (!service_token_.empty()) request.headers.emplace("X-Service-Token", service_token_);
    if (body) {
      request.body = body->dump();
      if (request.body.size() > maximum) { mark(RequestFailure::Invalid); return std::nullopt; }
      request.headers.emplace("Content-Type", "application/json");
    }
    std::string received;
    request.response_handler = [&](const httplib::Response& response) {
      if (!proceed()) return false;
      if (response.status < 200 || response.status >= 300) { mark(RequestFailure::Rejected); return false; }
      auto content_type = response.get_header_value("Content-Type");
      std::transform(content_type.begin(), content_type.end(), content_type.begin(), [](unsigned char c) { return char(std::tolower(c)); });
      if (content_type.rfind("application/json", 0) != 0 || (content_type.size() > 16 && content_type[16] != ';')) {
        mark(RequestFailure::Invalid); return false;
      }
      if (response.get_header_value_count("Content-Length") > 1) { mark(RequestFailure::Invalid); return false; }
      if (response.has_header("Content-Length")) {
        const auto length = response.get_header_value("Content-Length");
        if (length.empty() || length.size() > 10 || !std::all_of(length.begin(), length.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }) ||
            std::stoull(length) > maximum) { mark(RequestFailure::Invalid); return false; }
      }
      return true;
    };
    request.content_receiver = [&](const char* data, size_t size, uint64_t, uint64_t) {
      if (!proceed()) return false;
      if (size > maximum - received.size()) { mark(RequestFailure::Invalid); return false; }
      received.append(data, size); return true;
    };
    request.progress = [&](uint64_t, uint64_t) { return proceed(); };
    const auto response = cli.send(request);
    if (!response || response->status < 200 || response->status >= 300 || !proceed()) {
      AI_LOG(kWarning, "ai-service.config-center", "[config-center] request_unavailable service=" << service_name_
        << " target=" << (target == RequestTarget::Config ? "config" : "search-producer"));
      return std::nullopt;
    }
    // Parse errors can embed response content. Never log what() or the body.
    mark(RequestFailure::Invalid);
    auto result = json::parse(received, [](int depth, auto, auto&) {
      if (depth > 16) throw std::invalid_argument("configuration_response_depth");
      return true;
    });
    if (!proceed()) return std::nullopt;
    if (target == RequestTarget::SearchProducer) return result;
    if (!result.is_object() || result.value("code", -1) != 0) {
      AI_LOG(kWarning, "ai-service.config-center", "[config-center] response_rejected");
      return std::nullopt;
    }
    return result.value("data", json());
  } catch (...) {
    mark(RequestFailure::Invalid);
    AI_LOG(kWarning, "ai-service.config-center", "[config-center] request_failed");
    return std::nullopt;
  }
}

bool ConfigCenterClient::EverHadConfig() {
  auto docs = Request("/documents?service=" + service_name_, "GET", nullptr);
  if (!docs.has_value() || !docs->is_array()) return false;
  for (auto&& d : *docs) {
    if (d.value("group", "") == "system" && d.value("name", "") == "settings") return true;
  }
  return false;
}

std::optional<nlohmann::json> ConfigCenterClient::MergeDocuments(const nlohmann::json& docs) {
  if (!docs.is_array()) return std::nullopt;
  for (auto&& doc : docs) {
    if (doc.value("service", "") != service_name_) continue;
    if (doc.value("group", "") == "system" && doc.value("name", "") == "settings") {
      return doc.value("config", json::object());
    }
  }
  return std::nullopt;
}

void ConfigCenterClient::Fail(int64_t version, const std::string& error) {
  Report(version, "failed", false, error);
  BumpRetry();
}

bool ConfigCenterClient::Report(int64_t version, const std::string& status, bool restart_required,
                                const std::string& error) {
  std::optional<int64_t> current_applied;
  {
    std::lock_guard<std::mutex> lock(version_mutex_);
    current_applied = applied_version_;
  }
  // §1.4 已记录的坑:appliedVersion 只有 status=="applied" 时填这次的新
  // 版本号,status=="failed" 时必须填"当前仍然生效的旧版本号"——顺序
  // 反了会让 BFF 的漂移检测永久误报(v1 2026-09-16 修过这个真实 bug)。
  json body{
      {"appliedVersion",
       status == "applied" ? json(version) : (current_applied.has_value() ? json(*current_applied) : json(nullptr))},
      {"status", status},
      {"restartRequired", restart_required},
      {"errorMessage", error},
  };
  auto result = Request("/service-states/" + service_name_, "POST", &body);
  return result.has_value();
}

void ConfigCenterClient::DoUpdate() {
  auto state = Request("/service-states/" + service_name_, "GET", nullptr);
  if (!state.has_value()) return;  // 配置中心不可达/未注册,静默等下一轮,不退避

  std::optional<int64_t> desired;
  if (state->contains("desiredVersion") && !(*state)["desiredVersion"].is_null()) {
    desired = (*state)["desiredVersion"].get<int64_t>();
  } else if (state->contains("desired_version") && !(*state)["desired_version"].is_null()) {
    desired = (*state)["desired_version"].get<int64_t>();
  }

  std::optional<int64_t> current_applied;
  {
    std::lock_guard<std::mutex> lock(version_mutex_);
    current_applied = applied_version_;
  }
  if (!desired.has_value() || desired == current_applied) {
    ResetRetry();
    return;
  }

  auto snapshot =
      Request("/versions/" + std::to_string(*desired) + "/snapshot?service=" + service_name_,
              "GET", nullptr);
  if (!snapshot.has_value()) {
    Fail(*desired, "版本快照拉取失败");
    return;
  }

  auto config = MergeDocuments(*snapshot);
  if (!config.has_value()) {
    if (!current_applied.has_value() && !EverHadConfig()) {
      AI_LOG(kInfo, "ai-service.config-center", "[config-center] v" << *desired << " 无本服务配置,继续用本地兜底");
      if (Report(*desired, "applied", false, "")) {
        std::lock_guard<std::mutex> lock(version_mutex_);
        applied_version_ = *desired;
        retry_delay_s_ = kRetryBaseSeconds;
      } else {
        BumpRetry();
      }
    } else {
      Fail(*desired, "快照缺少本服务配置");
    }
    return;
  }

  ApplyResult result;
  try {
    result = on_apply_ ? on_apply_(*config) : ApplyResult{true, false};
  } catch (...) {
    AI_LOG(kError, "ai-service.config-center", "[config-center] config_apply_failed v" << *desired);
    Fail(*desired, "配置应用失败");
    return;
  }
  auto [ok, restart_required] = result;
  if (!ok) {
    Fail(*desired, "校验失败或被拒");
    return;
  }

  AI_LOG(kInfo, "ai-service.config-center", "[config-center] 应用成功 v" << *desired
            << (restart_required ? "(需要重启进程才完全生效)" : ""));
  if (Report(*desired, "applied", restart_required, "")) {
    std::lock_guard<std::mutex> lock(version_mutex_);
    applied_version_ = *desired;
    retry_delay_s_ = kRetryBaseSeconds;
  } else {
    AI_LOG(kError, "ai-service.config-center", "[config-center] v" << *desired << " 状态上报失败,下轮重试");
    BumpRetry();
  }
}

std::unique_ptr<ConfigCenterClient> ClientFromEnv(const std::string& service_name,
                                                  ApplyCallback on_apply,
                                                  int poll_interval_seconds) {
  const char* base = std::getenv("CONFIG_CENTER_URL");
  if (!base || std::string(base).empty()) return nullptr;

  std::string token_env = ServiceTokenEnvName(service_name);
  const char* token = std::getenv(token_env.c_str());
  std::string token_str = token ? token : "";
  if (token_str.empty()) {
    const char* legacy = std::getenv("CONFIG_SERVICE_TOKEN");
    if (legacy) token_str = legacy;
  }

  int poll = poll_interval_seconds;
  const char* poll_env = std::getenv("CONFIG_CENTER_POLL");
  if (poll_env) {
    try {
      poll = std::stoi(poll_env);
    } catch (...) {
    }
  }

  return std::make_unique<ConfigCenterClient>(base, service_name, token_str, std::move(on_apply),
                                              poll);
}

}  // namespace ai_service::config
