#include "../analytics/event_store.hpp"
#include "control_server.hpp"
#include "search_reencode_http_contract.hpp"
#include "../output/search_sampling_owner.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <set>
#include <thread>

#include <httplib.h>
#include <openssl/crypto.h>

#include "../adapters/factory.hpp"
#include "../adapters/prompted_socket.hpp"
#include "../adapters/locateanything_result_decode.hpp"
#include "../platform/locateanything_executor_client.hpp"
#include "../utils/log.hpp"

namespace ai_service::api {

using nlohmann::json;

namespace {
double NowWall() {
  return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}
double NowMono() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
double RoundTo(double v, int decimals) {
  double f = std::pow(10.0, decimals);
  return std::round(v * f) / f;
}
}  // namespace

nlohmann::json ApiError::ToJson() const {
  return json{{"error", {{"code", code_}, {"message", what()}}}};
}

// ---- §1.2 三档热更新分类协议 ----

namespace {
// name 只用于展示和新识别记录,不参与拉流/推理/输出,改名不重启。
const std::set<std::string> kHotTopLevelFields = {"name", "inference_fps", "postprocess",
                                                   "result_buffer"};
const std::set<std::string> kStructuralTopLevelFields = {
    "enabled", "stream", "model", "preprocess", "max_consecutive_failures", "analytics"};
// Service-owned persisted state; clients may only change it through actions.
void RejectInternalFields(const nlohmann::json& patch) {
  if (patch.contains("snapshot") && patch["snapshot"].is_object() &&
      patch["snapshot"].contains("min_interval_ms") && patch["snapshot"]["min_interval_ms"] != 0)
    throw ApiError(422, "invalid_config", "归档必须逐帧保存，min_interval_ms 只能为 0；积压时自动降低本通道识别速度");
  if (patch.contains("deletion_pending"))
    throw ApiError(422, "invalid_config", "deletion_pending 是内部删除状态");
  if (patch.contains("manually_stopped"))
    throw ApiError(422, "invalid_config", "manually_stopped 是内部停止状态，请使用启动/停止操作");
}
const std::set<std::string> kKnownChannelFields = [] {
  std::set<std::string> s = kHotTopLevelFields;
  s.insert(kStructuralTopLevelFields.begin(), kStructuralTopLevelFields.end());
  s.insert("publish");
  s.insert("snapshot");
  return s;
}();
const std::set<std::string> kPublishHotSubfields = {"sei", "osd"};
const std::set<std::string> kSnapshotHotSubfields = {
    "enabled",
    "max_count",     "min_interval_ms",    "jpeg_quality",       "max_crop_dimension",
    "padding_ratio", "projection_mode",    "face_enhance_blend", "brightness_enabled",
    "brightness_target"};

// 设计文档 §4:yolo26_end2end/yolo26_traditional(ONNXRuntime)v2 不实现。
// 配置加载层仍然认得这两个值(旧 overlay 必须能原样启动),拦截放在写入
// 入口——校验通过就会落盘并建出 worker,要到 start() 才失败进 ERROR,
// 那是"看起来保存成功、其实不能用"的假成功。
void RejectUnportedAdapter(const json& channel_cfg) {
  std::string adapter = "yolo26_trt";  // ModelConfig 默认值
  if (channel_cfg.contains("model") && channel_cfg["model"].is_object()) {
    adapter = channel_cfg["model"].value("adapter", adapter);
  }
  auto available = adapters::AvailableAdapters();
  if (std::find(available.begin(), available.end(), adapter) == available.end()) {
    std::string joined;
    for (size_t i = 0; i < available.size(); ++i) joined += (i ? "/" : "") + available[i];
    throw ApiError(422, "invalid_config",
                   "model.adapter='" + adapter + "' 本服务未实现(可用: " + joined +
                       ");S100P 部署模型必须编译为 BPU 的 HBM 格式，禁止 CPU/CUDA 推理");
  }
}

bool KeysAreSubsetOf(const json& obj, const std::set<std::string>& allowed) {
  if (!obj.is_object()) return false;
  for (auto it = obj.begin(); it != obj.end(); ++it) {
    if (!allowed.count(it.key())) return false;
  }
  return true;
}
// Relative model paths resolve against the model root given to the service,
// as the channel workers do (the process cwd is the overlay directory).
std::string& LocateAnythingModelRoot() { static std::string root; return root; }

// Multi-category LocateAnything sends every label in one request;its total
// length must fit the compiled prefill profile, checked before saving.
void ValidateLocateAnythingQuery(const config::ModelConfig& model) {
  const std::string query = adapters::LocateAnythingQuery(model);
  std::filesystem::path path(model.path);
  if (path.is_relative() && !LocateAnythingModelRoot().empty())
    path = std::filesystem::path(LocateAnythingModelRoot()) / path;
  std::optional<ainvr::LocateAnythingExecutorClient> client;
  try {
    std::ifstream file(path.string() + ".ainvr.json");
    const auto generation = json::parse(file).at("generation");
    client.emplace(generation.at("socket").get<std::string>(),
                   generation.at("contract_sha256").get<std::string>(),
                   generation.at("maximum_seconds").get<double>());
    client->Health();
  } catch (const std::exception&) {
    throw ApiError(503, "runtime_unavailable", "开放词汇执行器不可用，无法校验识别描述，请检查服务状态");
  }
  bool valid = false;
  try { valid = client->Validate(query, model.max_new_tokens).value("valid", false); }
  catch (const std::exception&) {}
  if (!valid)
    throw ApiError(422, "invalid_prompt", "识别标签的描述总长度超过模型容量，请减少标签数量或缩短描述");
}

// Phase 1 opens tracking only;newly enabling a later-stage feature is refused
// explicitly instead of being accepted and silently not run.
void RejectUnavailableAnalytics(const json& requested,const json& stored) {
  const auto feature=analytics::PhaseUnavailableRequest(requested,stored);
  if(feature.empty())return;
  const std::string name=feature=="rules"?"区域规则与事件":feature=="review"?"大模型复核":"报警通知";
  throw ApiError(422,"feature_unavailable","当前版本只开放目标跟踪与轨迹显示，"+name+"尚未开放");
}

void ValidatePromptBeforeSave(const json& channel) {
  config::ChannelConfig cfg;
  try { cfg = config::ChannelConfigFromJson(channel); }
  catch (const config::ConfigValidationError& e) { throw ApiError(422, "invalid_config", e.what()); }
  // Validate writes, not config loading: legacy channels must remain readable.
  if (cfg.analytics.enabled && (cfg.model.adapter == "locateanything_bpu" ||
      (cfg.inference_fps > 0 && cfg.inference_fps < 3.0)))
    throw ApiError(422, "tracking_rate_required", "目标跟踪要求至少 3 FPS；低频模型请关闭跟踪后保存。计数及穿过需要轨迹。");
  if (cfg.model.adapter == "locateanything_bpu") return ValidateLocateAnythingQuery(cfg.model);
  if (cfg.model.adapter != "yoloe_pt" && cfg.model.adapter != "locateanything_trt") return;
  json result;
  try { result = adapters::PromptedSocketAdapter::ValidatePrompt(cfg.model.path, cfg.model.description,
                                                               cfg.model.max_new_tokens); }
  catch (const std::exception&) {
    throw ApiError(503, "runtime_unavailable", "开放词汇执行器不可用，无法校验识别描述，请检查服务状态");
  }
  if (!result.value("valid", false))
    throw ApiError(422, "invalid_prompt", "识别描述或生成长度超过模型容量，请缩短描述或降低生成长度");
}
}  // namespace

void SetLocateAnythingModelRoot(std::string root) { LocateAnythingModelRoot() = std::move(root); }

std::map<std::string, std::string> ClassifyChannelPatch(const nlohmann::json& patch) {
  std::map<std::string, std::string> applied_via;
  if (!patch.is_object()) return applied_via;
  for (auto it = patch.begin(); it != patch.end(); ++it) {
    const std::string& key = it.key();
    if (key == "publish") {
      applied_via[key] = KeysAreSubsetOf(it.value(), kPublishHotSubfields) ? "hot" : "restart";
    } else if (key == "snapshot") {
      applied_via[key] = KeysAreSubsetOf(it.value(), kSnapshotHotSubfields) ? "hot" : "restart";
    } else if (key == "model") {
      applied_via[key] = KeysAreSubsetOf(it.value(), {"description", "label_id", "label_name", "max_new_tokens", "prompts", "class_names"})
                            ? "hot" : "restart";
    } else if (kHotTopLevelFields.count(key)) {
      applied_via[key] = "hot";
    } else if (kStructuralTopLevelFields.count(key)) {
      applied_via[key] = "restart";
    } else {
      applied_via[key] = "rejected";
    }
  }
  return applied_via;
}

// ---- ChannelManager ----

namespace {
// rtmp://host[:port]/app/stream[?q]、http://host/app/stream.flv → "app/stream"。
// 与前端 utils/channelMatching.ts 的 parseStreamPath 一致:忽略 host/端口。
std::string StreamKey(const std::string& url) {
  auto scheme = url.find("://");
  std::string rest = scheme == std::string::npos ? url : url.substr(scheme + 3);
  auto slash = rest.find('/');
  if (slash == std::string::npos) return "";
  std::string path = rest.substr(slash + 1);
  auto q = path.find_first_of("?#");
  if (q != std::string::npos) path.resize(q);
  while (!path.empty() && path.back() == '/') path.pop_back();
  if (path.size() > 4 && path.compare(path.size() - 4, 4, ".flv") == 0) path.resize(path.size() - 4);
  return path;
}

std::string OutputKey(const config::ChannelConfig& c) {
  if (!c.publish.enabled || !c.publish.target_url.has_value()) return "";
  return StreamKey(*c.publish.target_url);
}

// 写入入口:按"写入后的完整通道列表"检查 changed_id 涉及的输出冲突。
void RejectOutputConflicts(const json& channels, const std::string& changed_id) {
  std::vector<config::ChannelConfig> parsed;
  for (auto&& c : channels) parsed.push_back(config::ChannelConfigFromJson(c));
  if (auto msg = FindOutputConflict(parsed, changed_id)) {
    throw ApiError(422, "output_conflict", *msg);
  }
}
}  // namespace

std::optional<std::string> FindOutputConflict(const std::vector<config::ChannelConfig>& channels,
                                              const std::string& changed_id) {
  auto self = std::find_if(channels.begin(), channels.end(),
                           [&](auto&& c) { return c.id == changed_id; });
  if (self == channels.end()) return std::nullopt;
  std::string in = StreamKey(self->stream.url);
  std::string out = OutputKey(*self);
  if (!out.empty() && out == in) {
    return "输出流 " + out + " 与本通道源流相同,自己拉自己推会形成回环";
  }
  for (auto&& other : channels) {
    if (other.id == changed_id) continue;
    std::string other_in = StreamKey(other.stream.url);
    std::string other_out = OutputKey(other);
    if (!out.empty() && out == other_out) {
      return "输出流 " + out + " 已被 AI 通道 " + other.id + " 使用,两路推同一个流名会互相挤掉";
    }
    if (!out.empty() && out == other_in) {
      return "输出流 " + out + " 是 AI 通道 " + other.id + " 的源流,推进去会覆盖它的原始画面";
    }
    if (!in.empty() && in == other_out) {
      return "源流 " + in + " 是 AI 通道 " + other.id + " 的输出流,请选择原始源流";
    }
  }
  return std::nullopt;
}

bool NeedsFaceEnhancer(const config::ChannelConfig& cfg) {
  const auto& model = cfg.snapshot.face_enhance_model;
  if (model != "gpen" && model != "codeformer") return false;
  try {
    // 只构造不 Load:任务类型推导不碰 GPU(见 BaseModelAdapter::ApplyTaskTypeHint)
    return adapters::CreateAdapter(cfg.model)->TaskType() == "face_detection";
  } catch (const std::exception&) {
    return false;
  }
}

ChannelManager::ChannelManager(config::AppConfig config, std::shared_ptr<config::ConfigStore> store,
                               WorkerFactory worker_factory, std::function<bool()> license_check,
                               std::function<void(const config::SnapshotStoreConfig&, const std::string&)> history_delete,
                               config::SearchProducerLeaseReader search_producer_reader,
                               std::shared_ptr<output::SearchSamplingOwner> search_sampling_owner)
    : history_delete_(history_delete ? std::move(history_delete) : output::SnapshotStore::DropChannelHistory),
      license_check_(std::move(license_check)), search_producer_reader_(std::move(search_producer_reader)),
      search_sampling_owner_(std::move(search_sampling_owner)),
      worker_factory_(std::move(worker_factory)), boot_cfg_(config),
      boot_api_key_(config.server.api_key), store_(std::move(store)), start_time_(NowWall()) {
  for (auto&& ch_cfg : config.channels) {
    if (!ch_cfg.enabled && !ch_cfg.deletion_pending) continue;
    if (ch_cfg.deletion_pending) deletion_pending_.insert(ch_cfg.id);
    if (ch_cfg.manually_stopped) manually_stopped_.insert(ch_cfg.id);
    // 与运行时一致:阻塞的归档器启动(Mongo ping/增强预加载)在锁外做
    auto worker = MakeWorker(ch_cfg, config.snapshot_store);
    auto snapshot_store = BuildSnapshotStore(ch_cfg, config.snapshot_store);
    std::lock_guard<std::mutex> lock(lock_);
    InstallLocked(ch_cfg.id, std::move(worker), std::move(snapshot_store));
  }
}

std::shared_ptr<pipeline::ChannelWorker> ChannelManager::MakeWorker(
    const config::ChannelConfig& cfg, const config::SnapshotStoreConfig& ss) const {
  if (!worker_factory_) throw std::logic_error("S100P worker factory is required");
  auto worker = worker_factory_(cfg, ss);
  if (!worker) throw std::logic_error("Worker factory returned null");
  worker->SetLicenseCheck(license_check_);
  worker->SetSearchProducerLeaseReader(search_producer_reader_);
  if (search_sampling_owner_)
    worker->SetSearchSamplingSource(search_sampling_owner_->CreateSource(cfg.id));
  return worker;
}

std::shared_ptr<output::SnapshotStore> ChannelManager::BuildSnapshotStore(
    const config::ChannelConfig& cfg, const config::SnapshotStoreConfig& ss) const {
  if (cfg.deletion_pending || cancelling_starts_.load() || !LicenseAllowed()) return nullptr;
  auto store = std::make_shared<output::SnapshotStore>(
      cfg.snapshot, ss.mongo_uri, ss.db_name, cfg.id, cfg.name, ss.face_enhance_engine,
      ss.face_enhance_codeformer_engine, /*queue_maxsize=*/64, NeedsFaceEnhancer(cfg),
      output::SnapshotStore::PendingDirectory(cfg.id));
  store->Start(/*keep_history_access=*/true);  // Disabled capture still exposes existing history.
  if (cancelling_starts_.load() || !LicenseAllowed()) return nullptr;
  return store;
}

std::shared_ptr<output::SnapshotStore> ChannelManager::InstallLocked(
    const std::string& channel_id, std::shared_ptr<pipeline::ChannelWorker> worker,
    std::shared_ptr<output::SnapshotStore> snapshot_store) {
  std::shared_ptr<output::SnapshotStore> old_store;
  auto it = snapshot_stores_.find(channel_id);
  if (it != snapshot_stores_.end()) {
    old_store = std::move(it->second);
    snapshot_stores_.erase(it);
  }
  if (snapshot_store) {
    worker->SetSnapshotSink(snapshot_store);
    snapshot_stores_[channel_id] = std::move(snapshot_store);
  }
  channels_[channel_id] = std::move(worker);
  return old_store;  // 析构会 join 写入线程,调用方在锁外释放
}

std::shared_ptr<std::mutex> ChannelManager::OpLock(const std::string& channel_id) {
  std::lock_guard<std::mutex> lock(lock_);
  auto& m = op_locks_[channel_id];
  if (!m) m = std::make_shared<std::mutex>();
  return m;
}

std::shared_ptr<output::SnapshotStore> ChannelManager::GetSnapshotStore(
    const std::string& channel_id) const {
  std::lock_guard<std::mutex> lock(lock_);
  auto it = snapshot_stores_.find(channel_id);
  return it == snapshot_stores_.end() ? nullptr : it->second;
}

std::shared_ptr<pipeline::ChannelWorker> ChannelManager::Get(const std::string& channel_id) const {
  std::lock_guard<std::mutex> lock(lock_);
  auto it = channels_.find(channel_id);
  if (it == channels_.end()) {
    throw ApiError(404, "unknown_channel", "通道不存在: " + channel_id);
  }
  return it->second;
}

size_t ChannelManager::ChannelCount() const {
  std::lock_guard<std::mutex> lock(lock_);
  return channels_.size();
}

size_t ChannelManager::RunningCount() const {
  std::lock_guard<std::mutex> lock(lock_);
  return std::count_if(channels_.begin(), channels_.end(), [](auto&& kv) {
    return kv.second->State() == pipeline::ChannelState::kRunning;
  });
}

nlohmann::json ChannelManager::ChannelView(const std::string& channel_id,
                                            std::shared_ptr<pipeline::ChannelWorker> worker) const {
  auto cfg = worker->Config();
  json cfg_dict = config::ChannelConfigToJson(*cfg, /*include_id=*/false);
  { std::lock_guard<std::mutex> guard(lock_);
    cfg_dict["deletion_pending"] = deletion_pending_.count(channel_id) != 0;
    cfg_dict["manually_stopped"] = manually_stopped_.count(channel_id) != 0; }
  if (cfg_dict.contains("publish") && cfg_dict["publish"].is_object()) {
    // 前端播放衍生流不能自己拼 `${id}-ai`——target_url 用户可能改过,这里
    // 把 channel_worker 实际用的 target_url 镜像一份给前端直接消费。
    cfg_dict["publish"]["effective_target_url"] =
        cfg->publish.target_url.has_value() ? json(*cfg->publish.target_url) : json(nullptr);
  }
  return json{
      {"id", channel_id},
      {"name", cfg->name},
      {"state", pipeline::ToString(worker->State())},
      {"config", cfg_dict},
      {"analytics_reset_supported", worker->SupportsAnalyticsReset()},
      {"stats", worker->GetStats()},
  };
}

bool ChannelManager::LicenseAllowed() const {
  try { return !license_check_ || license_check_(); } catch (...) { return false; }
}
void ChannelManager::RequireLicense() const {
  if (!LicenseAllowed()) throw ApiError(503, "LICENSE_REQUIRED", "授权租约无效");
}
void ChannelManager::RequireNotDeleting(const std::string& id) const {
  std::lock_guard<std::mutex> guard(lock_);
  if (deletion_pending_.count(id))
    throw ApiError(409, "deletion_pending", "通道删除待完成，请重试删除；不能启动或修改");
}
void ChannelManager::PrepareSnapshot(const std::string& id, const std::shared_ptr<pipeline::ChannelWorker>& worker) {
  RequireLicense();
  if (!EnsureSnapshotLocked(id, worker))
    throw ApiError(503, "archive_unavailable", "归档访问尚未就绪，请稍后重试");
}
std::shared_ptr<output::SnapshotStore> ChannelManager::HistoryStore(const std::string& id) {
  Get(id);  // 未知通道不创建操作锁。
  auto op = OpLock(id);
  std::lock_guard<std::mutex> op_guard(*op);
  return EnsureSnapshotLocked(id, Get(id));
}
std::shared_ptr<output::SnapshotStore> ChannelManager::EnsureSnapshotLocked(
    const std::string& id, const std::shared_ptr<pipeline::ChannelWorker>& worker) {
  if (!LicenseAllowed()) return nullptr;
  {
    std::lock_guard<std::mutex> lock(lock_);
    if (deletion_pending_.count(id) || cancelling_starts_.load()) return nullptr;
    auto existing = snapshot_stores_.find(id);
    if (existing != snapshot_stores_.end()) return existing->second;
  }
  auto cfg = store_ ? store_->Load() : boot_cfg_;
  auto built = BuildSnapshotStore(*worker->Config(), cfg.snapshot_store);
  // 慢操作后再次检查授权。放弃的实例在 lock_ 外析构并收尾写入线程。
  if (!built || !LicenseAllowed()) return nullptr;
  {
    std::lock_guard<std::mutex> lock(lock_);
    auto it = channels_.find(id);
    if (it == channels_.end() || it->second != worker || deletion_pending_.count(id) ||
        cancelling_starts_.load()) return nullptr;
    auto& slot = snapshot_stores_[id];
    if (!slot) {
      worker->SetSnapshotSink(built);
      slot = built;
    }
    return slot;
  }
}
std::string ChannelManager::HistoryUnavailableReason(const std::string& id) const {
  {
    std::lock_guard<std::mutex> lock(lock_);
    if (deletion_pending_.count(id)) return "channel_deleting";
  }
  if (!LicenseAllowed()) return "license_pending";
  return cancelling_starts_.load() ? "service_stopping" : "unavailable";
}
ChannelManager::~ChannelManager() { try { StopAll(); } catch (...) {} }

void ChannelManager::StartEnabled(const std::string& id) {
  auto op=OpLock(id);
  std::lock_guard<std::mutex> op_guard(*op);
  std::shared_ptr<pipeline::ChannelWorker> worker;
  {
    std::lock_guard<std::mutex> lock(lock_);
    auto it=channels_.find(id);
    if(it==channels_.end() || manually_stopped_.count(id) || deletion_pending_.count(id) ||
       retries_[id].after>NowMono())return;
    worker=it->second;
  }
  if(cancelling_starts_.load() || !LicenseAllowed())return;
  auto state=worker->State();
  if(state!=pipeline::ChannelState::kIdle && state!=pipeline::ChannelState::kError)return;
  if(state==pipeline::ChannelState::kError) {
    std::lock_guard<std::mutex> lock(lock_);
    auto& retry=retries_[id];
    if(retry.started>0) {
      if(NowMono()-retry.started>=60)retry.failures=0;
      retry.started=0;
      retry.failures=std::min(6u,retry.failures+1);
      const double delay=std::min(60.0,2.0*(1u<<retry.failures));
      retry.after=NowMono()+delay;
      AI_LOG(kWarning,"ai-service.control","channel="<<id<<" runtime failure retry_after_s="<<delay);
      return;
    }
  }
  try {
    PrepareSnapshot(id,worker);RequireLicense();
    if(cancelling_starts_.load())return;
    worker->Start();
    if(worker->State()==pipeline::ChannelState::kError)throw std::runtime_error("channel initialization failed");
    std::lock_guard<std::mutex> lock(lock_);
    auto& retry=retries_[id];retry.started=NowMono();retry.after=0;
  } catch(const std::exception& e) {
    double delay;
    { std::lock_guard<std::mutex> lock(lock_);auto& retry=retries_[id];
      retry.failures=std::min(6u,retry.failures+1);
      delay=std::min(60.0,2.0*(1u<<retry.failures));retry.after=NowMono()+delay;
    }
    AI_LOG(kWarning,"ai-service.control","channel="<<id<<" retry_after_s="<<delay<<" "<<e.what());
  }
}

void ChannelManager::ReconcileChannel(const std::string& id) {
  // License acquisition can follow construction. Restore history even when
  // the operator stopped inference; health must not depend on opening the UI.
  try {
    if (!HistoryStore(id)) return;
  } catch (const std::exception& e) {
    std::lock_guard<std::mutex> lock(lock_);
    if (!channels_.count(id) || deletion_pending_.count(id)) return;
    auto& retry = retries_[id];
    retry.failures = std::min(6u, retry.failures + 1);
    retry.after = NowMono() + std::min(60.0, 2.0 * (1u << retry.failures));
    AI_LOG(kWarning, "ai-service.control", "archive channel=" << id << " " << e.what());
    return;
  }
  StartEnabled(id);  // Preserves manual stop and deletion checks under OpLock.
}

void ChannelManager::ScheduleAllEnabled() {
  std::lock_guard<std::mutex> serial(reconcile_mutex_);
  cancelling_starts_=false;
  for(auto it=starts_.begin();it!=starts_.end();) {
    if(it->second.wait_for(std::chrono::seconds(0))!=std::future_status::ready){++it;continue;}
    try {it->second.get();}catch(const std::exception& e){AI_LOG(kWarning,"ai-service.control",e.what());}
    it=starts_.erase(it);
  }
  std::vector<std::string> ids;
  {std::lock_guard<std::mutex> lock(lock_);
    for (auto& [id, w] : channels_) {
      const bool missing_archive = !snapshot_stores_.count(id);
      const bool startable = !manually_stopped_.count(id) &&
          (w->State() == pipeline::ChannelState::kIdle || w->State() == pipeline::ChannelState::kError);
      if ((missing_archive || startable) && !deletion_pending_.count(id) &&
          retries_[id].after <= NowMono()) ids.push_back(id);
    }
  }
  for(auto& id:ids) {
    if(starts_.size()>=2 || !LicenseAllowed())break;
    if(starts_.count(id))continue;
    try {starts_.emplace(id,std::async(std::launch::async,[this,id]{ReconcileChannel(id);}));}
    catch(const std::system_error& e){AI_LOG(kWarning,"ai-service.control",e.what());break;}
  }
}

void ChannelManager::StartAllEnabled() {
  cancelling_starts_=false;
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(lock_);
    for (auto&& [id, worker] : channels_) ids.push_back(id);
  }
  for (auto&& id : ids) {
    StartEnabled(id);
  }
}

