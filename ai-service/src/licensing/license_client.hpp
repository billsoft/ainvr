#pragma once
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include <nlohmann/json.hpp>
namespace ai_service::licensing {
struct LicenseConfig {
  bool enabled=true;
  std::string client_id="ai-service",device_id,signal_key_hex;
  std::string uds_path="/run/ainvr-license/license.sock";
  int poll_sec=5,timeout_sec=3;
  bool peer_check=true;
  // Retain verified activation on renewal failure; false is isolated strict test mode.
  // Production environment cannot disable licensing or change this policy.
  bool retain_verified_grant=true;
};
LicenseConfig LoadConfigFromEnv(const std::string&);
struct TransportResult {int status=0;std::string body;};
using Fetcher=std::function<std::optional<TransportResult>(const std::string&,std::string&)>;
Fetcher MakeHttpFetcher(const LicenseConfig&);
std::string GenerateNonce();
class LicenseClient {
 public:
  using Clock=std::function<int64_t()>; // elapsed milliseconds, including suspend
  using PhaseChange=std::function<void(const std::string&,const std::string&)>;
  LicenseClient(LicenseConfig,Fetcher,Clock={});
  ~LicenseClient(){Stop();}
  std::string ChallengeOnce();
  std::string Phase();
  bool IsLicensed(){return Phase()=="valid";}
  nlohmann::json StatusSnapshot();
  nlohmann::json DecisionDiagnostics();
  bool Degraded();
  std::string LastError();
  // 日志出口由调用方注入（库本身不依赖日志实现，也便于测试断言）：level 为 "info"/"warn"
  using LogSink=std::function<void(const std::string& level,const std::string& message)>;
  void SetLogSink(LogSink);
  // 一次完整的轮询：请求签名 + 记录失败原因/耗时/恢复 + 相位变化日志。
  // 返回本次请求的错误文本（空=成功）。后台线程循环调用它，测试可直接驱动。
  std::string Tick(std::string* old_phase=nullptr,std::string* new_phase=nullptr);
  // 下一次轮询前的等待：上一次失败就快速重试（租约最长 30 秒，不能干等一个轮询周期）；
  // 租约只由成功的签名续，重试更勤快不会延长授权。
  int NextWaitMs();
  void Start(PhaseChange={});
  void Stop();
  bool running()const{return thread_.joinable();}
  bool WaitForValid(int timeout_sec);
 private:
  std::string PhaseLocked()const;
  bool RetainsGrantLocked(int64_t now)const;
  bool DegradedLocked()const;
  void Log(const char* level,const std::string&)const;
  LicenseConfig cfg_;
  Fetcher fetcher_;
  Clock clock_;
  std::vector<unsigned char>key_;
  mutable std::mutex mu_;
  std::mutex challenge_mu_;
  std::condition_variable cv_;
  std::thread thread_;
  bool stop_=false;
  std::optional<nlohmann::json>payload_;
  int64_t deadline_=0;
  std::string error_,config_error_;
  // 可观测性（受 mu_ 保护）
  LogSink sink_;
  bool last_ok_=true;
  int failures_=0;
  std::optional<int64_t> first_failure_ms_,last_success_ms_,last_failure_log_ms_;
  int64_t last_duration_ms_=0;
  std::string previous_phase_="starting";
  // 续查诊断状态（受 mu_ 保护）
  std::optional<int64_t> short_since_ms_,last_contact_ms_;
  int64_t last_took_ms_=0,licensed_until_ms_=0;   // 后者：签名里的总授权剩余折算的截止时刻，业务不能越过
  bool was_degraded_=false;
};
}
