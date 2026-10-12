// Copyright AINVR. Adapted for the S100P service.
#include "../utils/log.hpp"
#include "config_center_client.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>

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
                                       int poll_interval_seconds)
    : base_url_(std::move(base_url)),
      service_name_(std::move(service_name)),
      service_token_(std::move(service_token)),
      on_apply_(std::move(on_apply)),
      poll_interval_(poll_interval_seconds) {}

ConfigCenterClient::~ConfigCenterClient() { Stop(); }

void ConfigCenterClient::Start() {
  stop_event_.store(false);
  thread_ = std::thread([this] { RunLoop(); });
}

void ConfigCenterClient::Stop() {
  stop_event_.store(true);
  wait_cond_.notify_all();
  if (thread_.joinable()) thread_.join();
}

std::optional<int64_t> ConfigCenterClient::AppliedVersion() const {
  std::lock_guard<std::mutex> lock(version_mutex_);
  return applied_version_;
}

void ConfigCenterClient::RunLoop() {
  AI_LOG(kInfo, "ai-service.config-center", "[config-center] 启动:service=" << service_name_ << " base=" << base_url_
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
  } catch (const std::exception& e) {
    AI_LOG(kError, "ai-service.config-center", "[config-center] 更新异常: " << e.what());
    BumpRetry();
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
                                                          const nlohmann::json* body) {
  try {
    httplib::Client cli(base_url_);
    cli.set_connection_timeout(5);
    cli.set_read_timeout(5);
    std::string full_path = "/api/v1/config" + path;

    httplib::Headers headers;
    if (!service_token_.empty()) headers.emplace("X-Service-Token", service_token_);

    std::string body_str = body ? body->dump() : "{}";
    httplib::Result res = (method == "GET")
                              ? cli.Get(full_path.c_str(), headers)
                              : cli.Post(full_path.c_str(), headers, body_str, "application/json");
    if (!res || res->status < 200 || res->status >= 300) {
      AI_LOG(kWarning, "ai-service.config-center", "[config-center] HTTP " << (res ? res->status : -1) << ": " << method << " "
                << path);
      return std::nullopt;
    }
    json result = json::parse(res->body, nullptr, false);
    if (result.is_discarded()) return std::nullopt;
    if (result.value("code", -1) != 0) {
      AI_LOG(kWarning, "ai-service.config-center", "[config-center] 返回非 0: " << result.value("error", ""));
      return std::nullopt;
    }
    return result.value("data", json());
  } catch (const std::exception& e) {
    AI_LOG(kError, "ai-service.config-center", "[config-center] 不可达: " << e.what());
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
  } catch (const std::exception& e) {
    AI_LOG(kError, "ai-service.config-center", "[config-center] 应用异常 v" << *desired << ": " << e.what());
    Fail(*desired, e.what());
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