void ChannelManager::StopAll() {
  std::lock_guard<std::mutex> serial(reconcile_mutex_);
  // 与新归档器的安装在 lock_ 下排序；随后按通道操作锁等待在途创建收尾。
  { std::lock_guard<std::mutex> lock(lock_); cancelling_starts_=true; }
  for(auto& [id,task]:starts_)try{task.get();}catch(...){}
  starts_.clear();
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(lock_);
    for (auto&& [id, worker] : channels_) ids.push_back(id);
    // Broadcast before any per-channel join; database retries and capture
    // budget waits for every channel can start winding down together.
    for (auto&& [id, archive] : snapshot_stores_) archive->RequestStop();
  }
  for (auto&& id : ids) {
    auto op = OpLock(id);
    std::lock_guard<std::mutex> op_guard(*op);
    std::shared_ptr<pipeline::ChannelWorker> worker;
    {
      std::lock_guard<std::mutex> lock(lock_);
      auto it = channels_.find(id);
      if (it == channels_.end()) continue;  // 收尾排队期间被删了
      worker = it->second;
    }
    auto s = worker->State();
    (void)s; // Stop also reaps failed worker threads and queued resources.
    try {
      worker->Stop();
      worker->SetSnapshotSink(nullptr);
      std::shared_ptr<output::SnapshotStore> released;
      { std::lock_guard<std::mutex> lock(lock_); auto it = snapshot_stores_.find(id); if (it != snapshot_stores_.end()) { released = std::move(it->second); snapshot_stores_.erase(it); } }
      if (released) released->QuiesceWriter();
      released.reset();
    } catch (const std::exception& e) {
      // 单通道收尾失败不阻断其他通道（与 StartAllEnabled 的容错语义对齐）
      AI_LOG(kError, "ai-service.control",
             "授权收尾停通道失败 id=" << id << ": " << e.what());
    }
  }
}

