// HTTP 控制面 —— 对应 Python api/app.py(健康检查/通道管理/结果查询)。
// 详见 docs/v1_parity_design.md §1.1/§1.2/§3.7。
//
// 快照查询端点共用真实 SnapshotStore。归档开关控制新截图，关闭后历史仍可访问。
// 授权放行后可为停止的通道按需创建归档器；与启停、更新、删除共用通道操作锁。
#pragma once

#include <functional>
#include <future>
#include <map>
#include <optional>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../config/config_store.hpp"
#include "../output/snapshot_store.hpp"
#include "../pipeline/managed_worker.hpp"

namespace httplib {
class Server;
}

namespace ai_service::api {

// 对应 Python 的 HTTPException:状态码 + {code, message}。
class ApiError : public std::runtime_error {
 public:
  ApiError(int status_code, std::string code, std::string message)
      : std::runtime_error(message), status_code_(status_code), code_(std::move(code)) {}

  int status_code() const { return status_code_; }
  const std::string& code() const { return code_; }

  // {"error": {"code": ..., "message": ...}}
  nlohmann::json ToJson() const;

 private:
  int status_code_;
  std::string code_;
};

// 给 patch 里出现过的每个顶层字段判定生效方式(hot/restart/rejected),
// 供 API 响应的 applied_via 用。§1.2 的三档热更新协议。
// Model root for resolving relative LocateAnything paths during save-time validation.
void SetLocateAnythingModelRoot(std::string root);
std::map<std::string, std::string> ClassifyChannelPatch(const nlohmann::json& patch);

// 写入入口(创建/修改)的输出流冲突检查,只检查涉及 changed_id 这个通道
// 的冲突。按 app/stream 比较,忽略 host/端口/查询串(同一 SRS 的
// 127.0.0.1/局域网 IP/localhost 是同一路流)。有冲突返回给人看的原因。
std::optional<std::string> FindOutputConflict(const std::vector<config::ChannelConfig>& channels,
                                              const std::string& changed_id);

// 该通道的识别快照归档是否需要人脸增强模型:只有人脸检测通道 + 选了增强
// 模型才会用到,其余通道预加载只是白占显存。
bool NeedsFaceEnhancer(const config::ChannelConfig& cfg);

using WorkerFactory = std::function<std::shared_ptr<pipeline::ChannelWorker>(
    const config::ChannelConfig&, const config::SnapshotStoreConfig&)>;

// 通道管理器 —— 持有所有 ChannelWorker 实例 + 配置持久化。
class ChannelManager {
 public:
  ~ChannelManager();
  void ScheduleAllEnabled();
  explicit ChannelManager(config::AppConfig config,
                           std::shared_ptr<config::ConfigStore> store = nullptr,
                           WorkerFactory worker_factory = nullptr,
                           std::function<bool()> license_check = {},
                           std::function<void(const config::SnapshotStoreConfig&, const std::string&)> history_delete = {},
                           config::SearchProducerLeaseReader search_producer_reader = {},
                           std::shared_ptr<output::SearchSamplingOwner> search_sampling_owner = {});

  // 404 ApiError(不存在)。
  std::shared_ptr<pipeline::ChannelWorker> Get(const std::string& channel_id) const;

  std::vector<nlohmann::json> ListAll() const;

  // 为每个已在 channels_ 里的通道调用 Start()(构造函数只为
  // enabled=true 的通道创建 Worker,不自动启动——对应 v1
  // ChannelManager 的既有限制)。main.cpp 在 HTTP server 开始监听之后
  // 才在后台线程调用这个方法,不能反过来(§3.8:顺序反了会让多通道启动
  // 累计阻塞时间拖垮 systemd 的存活探测窗口)。每个 Start() 可能阻塞最
  // 长 30s,调用方必须自己放到后台线程,这个方法本身是同步阻塞的。
  void StartAllEnabled();

  // 授权失权收尾（设计 §16）：停掉全部运行中通道，走各 worker 既有
  // Stop() 生命周期（按既有方式释放推理/推流资源，不 SIGKILL 进程）。
  // 幂等：idle/error 通道跳过，不抛 409。与 StartAllEnabled 对称，调用
  // 方必须放在后台线程（Stop 也可能阻塞）。
  void StopAll();

  double StartTime() const { return start_time_; }
  size_t ChannelCount() const;
  size_t RunningCount() const;
  nlohmann::json GlobalStats() const;
  // Cached business readiness, without synchronous database operations.
  nlohmann::json BusinessHealth() const;

  // 同一通道的启停与增删改串行(见 control_server.cpp 的并发模型说明)。
  // 404/409 以 ApiError 抛出。
  void StartChannel(const std::string& channel_id);
  void StopChannel(const std::string& channel_id);

  // 三期通道 CRUD(需要 store,否则 501 ApiError)。
  nlohmann::json CreateChannel(const nlohmann::json& patch);
  void DeleteChannel(const std::string& channel_id);
  int64_t DeleteSnapshots(const std::string& channel_id, const std::optional<std::string>& image_id,
                         std::optional<double> from_ts = {}, std::optional<double> to_ts = {});
  // 响应体形状:{applied, applied_via, hot_fields, restart, channel}
  nlohmann::json UpdateChannelConfig(const std::string& channel_id, const nlohmann::json& patch);

