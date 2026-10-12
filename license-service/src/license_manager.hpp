#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <chrono>
#include <nlohmann/json.hpp>
#include "clock.hpp"
#include "fingerprint.hpp"
#include "license_payload.hpp"
#include "state_store.hpp"
#include "types.hpp"
namespace ainvr_license {
struct ActivateError {std::string code,message;};
class LicenseManager {
 public:
  LicenseManager(MachineInfo machine,std::shared_ptr<StateStore> store,Clock* clock);
  ~LicenseManager();
  LicenseManager(const LicenseManager&)=delete;
  LicenseManager& operator=(const LicenseManager&)=delete;
  void SetSignalKeys(std::unordered_map<std::string,Key32> keys);
  const MachineInfo& machine()const{return machine_;}
  void Init();
  nlohmann::json RegistrationRequest();
  StatusSnapshot status();
  std::optional<ActivateError> Activate(const std::string& key);
  std::optional<ActivateError> Remove();
  std::optional<ActivateError> Preview(const std::string& key,LicensePayload& out);
  void Tick();
  // 等待已入队的落盘全部完成（测试、优雅退出用；请求路径绝不调用）
  void Flush();
  void BuildSignedStatus(const std::string& client_id,const std::string& nonce,std::string& json_out,std::string& err_out);
 private:
  void InitLocked();
  void AdvanceLocked();
  // 同步落盘（激活/注销/启动时）：按入队顺序排在已排队的续期之后，等落盘确认才返回
  bool CommitLocked(LicenseRecord next);
  // 续期预算：只入队不等待。签发租约只用已确认落盘的预算(durable_reserved_ns_)
  void RequestReservationLocked(const LicenseRecord& at);
  void AbsorbPersistFaultLocked();
  StatusSnapshot SnapshotLocked()const;
  nlohmann::json DiagnosticLocked(const StatusSnapshot&)const;
  void ObserveLocked(const StatusSnapshot&);
  std::optional<ActivateError> ValidateLocked(const std::string&,LicensePayload&);
  MachineInfo machine_;
  std::shared_ptr<StateStore> store_;
  Clock* clock_;
  std::unordered_map<std::string,Key32> signal_keys_;
  std::mutex mu_;
  bool loaded_=false;
  std::optional<LicenseRecord> rec_;
  LicenseState fault_=LicenseState::kUnlicensed;
  std::string fault_reason_,epoch_;
  nlohmann::json last_calculation_=nlohmann::json::object();
  std::string last_observation_;
  std::chrono::steady_clock::time_point last_diagnostic_{};

  // ---- 落盘：独立的串行线程；全局锁 mu_ 只保护内存状态，绝不跨越磁盘等待（激活/注销除外，见 CommitLocked）----
  struct PersistResult {bool done=false,ok=false;std::string error;};
  struct PersistItem {LicenseRecord rec;bool sync=false;std::shared_ptr<PersistResult> result;std::chrono::steady_clock::time_point queued=std::chrono::steady_clock::now();};
  void PersistLoop();
  mutable std::mutex pmu_;               // mu_ may acquire pmu_; never the reverse
  std::condition_variable pcv_,done_cv_;
  std::deque<PersistItem> queue_;
  bool stop_=false,busy_=false;
  std::chrono::steady_clock::time_point persist_started_{};
  int64_t active_persist_seq_=0,active_persist_reserved_ns_=0;
  std::atomic<int64_t> durable_reserved_ns_{0};   // 已确认落盘的预算上限（租约只能用到这里）
  std::atomic<bool> persist_failed_{false};
  std::string persist_error_;            // 受 pmu_ 保护
  int64_t last_seq_=0;                   // 受 mu_ 保护：已分配的最大落盘序号，按入队顺序严格递增
  int64_t requested_reserved_ns_=0;      // 受 mu_ 保护：已请求(含在途)的预算上限，避免重复入队
  std::thread worker_;                   // 必须最后声明：线程在其余成员就绪后才启动
};
}