void ChannelManager::StartChannel(const std::string& channel_id) {
  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  auto worker = Get(channel_id);
  RequireNotDeleting(channel_id);
  // 只有 idle/error 能启动:重连中/启动中/停止中的 worker 线程还在跑,
  // Start() 会去 join 一个不会退出的捕获线程,把本通道的操作锁永久占住。
  auto s = worker->State();
  if (s != pipeline::ChannelState::kIdle && s != pipeline::ChannelState::kError) {
    throw ApiError(409, "invalid_state",
                   s == pipeline::ChannelState::kRunning
                       ? std::string("通道已在运行")
                       : "通道正在" + pipeline::ToString(s) + ",请稍后再试");
  }
  RequireLicense();
  worker->ValidateStart();
  PrepareSnapshot(channel_id, worker);
  RequireLicense(); // recheck after queueing and expensive preparation
  PersistOperatorStop(channel_id, false);
  { std::lock_guard<std::mutex> lock(lock_); manually_stopped_.erase(channel_id); retries_.erase(channel_id); }
  worker->Start();
}

void ChannelManager::PersistOperatorStop(const std::string& channel_id, bool stopped) {
  if (!store_) return;  // tests/legacy without persistence keep the in-memory intent
  std::lock_guard<std::mutex> cfg_guard(config_mutex_);
  json current = store_->LoadRawMerged();
  json channels = current.value("channels", json::array());
  bool changed = false;
  for (auto& c : channels) {
    if (c.value("id", "") != channel_id) continue;
    const bool persisted = c.value("manually_stopped", false);
    if (persisted == stopped) return;
    if (stopped) c["manually_stopped"] = true;
    else c.erase("manually_stopped");
    changed = true;
  }
  if (changed) store_->SaveOverlay(json{{"channels", channels}});
}

