// Copyright AINVR. Adapted for the S100P service.
// 配置中心客户端 —— 对应共享的
// shared/python/config_center_client.py(AI 微服务/录像微服务共享的唯一
// 真源)。协议细节见 docs/v1_parity_design.md §1.4:轮询 desiredVersion
// -> 拉版本快照 -> 校验应用 -> 上报状态,X-Service-Token 鉴权,指数退避。
#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include <nlohmann/json_fwd.hpp>

namespace ai_service::config {

// on_apply 返回 (ok, restart_required)。ok=false 或抛异常都算失败,触发
// 指数退避重试。
using ApplyResult = std::pair<bool, bool>;
using ApplyCallback = std::function<ApplyResult(const nlohmann::json&)>;

// 分服务令牌环境变量名(与 BFF serviceTokens.ts 的映射同规则):
// CONFIG_SERVICE_TOKEN_<SERVICE>(服务名大写、短横线转下划线)。
std::string ServiceTokenEnvName(const std::string& service_name);

class ConfigCenterClient {
 public:
  ConfigCenterClient(std::string base_url, std::string service_name, std::string service_token,
                      ApplyCallback on_apply, int poll_interval_seconds = 10);
  ~ConfigCenterClient();

  ConfigCenterClient(const ConfigCenterClient&) = delete;
  ConfigCenterClient& operator=(const ConfigCenterClient&) = delete;

  void Start();
  void Stop();

  std::optional<int64_t> AppliedVersion() const;
  int PollInterval() const { return poll_interval_; }

 private:
  void RunLoop();
  void TryUpdate();
  void DoUpdate();
  void BumpRetry();
  void ResetRetry();
  void Fail(int64_t version, const std::string& error);
  bool EverHadConfig();
  std::optional<nlohmann::json> MergeDocuments(const nlohmann::json& docs);
  bool Report(int64_t version, const std::string& status, bool restart_required,
              const std::string& error);
  // GET(body=nullptr)/POST;path 不含 /api/v1/config 前缀(内部拼接)。
  // 失败(网络/非 2xx/JSON 解析失败)返回 nullopt,不抛异常——跟 v1
  // "配置中心不可达时静默等下一轮"的语义一致。
  std::optional<nlohmann::json> Request(const std::string& path, const std::string& method,
                                        const nlohmann::json* body);

  std::string base_url_;
  std::string service_name_;
  std::string service_token_;
  ApplyCallback on_apply_;
  int poll_interval_;

  std::thread thread_;
  std::atomic<bool> stop_event_{false};
  std::mutex wait_mutex_;
  std::condition_variable wait_cond_;

  mutable std::mutex version_mutex_;  // AppliedVersion() 是 const 方法,要能加锁读
  std::optional<int64_t> applied_version_;
  double retry_delay_s_ = 5.0;

  static constexpr double kRetryBaseSeconds = 5.0;
  static constexpr double kRetryMaxSeconds = 300.0;
};

// 从环境变量构建客户端;未配置 CONFIG_CENTER_URL 时返回 nullptr(禁用
// 接入,main.cpp 据此决定要不要 Start())。环境变量:
//   CONFIG_CENTER_URL               BFF 地址,如 http://127.0.0.1:3001
//   CONFIG_SERVICE_TOKEN_<SERVICE>  分服务令牌(优先)
//   CONFIG_SERVICE_TOKEN            旧共享令牌(回退)
//   CONFIG_CENTER_POLL              轮询秒数(可选,默认 10)
std::unique_ptr<ConfigCenterClient> ClientFromEnv(const std::string& service_name,
                                                  ApplyCallback on_apply,
                                                  int poll_interval_seconds = 10);

}  // namespace ai_service::config