  nlohmann::json ChannelView(const std::string& channel_id,
                              std::shared_ptr<pipeline::ChannelWorker> worker) const;

  std::shared_ptr<config::ConfigStore> Store() const { return store_; }
  // api_key 动态读取:配置中心/运行时 API 改 overlay 后无需重启即生效。
  std::optional<std::string> CurrentApiKey() const;

  // 只读取已安装的归档器；缺失不代表截图开关关闭。
  std::shared_ptr<output::SnapshotStore> GetSnapshotStore(const std::string& channel_id) const;
  // 识别历史路由用：授权未就绪/授权收尾时没建成归档器，授权恢复后按需补建，
  // 手动停止的通道也能查看历史；只恢复历史访问，不启动识别。不能在持有 lock_ 时调用。
  std::shared_ptr<output::SnapshotStore> HistoryStore(const std::string& channel_id);
  // 缺失原因：等待授权、删除中、收尾中或暂不可用。
  std::string HistoryUnavailableReason(const std::string& channel_id) const;

  nlohmann::json AnalyticsEvents(const std::string& channel_id,int limit);

 private:
  config::ConfigStore& RequireStore();
  std::string WaitForRestart(pipeline::ChannelWorker& worker, double timeout_s = 10.0) const;
  // 授权允许且未删除时创建归档器；关闭截图也保留历史访问。不能持有 lock_。
  std::shared_ptr<output::SnapshotStore> BuildSnapshotStore(
      const config::ChannelConfig& cfg, const config::SnapshotStoreConfig& ss) const;
  // 持有 lock_ 时调用:把 worker/归档器装进 map(归档器注入 worker),返回被
  // 替换下来的旧归档器——它的析构会 join 写入线程,调用方必须在锁外释放。
  std::shared_ptr<output::SnapshotStore> InstallLocked(
      const std::string& channel_id, std::shared_ptr<pipeline::ChannelWorker> worker,
      std::shared_ptr<output::SnapshotStore> snapshot_store);
  std::shared_ptr<std::mutex> OpLock(const std::string& channel_id);

  std::shared_ptr<pipeline::ChannelWorker> MakeWorker(const config::ChannelConfig& cfg,
                                                      const config::SnapshotStoreConfig& ss) const;

  bool LicenseAllowed() const;
  void ReconcileChannel(const std::string& id);
  void StartEnabled(const std::string& id);
  void RequireLicense() const;
  void RequireNotDeleting(const std::string& id) const;
  // Durable operator stop; caller holds the channel operation lock.
  void PersistOperatorStop(const std::string& channel_id, bool stopped);
  std::set<std::string> deletion_pending_;  // lock_ protected, persisted in channel config
  std::function<void(const config::SnapshotStoreConfig&, const std::string&)> history_delete_;
  void PrepareSnapshot(const std::string& id, const std::shared_ptr<pipeline::ChannelWorker>& worker);
  // 调用方必须持有 OpLock(id)；创建、复核授权和安装只走这一处。
  // DeleteSnapshots/PrepareSnapshot 已持锁，不能再调用公开的 HistoryStore。
  std::shared_ptr<output::SnapshotStore> EnsureSnapshotLocked(
      const std::string& id, const std::shared_ptr<pipeline::ChannelWorker>& worker);
  std::function<bool()> license_check_;
  config::SearchProducerLeaseReader search_producer_reader_;
  std::shared_ptr<output::SearchSamplingOwner> search_sampling_owner_;
  std::set<std::string> manually_stopped_; // lock_ protected; preserved across license recovery
  WorkerFactory worker_factory_;
  config::AppConfig boot_cfg_;
  std::optional<std::string> boot_api_key_;
  std::shared_ptr<config::ConfigStore> store_;
  std::map<std::string, std::shared_ptr<pipeline::ChannelWorker>> channels_;
  std::map<std::string, std::shared_ptr<output::SnapshotStore>> snapshot_stores_;
  std::map<std::string, std::shared_ptr<std::mutex>> op_locks_;  // lock_ 保护
  std::mutex config_mutex_;
  mutable std::mutex lock_;
  double start_time_;
  struct Retry { unsigned failures=0; double after=0; double started=0; };
  std::map<std::string,Retry> retries_; // lock_
  std::atomic<bool> cancelling_starts_{false};
  std::mutex reconcile_mutex_;
  std::map<std::string,std::future<void>> starts_; // reconcile_mutex_
};

// 注册全部路由(§1.1 的 18 条)到 server 上。server 生命周期由调用方
// (main.cpp)持有和 Listen();这里只做路由注册,不阻塞。
// The S100P entry point supplies its EXISTING affine search hardware owner.
// A missing callback is unavailable, never an alternate encoder or thread.
using SearchReencodeImage = std::function<nlohmann::json(const nlohmann::json&,const std::string&)>;
void RegisterRoutes(httplib::Server& server, std::shared_ptr<ChannelManager> manager,
                    std::function<nlohmann::json()> runtime_health = {},SearchReencodeImage search_reencode = {});

}  // namespace ai_service::api