void ChannelManager::StopChannel(const std::string& channel_id) {
  Get(channel_id);  // 404 before recording any intent
  // Record intent before waiting for the operation lock: a scheduled start may
  // hold it for up to 30 s and must not restart the channel afterwards.
  { std::lock_guard<std::mutex> lock(lock_); manually_stopped_.insert(channel_id); }
  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  // A manual start that held the lock may have cleared the early mark; this
  // later stop wins, so record it again under the lock.
  { std::lock_guard<std::mutex> lock(lock_); manually_stopped_.insert(channel_id); }
  auto worker = Get(channel_id);
  // Idempotent: stopping an idle channel or one in a failure/retry loop is valid.
  auto s = worker->State();
  if (s != pipeline::ChannelState::kIdle && s != pipeline::ChannelState::kError) worker->Stop();
  try {
    PersistOperatorStop(channel_id, true);
  } catch (const std::exception&) {
    throw ApiError(500, "stop_not_persisted", "通道已停止，但停止状态未能保存；AI 服务重启后可能恢复运行，请重试停止");
  }
}

std::vector<nlohmann::json> ChannelManager::ListAll() const {
  std::vector<std::pair<std::string, std::shared_ptr<pipeline::ChannelWorker>>> snapshot;
  {
    std::lock_guard<std::mutex> lock(lock_);
    snapshot.assign(channels_.begin(), channels_.end());
  }
  std::vector<json> views;
  views.reserve(snapshot.size());
  for (auto&& [id, worker] : snapshot) views.push_back(ChannelView(id, worker));
  return views;
}

nlohmann::json ChannelManager::GlobalStats() const {
  std::vector<std::pair<std::string, std::shared_ptr<pipeline::ChannelWorker>>> snapshot;
  {
    std::lock_guard<std::mutex> lock(lock_);
    snapshot.assign(channels_.begin(), channels_.end());
  }
  int64_t total_frames = 0, total_inferences = 0, total_dropped = 0;
  json channels_stats = json::object();
  for (auto&& [id, worker] : snapshot) {
    json s = worker->GetStats();
    total_frames += s.value("frame_count", 0);
    total_inferences += s.value("inference_count", 0);
    total_dropped += s.value("dropped_count", 0);
    channels_stats[id] = std::move(s);
  }
  return json{
      {"uptime_seconds", RoundTo(NowWall() - start_time_, 1)},
      {"channels_total", snapshot.size()},
      {"total_frames", total_frames},
      {"total_inferences", total_inferences},
      {"total_dropped", total_dropped},
      {"channels", std::move(channels_stats)},
  };
}

nlohmann::json ChannelManager::BusinessHealth() const {
  std::vector<std::pair<std::shared_ptr<pipeline::ChannelWorker>, std::shared_ptr<output::SnapshotStore>>> entries;
  {
    std::lock_guard<std::mutex> lock(lock_);
    for (const auto& [id, worker] : channels_) {
      auto it = snapshot_stores_.find(id);
      entries.emplace_back(worker, it == snapshot_stores_.end() ? nullptr : it->second);
    }
  }
  size_t enabled = 0, connected = 0;
  for (const auto& [worker, store] : entries) {
    if (!worker->Config()->snapshot.enabled) continue;
    ++enabled;
    if (store && store->GetStats().value("connected", false)) ++connected;
  }
  const bool licensed = LicenseAllowed();
  return json{{"license_allowed", licensed}, {"ready", licensed && enabled == connected},
              {"archive_enabled_channels", enabled}, {"archive_connected_channels", connected},
              {"archive_unavailable_channels", enabled - connected}};
}

nlohmann::json ChannelManager::AnalyticsEvents(const std::string& id,int limit) {
  auto worker=Get(id);
  if(limit<1||limit>200)throw ApiError(422,"invalid_limit","每次查询1至200条事件");
  const auto cfg=RequireStore().Load().snapshot_store;
  analytics::EventStore events(cfg.mongo_uri,cfg.db_name,"analytics_events");
  return {{"channel_id",id},{"events",events.List(id,limit)},{"limit",limit}};
}

config::ConfigStore& ChannelManager::RequireStore() {
  if (!store_) {
    throw ApiError(501, "persistence_not_configured", "本次启动未接入配置持久化存储,不支持这个操作");
  }
  return *store_;
}

std::optional<std::string> ChannelManager::CurrentApiKey() const {
  const auto boot = (boot_api_key_ && !boot_api_key_->empty()) ? boot_api_key_ : std::nullopt;
  if (!store_) return boot;
  try {
    json overlay = store_->LoadOverlayRaw();
    if (overlay.contains("server") && overlay["server"].is_object() &&
        overlay["server"].contains("api_key")) {
      // v1:`server["api_key"] or None`——null 和空串都等于关闭鉴权。
      const auto& key = overlay["server"]["api_key"];
      if (key.is_null()) return std::nullopt;
      std::string value = key.get<std::string>();
      if (value.empty()) return std::nullopt;
      return value;
    }
  } catch (...) {
    // overlay 读失败不应打死鉴权路径,回退启动值。
  }
  return boot;
}

// ---- 通道增删改的并发模型 ----
//
// 三把锁,各管一件事(多通道并行时,一个通道的慢操作不能拖住其它通道):
//   - lock_:只保护 channels_/snapshot_stores_/op_locks_ 的读和替换,持有期间
//     绝不做阻塞操作——/health、列表、结果/截图查询都要拿它。
//   - OpLock(id):同一通道的 start/stop/改配置/删除串行。worker 的 Start()
//     (建 engine,最长 30s)、Stop()(join 线程)、SnapshotStore 的启动/析构
//     都只在这把锁下做;旧 worker 必须完全停止后新 worker 才启动(两者推同
//     一个输出流名,SRS 会拒掉后来者)。
//   - config_mutex_:overlay 读-改-写跨通道串行(短时间持有)。
// 加锁顺序固定为 OpLock → config_mutex_ → lock_,不会反向。

nlohmann::json ChannelManager::CreateChannel(const nlohmann::json& patch) {
  auto& store = RequireStore();
  RejectInternalFields(patch);
  if (!patch.contains("id") || !patch["id"].is_string() || patch["id"].get<std::string>().empty()) {
    throw ApiError(422, "missing_id", "创建通道必须提供 id");
  }
  std::string channel_id = patch["id"].get<std::string>();
  try { output::SnapshotStore::PendingDirectory(channel_id); }
  catch (const std::invalid_argument&) {
    throw ApiError(422, "invalid_config", "通道 id 仅允许英文字母、数字、下划线和连字符");
  }

  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  {
    std::lock_guard<std::mutex> lock(lock_);
    if (channels_.count(channel_id)) {
      throw ApiError(409, "duplicate_id", "通道已存在: " + channel_id);
    }
  }
  RejectUnportedAdapter(patch);
  ValidatePromptBeforeSave(patch);
  RejectUnavailableAnalytics(patch.value("analytics",json()),json());

  config::AppConfig new_app_cfg;
  {
    std::lock_guard<std::mutex> cfg_guard(config_mutex_);
    json current = store.LoadRawMerged();
    json channels = current.value("channels", json::array());
    channels.push_back(patch);
    try {
      RejectOutputConflicts(channels, channel_id);
      new_app_cfg = store.SaveOverlay(json{{"channels", channels}});
    } catch (const config::ConfigValidationError& e) {
      throw ApiError(422, "invalid_config", e.what());
    }
  }

  auto it = std::find_if(new_app_cfg.channels.begin(), new_app_cfg.channels.end(),
                         [&](auto&& c) { return c.id == channel_id; });
  auto new_worker = MakeWorker(*it, new_app_cfg.snapshot_store);
  auto snapshot_store = BuildSnapshotStore(*it, new_app_cfg.snapshot_store);
  {
    std::lock_guard<std::mutex> lock(lock_);
    InstallLocked(channel_id, new_worker, std::move(snapshot_store));
  }
  return ChannelView(channel_id, new_worker);
}

int64_t ChannelManager::DeleteSnapshots(const std::string& channel_id,
    const std::optional<std::string>& image_id, std::optional<double> from_ts,
    std::optional<double> to_ts) {
  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  Get(channel_id);
  RequireNotDeleting(channel_id);
  auto archive = EnsureSnapshotLocked(channel_id, Get(channel_id));
  if (!archive) throw ApiError(503, "archive_unavailable", "归档访问尚未就绪，请稍后重试");
  if (image_id) return archive->DeleteOne(*image_id) ? 1 : 0;
  if (from_ts && to_ts) return archive->DeleteRange(*from_ts, *to_ts);
  return archive->Clear();
}

void ChannelManager::DeleteChannel(const std::string& channel_id) {
  // Validate the filesystem identity before mutating the history database.
  output::SnapshotStore::PendingDirectory(channel_id);
  auto& store = RequireStore();
  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  auto worker = Get(channel_id);
  config::SnapshotStoreConfig archive_config;
  // Persist intent before stopping/deleting anything. Restart must retain the
  // channel entry but never restart inference or the archive writer.
  {
    std::lock_guard<std::mutex> cfg_guard(config_mutex_);
    auto current = store.LoadRawMerged();
    auto channels = current.value("channels", json::array());
    for (auto& c : channels) {
      if (c.value("id", "") == channel_id) c["deletion_pending"] = true;
    }
    archive_config = store.SaveOverlay(json{{"channels", channels}}).snapshot_store;
  }
  { std::lock_guard<std::mutex> guard(lock_); deletion_pending_.insert(channel_id); }
  try {
    worker->Stop();
    auto archive = GetSnapshotStore(channel_id);
    if (archive) archive->QuiesceWriter();
    // Always clean up, including channels whose archiving was disabled earlier.
    history_delete_(archive_config, channel_id);
    output::SnapshotStore::DeletePending(channel_id);
    {
      std::lock_guard<std::mutex> cfg_guard(config_mutex_);
      auto current = store.LoadRawMerged();
      json channels = json::array();
      for (auto& c : current.value("channels", json::array())) {
        if (c.value("id", "") != channel_id) channels.push_back(c);
      }
      store.SaveOverlay(json{{"channels", channels}});
    }
    worker->SetSnapshotSink(nullptr);
    { std::lock_guard<std::mutex> guard(lock_);
      snapshot_stores_.erase(channel_id);
      channels_.erase(channel_id);
      deletion_pending_.erase(channel_id);
      manually_stopped_.erase(channel_id);
    }
  } catch (const std::exception&) {
    // No URI/credentials in the response. The durable entry survives for retry.
    throw ApiError(503, "channel_delete_incomplete",
                   "删除尚未完成，通道已保留且不会自动启动。请检查归档数据库连接后重试删除");
  }
}

std::string ChannelManager::WaitForRestart(pipeline::ChannelWorker& worker, double timeout_s) const {
  double deadline = NowMono() + timeout_s;
  while (NowMono() < deadline) {
    auto s = worker.State();
    if (s == pipeline::ChannelState::kRunning) return "running";
    if (s == pipeline::ChannelState::kError) return "failed";
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return worker.State() == pipeline::ChannelState::kRunning ? "running" : "failed";
}

nlohmann::json ChannelManager::UpdateChannelConfig(const std::string& channel_id,
                                                    const nlohmann::json& patch) {
  auto& store = RequireStore();
  RejectInternalFields(patch);

  auto op = OpLock(channel_id);
  std::lock_guard<std::mutex> op_guard(*op);
  auto worker = Get(channel_id);  // 404
  RequireNotDeleting(channel_id);

  std::set<std::string> patch_keys;
  if (patch.is_object()) {
    for (auto pit = patch.begin(); pit != patch.end(); ++pit) patch_keys.insert(pit.key());
  }
  std::vector<std::string> unknown;
  for (auto&& k : patch_keys) {
    if (!kKnownChannelFields.count(k)) unknown.push_back(k);
  }
  if (!unknown.empty()) {
    std::sort(unknown.begin(), unknown.end());
    std::string joined;
    for (size_t i = 0; i < unknown.size(); ++i) {
      if (i) joined += ", ";
      joined += unknown[i];
    }
    throw ApiError(422, "invalid_field", "不支持修改的字段: [" + joined + "]");
  }

  std::vector<std::string> restart_fields;
  std::vector<std::string> hot_fields;
  auto classified = ClassifyChannelPatch(patch);
  const auto old_config = worker->Config();
  if (classified.count("model") && old_config->model.adapter != "yoloe_pt" &&
      old_config->model.adapter != "locateanything_trt") classified["model"] = "restart";
  if (patch.contains("model") && patch["model"].is_object() &&
      (patch["model"].contains("prompts") || patch["model"].contains("class_names") || patch["model"].contains("description") || patch["model"].contains("max_new_tokens") ||
       patch["model"].contains("adapter") || patch["model"].contains("path")))
    ValidatePromptBeforeSave(config::DeepMerge(config::ChannelConfigToJson(*old_config, true), patch));
  if (patch.contains("analytics")) {
    const auto stored = config::ChannelConfigToJson(*old_config, true);
    RejectUnavailableAnalytics(config::DeepMerge(stored, patch).value("analytics", json()),
                               stored.value("analytics", json()));
  }
  for (auto&& [k, v] : classified) {
    if (v == "hot") hot_fields.push_back(k);
    if (v == "restart") restart_fields.push_back(k);
  }
  std::sort(hot_fields.begin(), hot_fields.end());
  std::sort(restart_fields.begin(), restart_fields.end());

  config::AppConfig new_app_cfg;
  {
    std::lock_guard<std::mutex> cfg_guard(config_mutex_);
    json current = store.LoadRawMerged();
    json channels = current.value("channels", json::array());
    int idx = -1;
    for (size_t i = 0; i < channels.size(); ++i) {
      if (channels[i].contains("id") && channels[i]["id"] == channel_id) {
        idx = static_cast<int>(i);
        break;
      }
    }
    if (idx < 0) throw ApiError(404, "unknown_channel", "通道不存在: " + channel_id);
    channels[idx] = config::DeepMerge(channels[idx], patch);
    // 只换模型、不带预处理:旧模型的归一化/通道顺序是旧模型的输入契约,必须
    // 清掉,由新模型族的默认值接管(ResolvePreprocess);缩放/灰边等与模型
    // 无关的设置保留。前端换模型时会连同预设的预处理一起发,不受影响。
    if (patch.contains("model") && !KeysAreSubsetOf(patch["model"],
        {"description", "label_id", "label_name", "max_new_tokens", "prompts", "class_names"}) && !patch_keys.count("preprocess") &&
        channels[idx].contains("preprocess") && channels[idx]["preprocess"].is_object()) {
      for (const char* k : {"normalize", "mean", "std", "rgb_order"}) {
        channels[idx]["preprocess"].erase(k);
      }
    }
    // 只在这次 patch 动了 model 时拦截:旧 overlay 里已有的遗留通道仍然
    // 可以改名/停用/删除,不因为别的字段的修改被卡住。
    if (patch_keys.count("model")) RejectUnportedAdapter(channels[idx]);
    try {
      // 同理只在动了源/输出时查冲突:存量冲突不该卡住改帧率这类无关修改。
      if (patch_keys.count("stream") || patch_keys.count("publish")) {
        RejectOutputConflicts(channels, channel_id);
      }
      const auto state = worker->State();
      if (patch_keys.count("snapshot") && state != pipeline::ChannelState::kIdle &&
          state != pipeline::ChannelState::kError) {
        // A rejected hardware option must leave both persistence and the live
        // worker untouched. Stopped channels may still save preparation drafts.
        worker->ValidateSnapshotResources(config::ChannelConfigFromJson(channels[idx]));
      }
      new_app_cfg = store.SaveOverlay(json{{"channels", channels}});
    } catch (const config::ConfigValidationError& e) {
      throw ApiError(422, "invalid_config", e.what());
    }
  }

  auto new_ch_it = std::find_if(new_app_cfg.channels.begin(), new_app_cfg.channels.end(),
                                [&](auto&& c) { return c.id == channel_id; });

  json restart_info = nullptr;
  if (!restart_fields.empty()) {
    std::string reason;
    for (size_t i = 0; i < restart_fields.size(); ++i) {
      if (i) reason += "、";
      reason += restart_fields[i];
    }
    reason += " 变更需要重启通道";

    bool was_running = worker->State() == pipeline::ChannelState::kRunning;
    worker->Stop();  // 旧 worker 完全停止后才建新的(同一输出流名不能两路同时推)
    // HTTP readers may retain the old shared_ptr; destruction is not a writer
    // ownership barrier. Drain/persist before the replacement loads pending.
    if (auto old_archive = GetSnapshotStore(channel_id)) old_archive->QuiesceWriter();
    auto new_worker = MakeWorker(*new_ch_it, new_app_cfg.snapshot_store);
    auto snapshot_store = BuildSnapshotStore(*new_ch_it, new_app_cfg.snapshot_store);
    std::shared_ptr<output::SnapshotStore> old_store;
    {
      std::lock_guard<std::mutex> lock(lock_);
      old_store = InstallLocked(channel_id, new_worker, std::move(snapshot_store));
    }
    old_store.reset();
    if (was_running && LicenseAllowed()) {
      RequireLicense();
      new_worker->Start();
      restart_info = json{{"reason", reason}, {"status", WaitForRestart(*new_worker)}};
    } else {
      restart_info = json{{"reason", reason}, {"status", pipeline::ToString(new_worker->State())}};
    }
  } else {
    // v1 apply_hot_patch 同时替换 self._snapshot_store.cfg:归档器的 trim
    // 上限/概览里的 max_count 立即生效,不等下一帧有检测结果。
    if (patch_keys.count("snapshot")) {
      if (auto snapshot_store = GetSnapshotStore(channel_id)) {
        snapshot_store->UpdateConfig(new_ch_it->snapshot);
      }
    }
    worker->ApplyHotPatch(*new_ch_it, patch_keys);
  }

  auto final_worker = Get(channel_id);
  return json{
      {"applied", true},
      {"applied_via", restart_fields.empty() ? "hot" : "restart"},
      {"hot_fields", hot_fields},
      {"restart", restart_info},
      {"channel", ChannelView(channel_id, final_worker)},
  };
}

// ---- HTTP 路由 ----

namespace {

void WriteJson(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void WriteError(httplib::Response& res, const ApiError& e) {
  WriteJson(res, e.status_code(), e.ToJson());
}

void WriteUnexpectedError(httplib::Response& res, const std::exception& e) {
  WriteJson(res, 500, json{{"error", {{"code", "unknown_error"}, {"message", e.what()}}}});
}

bool CheckAuth(const std::shared_ptr<ChannelManager>& manager, const httplib::Request& req,
               httplib::Response& res) {
  auto api_key = manager->CurrentApiKey();
  if (!api_key.has_value()) return true;  // 不启用鉴权
  std::string provided = req.get_header_value("X-Api-Key");
  if (api_key->empty() || provided.size()!=api_key->size() ||
      CRYPTO_memcmp(provided.data(),api_key->data(),provided.size())!=0) {
    WriteJson(res, 401, json{{"error", {{"code", "unauthorized"}, {"message", "无效的 API Key"}}}});
    return false;
  }
  return true;
}

// 每个处理器统一包一层:鉴权 + 异常 -> HTTP 响应格式。httplib 内建线程池
// 并发处理连接,阻塞的处理器(start/stop/delete/PUT config)不会拖住其它
// 连接(包括 /health),等价 v1 里显式 run_in_executor 的效果,不需要
// 再手工起线程池——这是 httplib 的默认调度模型本来就满足的属性。
using AuthedHandler = std::function<void(const httplib::Request&, httplib::Response&)>;

httplib::Server::Handler Wrap(std::shared_ptr<ChannelManager> manager, AuthedHandler fn) {
  return [manager, fn](const httplib::Request& req, httplib::Response& res) {
    try {
      if (!CheckAuth(manager, req, res)) return;
      // Only the fixed raw-JPEG endpoint receives the larger global wire cap.
      // Ordinary configuration/control requests retain their previous 1 MiB.
      if(req.path!="/api/v1/search/reencode"&&req.body.size()>1024*1024) {
        WriteJson(res,413,json{{"error",{{"code","request_too_large"},{"message","请求内容超过限制"}}}});return;
      }
      fn(req, res);
    } catch (const ApiError& e) {
      WriteError(res, e);
    } catch (const output::SnapshotUnavailable& e) {
      WriteJson(res, 503, json{{"error", {{"code", "SNAPSHOT_UNAVAILABLE"}, {"message", e.what()}}}});
    } catch (const config::ConfigValidationError& e) {
      WriteJson(res, 422, json{{"error", {{"code", "invalid_config"}, {"message", e.what()}}}});
    } catch (const std::exception& e) {
      WriteUnexpectedError(res, e);
    }
  };
}

// 查询参数解析:v1(FastAPI)对类型不合法的查询参数返回 422,这里同语义——
// 不能静默回退默认值(那会让调用方以为过滤生效了),也不能让 std::stod 的
// 异常冒泡成 500。整串必须都是数字,且拒绝 nan/inf。
std::optional<double> OptDoubleParam(const httplib::Request& req, const char* name) {
  if (!req.has_param(name)) return std::nullopt;
  const std::string v = req.get_param_value(name);
  size_t pos = 0;
  double d = 0.0;
  bool ok = false;
  try {
    d = std::stod(v, &pos);
    ok = pos == v.size() && std::isfinite(d);
  } catch (...) {
  }
  if (!ok) throw ApiError(422, "invalid_param", std::string("参数 ") + name + " 不是合法数字: " + v);
  return d;
}

int IntParam(const httplib::Request& req, const char* name, int default_value) {
  if (!req.has_param(name)) return default_value;
  const std::string v = req.get_param_value(name);
  size_t pos = 0;
  long long n = 0;
  bool ok = false;
  try {
    n = std::stoll(v, &pos);
    ok = pos == v.size() && n >= std::numeric_limits<int>::min() &&
         n <= std::numeric_limits<int>::max();
  } catch (...) {
  }
  if (!ok) throw ApiError(422, "invalid_param", std::string("参数 ") + name + " 不是合法整数: " + v);
  return static_cast<int>(n);
}

}  // namespace

void RegisterRoutes(httplib::Server& server, std::shared_ptr<ChannelManager> manager,
                    std::function<json()> runtime_health,SearchReencodeImage search_reencode) {
  const auto reencode_gate=std::make_shared<std::mutex>();
  server.Get("/api/v1/search/reencode/capabilities",Wrap(manager,[search_reencode](const auto&,auto& res){
    WriteJson(res,200,json{{"schema_version","search-reencode-capabilities-v1"},{"implemented",bool(search_reencode)},
      {"target_package_ids",search_reencode?json::array({"siglip2-base-full-int8"}):json::array()},
      {"max_image_bytes",kSearchReencodeMaxImageBytes},{"max_duration_ms",30000},
      {"cpu_model_fallback",false},{"cpu_image_processing",false}});
  }));
  server.Post("/api/v1/search/reencode",Wrap(manager,[search_reencode,reencode_gate](const auto& req,auto& res){
    if(!search_reencode)throw ApiError(503,"search_reencode_unavailable","当前服务未提供历史图像重编码");
    std::unique_lock<std::mutex> gate(*reencode_gate,std::try_to_lock);
    if(!gate.owns_lock())throw ApiError(429,"search_reencode_busy","历史图像重编码忙，请稍后重试");
    if(req.get_header_value("Content-Type")!="image/jpeg")throw ApiError(422,"invalid_search_reencode_request","需要原始 JPEG 图像");
    json input;
    try {
      input=ReadSearchReencodeHttpRequest(req.get_header_value("x-ainvr-search-reencode"),req.body,
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }catch(const SearchReencodeInputError& error){
      throw ApiError(error.expired?410:422,error.what(),error.expired?"重编码授权已过期":"重编码图像或任务身份无效");
    }
    WriteJson(res,200,search_reencode(input,req.body));
  }));
  // No disk access, manager/archive locks or license dependency in liveness.
  // /health remains the richer business diagnostic endpoint.
  server.Get("/livez", [](const httplib::Request&, httplib::Response& res) {
    res.set_content("alive", "text/plain");
  });
  // /health 豁免鉴权(v1 同语义)。
  server.Get("/health", [manager, runtime_health](const httplib::Request&, httplib::Response& res) {
    try {
      double uptime = NowWall() - manager->StartTime();
      // 根分区剩余空间(v1 同语义:shutil.disk_usage("/")、单分区部署假设、
      // free 不是 available——都对应 std::filesystem::space 的 .free 而不
      // 是 .available,后者会扣掉 root 保留块,和 v1 的数字对不上)。
      auto space = std::filesystem::space("/");
      json health{
                    {"status", "ok"},
                    {"version", "0.1.0"},
                    {"uptime_seconds", RoundTo(uptime, 1)},
                    {"channels", manager->ChannelCount()},
                    {"channels_running", manager->RunningCount()},
                    {"business", manager->BusinessHealth()},
                    {"disk_free_bytes", space.free},
                    {"disk_total_bytes", space.capacity},
                    // 控制台据此决定 AI 向导的 H.265 提示;旧版没有此字段即视为只支持 H.264
                    {"capabilities",
                     {{"codecs", json::array({"h264", "h265"})},
                      {"publish_formats", json::array({"codec12", "enhanced"})}}},
                };
      if (runtime_health) health.update(runtime_health());
      // Same switches as the service gate:never report a disabled stage as usable.
      health["capabilities"].update(analytics::PhaseCapabilities());
      WriteJson(res, 200, health);
    } catch (const std::exception& e) {
      WriteUnexpectedError(res, e);
    }
  });

  server.Get("/api/v1/channels",
             Wrap(manager, [manager](const httplib::Request&, httplib::Response& res) {
               WriteJson(res, 200, json{{"channels", manager->ListAll()}});
             }));

  server.Post("/api/v1/channels",
              Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                json patch = json::parse(req.body, nullptr, false);
                if (patch.is_discarded()) throw ApiError(422, "invalid_json", "请求体不是合法 JSON");
                WriteJson(res, 201, manager->CreateChannel(patch));
              }));

  server.Delete(R"(/api/v1/channels/([^/]+))",
                Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                  std::string id = req.matches[1];
                  manager->DeleteChannel(id);
                  WriteJson(res, 200, json{{"id", id}, {"deleted", true}});
                }));

  server.Put(R"(/api/v1/channels/([^/]+)/config)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               json patch = json::parse(req.body, nullptr, false);
               if (patch.is_discarded()) throw ApiError(422, "invalid_json", "请求体不是合法 JSON");
               WriteJson(res, 200, manager->UpdateChannelConfig(id, patch));
             }));

  server.Get(R"(/api/v1/channels/([^/]+))",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               auto worker = manager->Get(id);
               WriteJson(res, 200, manager->ChannelView(id, worker));
             }));

  server.Post(R"(/api/v1/channels/([^/]+)/start)",
              Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                std::string id = req.matches[1];
                manager->StartChannel(id);  // 可能阻塞最长 30s(建 TensorRT engine);见上面 Wrap 注释
                WriteJson(res, 200, json{{"status", "starting"}, {"channel_id", id}});
              }));

  server.Post(R"(/api/v1/channels/([^/]+)/stop)",
              Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                std::string id = req.matches[1];
                manager->StopChannel(id);
                WriteJson(res, 200, json{{"status", "stopping"}, {"channel_id", id}});
              }));

  server.Post(R"(/api/v1/channels/([^/]+)/analytics/reset)",
    Wrap(manager,[manager](const httplib::Request& req,httplib::Response& res){
      auto body=json::parse(req.body,nullptr,false);
      if(!body.is_object()||body.size()!=2||!body.contains("reason")||!body["reason"].is_string()||body["reason"]!="ptz_view_change"||
         !body.contains("generation")||!body["generation"].is_string())
        throw ApiError(422,"invalid_parameter","轨迹重置参数无效");
      const auto generation=body["generation"].get<std::string>();
      if(generation.empty()||generation.size()>128||
         !std::all_of(generation.begin(),generation.end(),[](unsigned char c){return std::isalnum(c)||c=='-';}))
        throw ApiError(422,"invalid_parameter","轨迹重置编号无效");
      if(!manager->Get(req.matches[1])->ResetAnalytics(generation))
        throw ApiError(409,"tracking_reset_unavailable","当前处理器不支持不中断视频的轨迹重置");
      WriteJson(res,200,json{{"reset",true},{"apply_before_next_observation",true},{"generation",generation}});
    }));

  server.Get(R"(/api/v1/channels/([^/]+)/analytics/events)",
    Wrap(manager,[manager](const httplib::Request& req,httplib::Response& res) {
      if(!analytics::kRulesAndEventsAvailable)
        throw ApiError(404,"feature_unavailable","区域事件功能尚未开放");
      WriteJson(res,200,manager->AnalyticsEvents(req.matches[1],IntParam(req,"limit",50)));
    }));

  // ---- 结果查询 ----
  server.Get(R"(/api/v1/channels/([^/]+)/results/latest)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               auto worker = manager->Get(id);
               auto result = worker->GetResultBuffer().Latest();
               if (!result.has_value()) {
                 WriteJson(res, 200, json{{"channel_id", id}, {"has_result", false}, {"result", nullptr}});
                 return;
               }
               WriteJson(res, 200,
                         json{{"channel_id", id}, {"has_result", true}, {"result", result->ToDict()}});
             }));

  server.Get(R"(/api/v1/channels/([^/]+)/results)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               auto worker = manager->Get(id);
               int limit = IntParam(req, "limit", 30);
               auto results = worker->GetResultBuffer().LastN(static_cast<size_t>(std::max(0, limit)));
               json arr = json::array();
               for (auto&& r : results) arr.push_back(r.ToDict());
               WriteJson(res, 200, json{{"channel_id", id}, {"count", results.size()}, {"results", arr}});
             }));

  // ---- 识别快照归档管理：缺失归档器时返回配置开关及真实不可用原因。 ----
  server.Get(R"(/api/v1/channels/([^/]+)/snapshots/overview)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               auto worker = manager->Get(id);  // 404 判断仍然要做
               auto store = manager->HistoryStore(id);
               if (!store) {
                 // 没有归档器不是数据库断开：开关如实反映配置，并给出具体原因供页面区分。
                 const auto reason = manager->HistoryUnavailableReason(id);
                 WriteJson(res, 200,
                           json{
                               {"enabled", worker->Config()->snapshot.enabled},
                               {"connected", false},
                               {"reason", reason},
                               {"last_error", reason == "license_pending" ? json("授权未就绪，暂时无法访问识别历史")
                                              : reason == "channel_deleting" ? json("通道正在删除") : json(nullptr)},
                               {"count", 0},
                               {"max_count", worker->Config()->snapshot.max_count},
                               {"storage_bytes", 0},
                               {"earliest_timestamp", nullptr},
                               {"latest_timestamp", nullptr},
                           });
                 return;
               }
               auto overview = store->GetOverview();
               overview["enabled"] = worker->Config()->snapshot.enabled;
               overview["archive_stats"] = store->GetStats();
               overview["min_interval_ms"] = worker->Config()->snapshot.min_interval_ms;
               WriteJson(res, 200, overview);
             }));

  server.Get(R"(/api/v1/channels/([^/]+)/snapshots)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               manager->Get(id);  // 404 判断
               // 参数先校验(v1 同样在进入处理函数前就 422),再看归档是否启用。
               int limit = std::clamp(IntParam(req, "limit", 20), 1, 100);
               double min_confidence =
                   std::clamp(OptDoubleParam(req, "min_confidence").value_or(0.0), 0.0, 1.0);
               std::optional<std::string> cursor;
               if (req.has_param("cursor")) cursor = req.get_param_value("cursor");
               auto from_ts = OptDoubleParam(req, "from_ts");
               auto to_ts = OptDoubleParam(req, "to_ts");
               auto store = manager->HistoryStore(id);
               if (!store) {
                 WriteJson(res, 200, json{{"items", json::array()}, {"next_cursor", nullptr}});
                 return;
               }
               WriteJson(res, 200, store->ListPage(cursor, limit, min_confidence, from_ts, to_ts));
             }));

  server.Get(R"(/api/v1/channels/([^/]+)/snapshots/heatmap)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               manager->Get(id);
               int bucket_s = IntParam(req, "bucket_s", 300);
               auto from_ts = OptDoubleParam(req, "from_ts");
               auto to_ts = OptDoubleParam(req, "to_ts");
               auto store = manager->HistoryStore(id);
               if (!store) {
                 WriteJson(res, 200,
                           json{{"enabled", false}, {"bucket_s", bucket_s}, {"buckets", json::array()}});
                 return;
               }
               WriteJson(res, 200, store->Heatmap(from_ts, to_ts, bucket_s));
             }));

  server.Get(R"(/api/v1/channels/([^/]+)/observation-evidence)",
             Wrap(manager,[manager](const httplib::Request& req,httplib::Response& res){
               const std::string id=req.matches[1];manager->Get(id);
               for(const auto& param:req.params)if(param.first!="stream_session_id"&&param.first!="source_pts_ns"&&param.first!="source_frame_index"&&param.first!="track_id")throw ApiError(422,"invalid_parameter","Unsupported evidence query");
               output::ObservationEvidenceQuery query{req.get_param_value("stream_session_id"),req.get_param_value("source_pts_ns"),req.get_param_value("source_frame_index"),req.get_param_value("track_id")};
               try{query.Validate();}catch(...){throw ApiError(422,"invalid_parameter","Invalid evidence frame identity");}
               auto store=manager->HistoryStore(id);
               if(!store){WriteJson(res,200,json{{"schema_version","1.0"},{"state","unavailable"},{"reason","archive_unavailable"}});return;}
               WriteJson(res,200,store->FindEvidence(query));
             }));

  server.Get(R"(/api/v1/channels/([^/]+)/snapshots/([^/]+)/image)",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               std::string id = req.matches[1];
               std::string image_id = req.matches[2];
               manager->Get(id);
               auto store = manager->HistoryStore(id);
               if (!store) throw ApiError(503, "archive_unavailable", "归档访问尚未就绪，请稍后重试");
               const auto variant = req.has_param("variant") ? req.get_param_value("variant") : "processed";
               if (variant != "processed" && variant != "original")
                 throw ApiError(400, "invalid_parameter", "variant 必须是 processed 或 original");
               auto data = store->GetImage(image_id, variant == "original");
               if (!data.has_value()) {
                 // 图片可能已经被 trim 淘汰——干净地 404,不是服务器错误。
                 throw ApiError(404, "not_found", "图片不存在(可能已被淘汰)");
               }
               res.set_content(reinterpret_cast<const char*>(data->data()), data->size(),
                                "image/jpeg");
             }));

  server.Delete(R"(/api/v1/channels/([^/]+)/snapshots/([^/]+))",
                Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                  std::string id = req.matches[1];
                  std::string image_id = req.matches[2];
                  if (!manager->DeleteSnapshots(id, image_id)) {
                    throw ApiError(404, "not_found", "记录不存在: " + image_id);
                  }
                  WriteJson(res, 200, json{{"image_id", image_id}, {"deleted", true}});
                }));

  server.Delete(R"(/api/v1/channels/([^/]+)/snapshots)",
                Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
                  std::string id = req.matches[1];
                  manager->Get(id);
                  bool has_from = req.has_param("from_ts");
                  bool has_to = req.has_param("to_ts");
                  if (has_from != has_to) {
                    throw ApiError(422, "invalid_range", "from_ts / to_ts 必须同时提供或都不提供");
                  }
                  auto from_ts = OptDoubleParam(req, "from_ts");
                  auto to_ts = OptDoubleParam(req, "to_ts");
                  const auto deleted = manager->DeleteSnapshots(id, std::nullopt, from_ts, to_ts);
                  WriteJson(res, 200, json{{"deleted_count", deleted}});
                }));

  // ---- 全局统计 ----
  server.Get("/api/v1/stats", Wrap(manager, [manager](const httplib::Request&, httplib::Response& res) {
               WriteJson(res, 200, manager->GlobalStats());
             }));

  // ---- 顶层配置(三期) ----
  server.Get("/api/v1/config", Wrap(manager, [manager](const httplib::Request&, httplib::Response& res) {
               auto store = manager->Store();
               if (!store) {
                 throw ApiError(501, "persistence_not_configured", "本次启动未接入配置持久化存储");
               }
               json merged = store->LoadRawMerged();
               json server_view = merged.value("server", json::object());
               server_view["api_key_set"] = server_view.contains("api_key") &&
                                             !server_view["api_key"].is_null();
               server_view.erase("api_key");
               WriteJson(res, 200,
                         json{{"server", server_view},
                              {"channels", merged.value("channels", json::array())}});
             }));

  server.Put("/api/v1/config",
             Wrap(manager, [manager](const httplib::Request& req, httplib::Response& res) {
               json patch = json::parse(req.body, nullptr, false);
               if (!patch.is_discarded() && patch.is_object() && patch.contains("server")) {
                 throw ApiError(409, "process_level_rejected",
                                 "server.* 是进程级参数(host/port/api_key),修改需要重启整个服务进程,"
                                 "本接口不支持;请改配置文件后重启");
               }
               throw ApiError(422, "invalid_field",
                               "通道配置请使用 /api/v1/channels 系列接口,不支持通过本接口修改");
             }));
}

}  // namespace ai_service::api
