// Copyright AINVR. Original channel business with S100P hardware adapters.
#include "reused_channel_worker.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <sstream>
#include <tuple>

#include <nlohmann/json.hpp>
#include <filesystem>

#include "../adapters/factory.hpp"
#include "../api/control_server.hpp"
#include "../pipeline/frame_accounting.hpp"
#include "../pipeline/postprocessor.hpp"
#include "../stream/sei.hpp"
#include "../stream/srs_codec_probe.hpp"
#include "../utils/log.hpp"
#include "../utils/user_facing_error.hpp"
#include "../output/face_enhancer_bpu.hpp"

namespace ai_service::pipeline {

namespace {
constexpr const char* kLogModule = "ai-service.worker";

// 建/重建拉流管线前定源编码(设计 D7、§6.1):调试覆盖优先,否则问 SRS。
// 拿不到时返回 nullopt,由 StreamSource 沿用上一次的编码。
stream::StreamSource::CodecResolver MakeCodecResolver(std::shared_ptr<const config::ChannelConfig> cfg,
                                                      std::string channel_id) {
  return [cfg = std::move(cfg), channel_id = std::move(channel_id)]() -> std::optional<stream::VideoCodec> {
    if (cfg->stream.codec_override) return stream::ParseCodecName(*cfg->stream.codec_override);
    auto codec = stream::QuerySrsStreamCodec(cfg->publish.srs_api_base, cfg->stream.url);
    if (codec) {
      AI_LOG(kInfo, kLogModule, "[" << channel_id << "] 源编码(SRS): " << stream::CodecName(*codec));
    }
    return codec;
  };
}

double NowMono() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
double NowWall() {
  return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}
void SleepMs(double ms) {
  if (ms <= 0) return;
  std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(ms));
}
}  // namespace

void ReusedChannelWorker::ValidateStart() const {
  auto cfg=LoadCfg();auto model=cfg->model;
  if(!model_root_.empty()&&std::filesystem::path(model.path).is_relative())
    model.path=(std::filesystem::path(model_root_)/model.path).string();
  try { adapters::BpuChannelAdapter::ValidateModel(model); }
  catch(const std::exception& e) {
    throw api::ApiError(422,"bpu_model_not_ready",utils::UserFacingError(e.what()));
  }
  ValidateSnapshotResources(*cfg);
}
void ReusedChannelWorker::ValidateSnapshotResources(const config::ChannelConfig& next) const {
  const auto& snapshot=next.snapshot;
  if(!snapshot.enabled || snapshot.face_enhance_model=="none") return;
  // Match the same task semantics that govern actual SnapshotStore processing.
  // This metadata object does not load an HBM or allocate a GPU/BPU context.
  const adapters::BpuChannelAdapter metadata(next.model);
  if(metadata.TaskType()!="face_detection") return;
  auto path=std::filesystem::path(snapshot.face_enhance_model=="gpen"
    ?snapshot_store_cfg_.face_enhance_engine:snapshot_store_cfg_.face_enhance_codeformer_engine);
  if(path.is_relative()&&!model_root_.empty()) path=std::filesystem::path(model_root_)/path;
  try { output::ValidateFaceEnhanceBpuManifest(snapshot.face_enhance_model,path); }
  catch(const std::exception& e) {
    AI_LOG(kWarning,kLogModule,"["<<channel_id_<<"] Face enhancement preflight: "<<e.what());
    throw api::ApiError(422,"face_model_not_ready",
      "人脸增强模型未就绪，请先安装与当前任务匹配的 BPU 模型及编译清单");
  }
}
std::unique_ptr<adapters::BpuChannelAdapter> ReusedChannelWorker::CreatePlatformAdapter(const config::ModelConfig& model){
  return std::make_unique<adapters::BpuChannelAdapter>(model);
}

ReusedChannelWorker::ReusedChannelWorker(config::ChannelConfig cfg,
                              config::SnapshotStoreConfig snapshot_store_cfg,std::string model_root)
    : channel_id_(cfg.id), model_root_(std::move(model_root)), snapshot_store_cfg_(std::move(snapshot_store_cfg)) {
  StoreCfg(std::make_shared<const config::ChannelConfig>(std::move(cfg)));
}

ReusedChannelWorker::~ReusedChannelWorker() { Stop(); }

// ---- §3.2a mutex 保护的原子替换读写 ----

std::shared_ptr<const config::ChannelConfig> ReusedChannelWorker::LoadCfg() const {
  std::lock_guard<std::mutex> lock(cfg_mutex_);
  return cfg_;
}
void ReusedChannelWorker::StoreCfg(std::shared_ptr<const config::ChannelConfig> cfg) {
  std::lock_guard<std::mutex> lock(cfg_mutex_);
  cfg_ = std::move(cfg);
}
std::shared_ptr<stream::StreamPublisher> ReusedChannelWorker::LoadPublisher() const {
  std::lock_guard<std::mutex> lock(publisher_mutex_);
  return publisher_;
}

std::shared_ptr<stream::StreamSource> ReusedChannelWorker::LoadStream() const {
  std::lock_guard<std::mutex> lock(stream_mutex_);
  return stream_;
}
void ReusedChannelWorker::StoreStream(std::shared_ptr<stream::StreamSource> stream) {
  std::lock_guard<std::mutex> lock(stream_mutex_);
  stream_ = std::move(stream);
}

// ---- 公共 API ----

void ReusedChannelWorker::Start() {
  ValidateStart();
  if (!CurrentLicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");
  {
    ChannelState s = state_.load();
    if (s == ChannelState::kRunning || s == ChannelState::kStarting) return;
  }
  // 推理线程连续失败进 ERROR 后两个线程自行退出,但没人 join;不先收掉
  // 就给仍可 join 的 std::thread 重新赋值会 std::terminate,点一下"启动"
  // 整个进程(所有通道)就没了。
  if (capture_thread_.joinable()) capture_thread_.join();
  if (infer_thread_.joinable()) infer_thread_.join();

  license_revoked_.store(false);
  if (!LicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");

  SetState(ChannelState::kStarting);
  stop_event_.store(false);

  // 跨重启不清零会让 inference_fps_actual 之类的累计统计失真
  // (§3.2c 已记录的生产事故),每次 Start() 都要重新清零。
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    stats_preprocess_ = utils::TimingStats(200);
    stats_frame_map_ = utils::TimingStats(200);
    stats_map_context_ = utils::TimingStats(200);
    stats_map_gst_ = utils::TimingStats(200);
    stats_map_egl_ = utils::TimingStats(200);
    stats_map_register_ = utils::TimingStats(200);
    stats_map_get_ = utils::TimingStats(200);
    map_reused_count_ = map_registered_count_ = 0;
    stats_frame_unmap_ = utils::TimingStats(200);
    stats_snapshot_offer_ = utils::TimingStats(200);
    stats_sei_stamp_ = utils::TimingStats(200);
    stats_inference_ = utils::TimingStats(200);
    stats_postprocess_ = utils::TimingStats(200);
    stats_total_ = utils::TimingStats(200);
    stats_period_ = utils::TimingStats(200);
    stats_infer_total_ = utils::TimingStats(200);
    stats_pull_wait_ = utils::TimingStats(200);
    stats_pull_drop_ = utils::TimingStats(200);
    stats_loop_wall_ = utils::TimingStats(200);
    stats_capture_period_ = utils::TimingStats(200);
    last_capture_mono_ = 0.0;
    inference_count_ = 0;
    dropped_count_ = 0;
    sampled_skip_count_ = 0;
    archive_backpressure_skip_count_ = 0;
    overload_drop_count_ = 0;
    last_infer_s_ = 0.0;
    consecutive_errors_ = 0;
    last_infer_time_ = 0.0;
    next_deadline_ = 0.0;
    frame_count_ = 0;
    pull_timeout_count_ = 0;
  }
  result_buffer_.Clear();

  {
    std::lock_guard<std::mutex> lock(init_mutex_);
    init_ready_ = false;
    infer_ready_ = false;
    init_error_.reset();
  }
  {
    std::lock_guard<std::mutex> lock(error_mutex_);
    last_error_.reset();
  }

  capture_thread_ = std::thread([this] { CaptureLoop(); });

  {
    std::unique_lock<std::mutex> lock(init_mutex_);
    bool ok = init_cond_.wait_for(lock, std::chrono::seconds(30), [this] { return init_ready_; });
    if (!ok) {
      lock.unlock();
      log::Error(kLogModule, "[" + channel_id_ + "] 启动超时");
      SetLastError("启动超时(30s 内拉流/模型加载未完成)");
      stop_event_.store(true);
      if (capture_thread_.joinable()) capture_thread_.join();
      SetState(ChannelState::kError);
      return;
    }
    if (init_error_.has_value()) {
      std::string err = *init_error_;
      lock.unlock();
      log::Error(kLogModule, "[" + channel_id_ + "] 启动失败:" + err);
      stop_event_.store(true);
      if (capture_thread_.joinable()) capture_thread_.join();
      SetState(ChannelState::kError);
      return;
    }
  }

  infer_thread_ = std::thread([this] { InferLoop(); });
  {
    std::unique_lock lock(init_mutex_);
    const bool ready=init_cond_.wait_for(lock,std::chrono::seconds(30),[this]{return infer_ready_;});
    if(!ready||init_error_){
      const auto error=init_error_.value_or("BPU 模型加载超时");lock.unlock();
      Stop();SetLastError(error);SetState(ChannelState::kError);
    }
  }
}

void ReusedChannelWorker::Stop() {
  stop_event_.store(true);
  if (reconnect_) reconnect_->Stop();

  {
    ChannelState s = state_.load();
    if (s != ChannelState::kIdle && s != ChannelState::kError) SetState(ChannelState::kStopping);
  }

  frame_cond_.notify_all();

  if (capture_thread_.joinable()) capture_thread_.join();
  if (infer_thread_.joinable()) infer_thread_.join();
}

void ReusedChannelWorker::ApplyHotPatch(const config::ChannelConfig& new_cfg,
                                   const std::set<std::string>& changed_fields) {
  auto old = LoadCfg();
  config::ChannelConfig merged = *old;

  if (changed_fields.count("name")) {
    merged.name = new_cfg.name;  // display/new records only; capture and inference unaffected
  }
  if (changed_fields.count("inference_fps")) {
    merged.inference_fps = new_cfg.inference_fps;
    reset_deadline_.store(true);  // 推理线程下一轮开头消费,见头文件说明
  }
  if (changed_fields.count("postprocess")) {
    merged.postprocess = new_cfg.postprocess;
  }
  if (changed_fields.count("model")) {
    merged.model.description = new_cfg.model.description;
    merged.model.label_id = new_cfg.model.label_id;
    merged.model.label_name = new_cfg.model.label_name;
    merged.model.max_new_tokens = new_cfg.model.max_new_tokens;
  }
  if (changed_fields.count("result_buffer")) {
    merged.result_buffer = new_cfg.result_buffer;
    result_buffer_.Resize(static_cast<size_t>(std::max(0, new_cfg.result_buffer.max_frames)));
  }
  if (changed_fields.count("snapshot")) {
    merged.snapshot = new_cfg.snapshot;
  }
  if (changed_fields.count("publish")) {
    merged.publish.sei = new_cfg.publish.sei;
    // osd 死配置,仅为"PATCH 成功后 GET 能看到刚写入的值"这条一致性同步
    // 赋值,不代表它还生效(v2 压根不建模 OsdConfig,这里没有对应字段)。
  }

  StoreCfg(std::make_shared<const config::ChannelConfig>(std::move(merged)));
}

nlohmann::json ReusedChannelWorker::GetStats() const {
  ChannelState state = state_.load();
  double start_time = start_time_.load();
  double elapsed = start_time > 0.0 ? NowMono() - start_time : 0.0;

  nlohmann::json stats;
  auto cfg = LoadCfg();
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    double period_mean_ms = stats_period_.Mean();
    double inf_fps = state == ChannelState::kRunning && period_mean_ms > 0.0
                         ? 1000.0 / period_mean_ms : 0.0;
    double capture_mean_ms = stats_capture_period_.Mean();
    double source_fps = state == ChannelState::kRunning && capture_mean_ms > 0.0
                            ? 1000.0 / capture_mean_ms : 0.0;
    double target_fps = EffectiveTargetFps(cfg->inference_fps, source_fps);
    // 刚启动/重连后前几秒实测帧率还没稳定,不报算力不足。
    bool under_capacity = state == ChannelState::kRunning && elapsed > 10.0 &&
                          IsUnderCapacity(inf_fps, target_fps, stats_infer_total_.Mean());
    stats = nlohmann::json{
        {"state", ToString(state)},
        {"elapsed_seconds", std::round(elapsed * 10.0) / 10.0},
        {"frame_count", frame_count_},
        {"inference_count", inference_count_},
        {"dropped_count", dropped_count_},
        {"sampled_skip_count", sampled_skip_count_},
        {"archive_backpressure_skip_count", archive_backpressure_skip_count_},
        {"overload_drop_count", overload_drop_count_},
        {"source_fps", std::round(source_fps * 100.0) / 100.0},
        {"inference_fps_target", cfg->model.adapter == "locateanything_trt" ? target_fps : std::round(target_fps * 100.0) / 100.0},
        {"under_capacity", under_capacity},
        {"last_error", nullptr},
        {"pull_timeout_count", pull_timeout_count_},
        {"consecutive_errors", consecutive_errors_},
        {"inference_fps_actual", cfg->model.adapter == "locateanything_trt" ? inf_fps : std::round(inf_fps * 100.0) / 100.0},
        {"timing",
         {
             {"preprocess", stats_preprocess_.ToDict()},
             {"frame_map", stats_frame_map_.ToDict()},
             {"map_context", stats_map_context_.ToDict()},
             {"map_gst", stats_map_gst_.ToDict()},
             {"map_egl", stats_map_egl_.ToDict()},
             {"map_register", stats_map_register_.ToDict()},
             {"map_get_frame", stats_map_get_.ToDict()},
             {"frame_unmap", stats_frame_unmap_.ToDict()},
             {"snapshot_offer", stats_snapshot_offer_.ToDict()},
             {"sei_stamp", stats_sei_stamp_.ToDict()},
             {"inference", stats_inference_.ToDict()},
             {"postprocess", stats_postprocess_.ToDict()},
             {"total", stats_total_.ToDict()},
             {"pull_wait", stats_pull_wait_.ToDict()},
             {"period", stats_period_.ToDict()},
             {"infer_total", stats_infer_total_.ToDict()},
             {"loop_wall", stats_loop_wall_.ToDict()},
             {"pull_drop", stats_pull_drop_.ToDict()},
         }},
        {"result_buffer_size", result_buffer_.Size()},
    };
  }
  if (auto stream = LoadStream()) {
    stats["video_codec"] = stream::CodecName(stream->Codec());
    auto demux = stream->GetDemuxStats();
    if (demux.available) {
      stats["source_flv_format"] = demux.format;
      stats["demux_dropped_frames"] = demux.dropped_frames;
      stats["demux_resyncs"] = demux.resyncs;
      stats["source_bframes"] = demux.bframes;
    }
  }

  {
    std::lock_guard<std::mutex> lock(error_mutex_);
    if (last_error_) stats["last_error"] = *last_error_;
  }

  if (auto publisher = LoadPublisher()) {
    stream::PublishStats ps = publisher->GetStats();
    auto stream = LoadStream();
    nlohmann::json pj{
        {"running", ps.running},
        {"rtmp_url", ps.rtmp_url},
        {"au_in", ps.au_in},
        {"au_pushed", ps.au_pushed},
        {"sei_injected", ps.sei_injected},
        {"reconnect_count", ps.reconnect_count},
        {"pub_queue_full_events", ps.pub_queue_full_events},
        {"consecutive_failures", ps.consecutive_failures},
        {"reconnecting", ps.reconnecting},
        {"buffer",
         {
             {"level", ps.buffer.level},
             {"held_s", ps.buffer.held_s},
             {"bytes", ps.buffer.bytes},
             {"put", ps.buffer.put},
             {"popped", ps.buffer.popped},
             {"stamped", ps.buffer.stamped},
             {"too_late", ps.buffer.too_late},
             {"dropped", ps.buffer.dropped},
             {"drop_events", ps.buffer.drop_events},
             {"byte_limit_events", ps.buffer.byte_limit_events},
             {"frame_limit_events", ps.buffer.frame_limit_events},
             {"age_limit_events", ps.buffer.age_limit_events},
             {"generation_reset_events", ps.buffer.generation_reset_events},
             {"generation_reset_units", ps.buffer.generation_reset_units},
             {"unknown", ps.buffer.unknown},
             {"duplicate_pts", ps.buffer.duplicate_pts},
         }},
        // au_seen 在 q_pub 进口计(source.py),au_in 在发布线程拉到之后才计
        // (publisher.py)——两者差值是目前唯一能看到的"上游丢了多少"信号。
        {"au_seen", stream ? stream->GetAuSeen() : 0},
        {"au_shed", stream ? stream->GetAuShed() : 0},
        {"codec", ps.codec},
    };
    if (ps.buffer.last_eviction) {
      const auto& e = *ps.buffer.last_eviction;
      pj["buffer"]["last_eviction"] = {
          {"reason_mask", e.reasons}, {"at_mono", e.at_mono},
          {"oldest_age_s", e.oldest_age_s}, {"hold_limit_s", e.hold_limit_s},
          {"bytes_before", e.bytes_before}, {"frames_before", e.frames_before},
          {"removed", e.removed}, {"keyframe_resume", e.resumed_at_keyframe},
          {"generation", e.generation.value_or(-1)},
      };
    }
    if (!ps.flv_format.empty()) pj["flv_format"] = ps.flv_format;
    if (ps.pub_queue_level.has_value()) pj["pub_queue_level"] = *ps.pub_queue_level;
    if (ps.last_error.has_value()) pj["last_error"] = *ps.last_error;
    stats["publish"] = std::move(pj);
  }

  return stats;
}

// ---- 捕获线程 ----

void ReusedChannelWorker::CaptureLoop() {
  try {
    if (!LicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");
    InitComponents();
    if (!LicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");
    // The inference thread sets RUNNING only after its BPU/GLES resources load.
    log::Info(kLogModule, "[" + channel_id_ + "] 捕获线程已启动");
  } catch (const std::exception& e) {
    log::Error(kLogModule, "[" + channel_id_ + "] 初始化失败: " + e.what());
    // 拉流可能已经起来了(模型加载在拉流之后),不收掉就一直挂着解码。
    if (auto stream = LoadStream()) {
      try {
        stream->Stop();
      } catch (...) {
      }
      StoreStream(nullptr);
    }
    {
      std::lock_guard<std::mutex> lock(init_mutex_);
      init_error_ = utils::UserFacingError(e.what());  // 会作为启动失败原因返回网页；原文已记日志
    }
    SetLastError(std::string("初始化失败: ") + utils::UserFacingError(e.what()));
    SetState(ChannelState::kError);
    {
      std::lock_guard<std::mutex> lock(init_mutex_);
      init_ready_ = true;
    }
    init_cond_.notify_all();
    return;
  }
  {
    std::lock_guard<std::mutex> lock(init_mutex_);
    init_ready_ = true;
  }
  init_cond_.notify_all();

  while (!stop_event_.load() && LicenseAllowed()) {
    if (reconnect_ && reconnect_->NeedsReconnect()) {
      SetState(ChannelState::kReconnecting);
      {
        // 断流期间的空档不是源帧间隔,不能算进源帧率。
        std::lock_guard<std::mutex> lock(stats_mutex_);
        last_capture_mono_ = 0.0;
      }
      {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        stream_epoch_.fetch_add(1);
        latest_frame_.reset();
        result_buffer_.Clear();
      }
      frame_cond_.notify_all();

      // 必须走状态机的 DoReconnect():它先按 initial_delay→×backoff→max_delay
      // 退避睡眠(可被 Stop() 打断),失败累计 consecutive_failures,再调
      // ReconnectStream()。直接调 ReconnectStream() 会绕过退避,源不可用时
      // 每 ~2s 无条件重建一次拉流管线(v1 channel.py 用的也是 do_reconnect)。
      bool success = reconnect_->DoReconnect();
      if (success) SetState(ChannelState::kRunning);
      continue;
    }

    if (reconnect_) reconnect_->CheckWatchdog();

    double loop_start = NowMono();
    auto generation = CurrentStreamGeneration();

    double pull_start = NowMono();
    auto [frame_opt, stream_gone] = PullFrameSafe();
    double pull_elapsed_ms = (NowMono() - pull_start) * 1000.0;
    if (stream_gone) {
      if (!stop_event_.load()) FailFromCapture("拉流异常退出");
      break;
    }

    if (!frame_opt) {
      {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        pull_timeout_count_++;
      }
      // 未开断线重连时,管线报错/EOS 停转后不会再有帧:进 ERROR,不能让推理
      // 线程空转、状态一直显示"运行中"。开了重连的由上面的重连状态机接管。
      if (!reconnect_) {
        auto stream = LoadStream();
        if (stream && !stream->IsRunning()) {
          FailFromCapture("拉流管线已出错且未开启断线重连");
          break;
        }
      }
      continue;
    }

    if (generation != CurrentStreamGeneration()) continue;

    {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      stats_pull_wait_.Add(pull_elapsed_ms);
      frame_count_++;
      double now_mono = NowMono();
      if (last_capture_mono_ > 0.0) stats_capture_period_.Add((now_mono - last_capture_mono_) * 1000.0);
      last_capture_mono_ = now_mono;
    }

    if (reconnect_) reconnect_->OnFrameReceived();

    // 只持有解码输出缓冲的引用,不拷贝像素:推理按设定帧率只取用其中一部分,
    // 没被取用的帧直接随下一帧替换而释放。
    const auto& ref = frame_opt;
    frame_seq_++;
    CapturedFrame cap;
    cap.seq = frame_seq_;
    cap.epoch = stream_epoch_.load();
    cap.pts_ns = ref->pts_ns;
    cap.duration_ns = ref->duration_ns;
    cap.captured_mono = NowMono();
    cap.captured_wall = NowWall();
    cap.width = ref->width;
    cap.height = ref->height;
    cap.ref = ref;
    cap.stream_generation = generation;

    {
      std::lock_guard<std::mutex> lock(frame_mutex_);
      latest_frame_ = cap;
    }
    frame_cond_.notify_all();

    {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      stats_loop_wall_.Add((NowMono() - loop_start) * 1000.0);
    }
  }

  {
    // 解码帧缓冲属于管线的缓冲池:先还掉手里的最新帧再停管线
    std::lock_guard<std::mutex> lock(frame_mutex_);
    latest_frame_.reset();
  }
  auto stream = LoadStream();
  if (stream) {
    try {
      stream->Stop();
    } catch (...) {
    }
    StoreStream(nullptr);
  }
  log::Info(kLogModule, "[" + channel_id_ + "] 捕获线程已退出");
}

std::pair<std::shared_ptr<stream::FrameRef>, bool> ReusedChannelWorker::PullFrameSafe() {
  auto stream = LoadStream();
  if (!stream) return {nullptr, true};
  try {
    return {stream->PullFrameRef(100), false};
  } catch (const std::exception& e) {
    log::Error(kLogModule, "[" + channel_id_ + "] 拉帧异常,退出捕获循环: " + e.what());
    return {nullptr, true};
  }
}

void ReusedChannelWorker::SetLastError(std::string msg) {
  std::lock_guard<std::mutex> lock(error_mutex_);
  last_error_ = std::move(msg);
}

void ReusedChannelWorker::FailFromCapture(const std::string& reason) {
  log::Error(kLogModule, "[" + channel_id_ + "] " + reason + ",通道进入 ERROR");
  SetLastError(reason);
  SetState(ChannelState::kError);
  // 推理线程只看 stop_event_:一并置位让它退出,线程由下次 Start()/Stop() 收掉
  stop_event_.store(true);
  frame_cond_.notify_all();
}

bool ReusedChannelWorker::ReconnectStream() {
  auto cfg = LoadCfg();
  try {
    auto stream = LoadStream();
    if (stream) {
      stream->Restart();
    } else {
      auto new_stream = std::make_shared<stream::StreamSource>(cfg->stream.url, channel_id_,
                                                                 cfg->publish.enabled);
      stream_instance_id_.fetch_add(1);
      new_stream->SetErrorCallback([this](const std::string& msg) { OnStreamError(msg); });
      new_stream->SetCodecResolver(MakeCodecResolver(cfg, channel_id_));
      new_stream->SetVideoProgressResolver([cfg] {
        return stream::QuerySrsVideoProgress(cfg->publish.srs_api_base, cfg->stream.url);
      });
      new_stream->Start();
      StoreStream(new_stream);
      stream = new_stream;
    }

    double verify_timeout_ms =
        std::max(2000.0, cfg->stream.watchdog_timeout_seconds * 1000.0 / 2.0);
    double waited_ms = 0.0;
    const double step_ms = 100.0;
    while (waited_ms < verify_timeout_ms && !stop_event_.load()) {
      if (stream->PullFrameRef(static_cast<int>(step_ms))) {
        if (reconnect_) reconnect_->OnFrameReceived();
        return true;
      }
      waited_ms += step_ms;
    }
    AI_LOG(kWarning, kLogModule,
           "[" << channel_id_ << "] 重连失败:" << waited_ms / 1000.0 << "s 未收到帧");
    return false;
  } catch (const std::exception& e) {
    log::Error(kLogModule, "[" + channel_id_ + "] 重连失败: " + e.what());
    return false;
  }
}

void ReusedChannelWorker::OnStreamError(const std::string& error_msg) {
  log::Error(kLogModule, "[" + channel_id_ + "] 流错误: " + error_msg);
  if (reconnect_) reconnect_->TriggerReconnect(error_msg);
}

// ---- 推理线程 ----

std::optional<ReusedChannelWorker::CapturedFrame> ReusedChannelWorker::PickNextFrame(
    int64_t last_consumed_seq, int* skipped) {
  std::lock_guard<std::mutex> lock(frame_mutex_);
  *skipped = 0;
  if (!latest_frame_.has_value() || latest_frame_->seq <= last_consumed_seq) {
    return std::nullopt;
  }
  if (last_consumed_seq >= 0) {
    *skipped = static_cast<int>(latest_frame_->seq - last_consumed_seq - 1);
  }
  return latest_frame_;
}

void ReusedChannelWorker::InferLoop() {
  try{
    InitModelComponents();
    if(!LicenseAllowed())throw std::runtime_error("LICENSE_REQUIRED");
    SetState(ChannelState::kRunning);start_time_.store(NowMono());
    {std::lock_guard lock(init_mutex_);infer_ready_=true;}
    init_cond_.notify_all();
  }catch(const std::exception& e){
    SetLastError("初始化失败: "+utils::UserFacingError(e.what()));
    stop_event_=true;SetState(ChannelState::kError);
    {std::lock_guard lock(init_mutex_);init_error_=utils::UserFacingError(e.what());infer_ready_=true;}
    init_cond_.notify_all();frame_cond_.notify_all();Cleanup();return;
  }
  log::Info(kLogModule, "[" + channel_id_ + "] 推理线程已启动");
  int64_t last_consumed_seq = -1;

  while (!stop_event_.load() && LicenseAllowed()) {
    auto cfg = LoadCfg();
    double interval = cfg->inference_fps > 0.0 ? 1.0 / cfg->inference_fps : 0.0;
    if (reset_deadline_.exchange(false)) next_deadline_ = 0.0;
    double now = NowMono();

    if (interval > 0.0) {
      if (next_deadline_ <= 0.0) next_deadline_ = now;
      double time_to_deadline = next_deadline_ - now;
      if (time_to_deadline > 0.0) {
        std::unique_lock<std::mutex> lock(frame_mutex_);
        // 短片段等待可及时响应停止、授权失效和热更新；不用持有解码图。
        frame_cond_.wait_for(lock, std::chrono::duration<double>(std::min(time_to_deadline, 0.1)),
                            [this] { return stop_event_.load() || reset_deadline_.load(); });
        continue;
      }
    }

    int64_t before_archive_wait = -1;
    if (snapshot_sink_ && cfg->snapshot.enabled) {
      {
        std::lock_guard<std::mutex> lock(frame_mutex_);
        if (latest_frame_) before_archive_wait = latest_frame_->seq;
      }
      snapshot_sink_->WaitForCapacity([this] {
        return stop_event_.load() || !LicenseAllowed();
      });
      if (stop_event_.load() || !LicenseAllowed()) continue;
    }
    int skipped = 0;
    auto frame = PickNextFrame(last_consumed_seq, &skipped);
    if (frame.has_value()) {
      const int64_t archive_skipped = ArchiveAdmissionSkips(before_archive_wait, frame->seq, skipped);
      last_consumed_seq = frame->seq;
      if (skipped > 0) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        double capture_mean_ms = stats_capture_period_.Mean();
        double source_fps = capture_mean_ms > 0.0 ? 1000.0 / capture_mean_ms : 0.0;
        SkipSplit split = SplitSkipped(skipped - archive_skipped, source_fps, interval, last_infer_s_);
        archive_backpressure_skip_count_ += archive_skipped;
        dropped_count_ += skipped;
        sampled_skip_count_ += split.sampled;
        overload_drop_count_ += split.overload;
      }
    }

    if (!frame.has_value()) {
      SleepMs(5.0);
      if (interval > 0.0 && next_deadline_ < NowMono() - interval) {
        next_deadline_ = NowMono() + interval;
      }
      continue;
    }

    double infer_start = NowMono();
    try {
      InferOneFrame(std::move(*frame));
    } catch (const std::exception& e) {
      int errs;
      {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        consecutive_errors_++;
        errs = consecutive_errors_;
      }
      AI_LOG(kError, kLogModule, "[" << channel_id_ << "] 推理失败 #" << errs << ": " << e.what());
      if (adapter_->IsPrompted()) SetLastError("本次识别未完成，请查看运行日志");
      if (errs >= cfg->max_consecutive_failures) {
        log::Error(kLogModule, "[" + channel_id_ + "] 连续失败,进入 ERROR");
        SetLastError("推理连续失败 " + std::to_string(errs) + " 次: " + utils::UserFacingError(e.what()));
        SetState(ChannelState::kError);
        // Capture 线程只看 stop_event_,推理线程放弃时必须同时置位,
        // 否则 Capture 线程会在下一轮撞悬空/失效引用(§3.2c 已记录的
        // 2026-09-08 生产事故)。
        stop_event_.store(true);
        break;
      }
      // 慢模型失败也遵守采集间隔，避免错误响应触发连续高负载重试。
      if (adapter_->IsPrompted() && interval > 0.0)
        next_deadline_ = NextInferenceDeadline(next_deadline_, NowMono(), interval);
      continue;
    }

    double now3 = NowMono();
    if (interval > 0.0) {
      next_deadline_ = NextInferenceDeadline(next_deadline_, now3, interval);
    }

    if (adapter_->IsPrompted()) {
      auto latest = result_buffer_.Latest();
      const bool complete = !latest || latest->model_extra.value("grounding", nlohmann::json::object())
                                      .value("complete", true);
      std::lock_guard<std::mutex> lock(error_mutex_);
      if (complete) last_error_.reset();
      else last_error_ = "本次识别结果未完整生成，已保存有效目标";
    }

    {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      if (last_infer_time_ > 0.0) {
        stats_period_.Add((now3 - last_infer_time_) * 1000.0);
      }
      last_infer_time_ = now3;
      stats_infer_total_.Add((now3 - infer_start) * 1000.0);
      last_infer_s_ = now3 - infer_start;
      inference_count_++;
      consecutive_errors_ = 0;
    }
  }

  Cleanup();
  if (state_.load() != ChannelState::kError) SetState(ChannelState::kIdle);
  log::Info(kLogModule, "[" + channel_id_ + "] 推理线程已退出");
}

void ReusedChannelWorker::InferPromptedFrame(CapturedFrame) {
  throw std::runtime_error("开放词汇模型的 BPU 输入和执行适配尚未完成");
}

void ReusedChannelWorker::InferOneFrame(CapturedFrame frame) {
  if (adapter_->IsPrompted()) { InferPromptedFrame(std::move(frame)); return; }
  if (!LicenseAllowed()) return;
  auto cfg = LoadCfg();
  if (snapshot_sink_ && cfg->snapshot.enabled)
    snapshot_sink_->ReserveForFrame({frame.width, frame.height});

  utils::Timer total_timer;

  const bool multi_output=adapter_->IsMultiOutput();
  auto pre_cfg=ResolvePreprocess(cfg->preprocess,adapter_->DefaultPreprocess());
  auto prepared=adapter_->RunFrame(frame.ref->nv12,pre_cfg,frame.ref->bt709,frame.ref->full_range);
  auto [in_h,in_w]=adapter_->InputSize();
  const auto scale_info=compute_scale(frame.width,frame.height,in_w,in_h);
  {
    std::lock_guard lock(stats_mutex_);
    stats_preprocess_.Add(prepared.preprocess_ms);stats_inference_.Add(prepared.inference_ms);
  }
  utils::Timer post_timer;
  std::vector<Detection> detections;
  if(multi_output) detections=adapter_->PostprocessMulti(prepared.outputs,scale_info,
      cfg->postprocess.conf_threshold,cfg->postprocess.iou_threshold,cfg->postprocess.max_detections);
  else{
    if(prepared.outputs.size()!=1)throw std::runtime_error("Single-output task received multiple BPU tensors");
    detections=adapter_->Postprocess(prepared.outputs[0],scale_info,
      cfg->postprocess.conf_threshold,cfg->postprocess.iou_threshold,cfg->postprocess.max_detections);
  }
  {
    std::lock_guard lock(stats_mutex_);
    stats_postprocess_.Add(post_timer.ElapsedMs()+prepared.output_decode_ms);
    stats_total_.Add(total_timer.ElapsedMs());
  }

  // 推理期间可能断流重连;旧结果不进入新流的缓存/SEI/截图归档。
  if (frame.epoch != stream_epoch_.load() || frame.stream_generation != CurrentStreamGeneration()) {
    return;
  }

  // 快照裁剪必须用这份(rescale 之前、对齐 frame_rgba 真实像素尺寸)——
  // §3.2c 坐标系两级换算陷阱,不能用下面 rescale 之后的坐标。
  std::vector<Detection> pre_rescale_detections = detections;

  auto [true_w, true_h] = GetTrueSourceSize(frame);
  double scale_x = frame.width != 0 ? static_cast<double>(true_w) / frame.width : 1.0;
  double scale_y = frame.height != 0 ? static_cast<double>(true_h) / frame.height : 1.0;
  auto rescaled = pipeline::rescale_detections(detections, scale_x, scale_y);

  FrameResult result;
  result.channel_id = channel_id_;
  result.stream_url = cfg->stream.url;
  result.stream_protocol = cfg->stream.protocol;
  result.timestamp = NowWall();
  result.frame_pts_ns = frame.pts_ns;
  result.frame_index = frame.seq;
  result.frame_width = true_w;
  result.frame_height = true_h;
  result.model_name = cfg->model.name;
  result.model_format = "hbm";
  result.model_provider = adapter_->ActualProvider();
  {
    auto [in_h, in_w] = adapter_->InputSize();
    result.model_input_size = {in_h, in_w};
  }
  // YOLOE emits raw boxes and class probabilities; host NMS remains required.
  result.model_end2end = !adapter_->IsMultiOutput() && cfg->model.adapter != "yoloe_bpu";
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    result.time_preprocess_ms = stats_preprocess_.Mean();
    result.time_inference_ms = stats_inference_.Mean();
    result.time_postprocess_ms = stats_postprocess_.Mean();
  }
  result.task_type = adapter_->TaskType();
  result.detections = rescaled;
  result.model_extra = adapter_->ResultMetadata();

  utils::Timer sei_timer;
  {
    std::lock_guard<std::mutex> lock(frame_mutex_);
    if (frame.epoch != stream_epoch_.load()) return;
    if (!LicenseAllowed()) return;
    result_buffer_.Append(result);
    StampSei(result, frame.stream_generation);
  }
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    stats_sei_stamp_.Add(sei_timer.ElapsedMs());
  }

  if (snapshot_sink_ && LicenseAllowed()) {
    utils::Timer snapshot_timer;
    snapshot_sink_->Offer({{frame.width,frame.height}, [this,&frame](const cv::Rect& region,cv::Mat& host) {
      if(region.x<0||region.y<0||region.width<=0||region.height<=0||
         region.x+region.width>frame.width||region.y+region.height>frame.height)
        throw std::invalid_argument("Invalid snapshot download region");
      if(!snapshot_converter_)snapshot_converter_=std::make_unique<ainvr::GlesPreprocessor>();
      ainvr::ImageTransform t;t.width=region.width;t.height=region.height;t.letterbox=false;
      t.yuv_bt709=frame.ref->bt709;t.yuv_full_range=frame.ref->full_range;
      t.source_region=std::array<float,4>{float(region.x),float(region.y),float(region.width),float(region.height)};
      const auto rgba=snapshot_converter_->RunNv12Rgba(frame.ref->nv12.pixels,frame.width,frame.height,t);
      host.create(region.height,region.width,CV_8UC4);
      for(int y=0;y<region.height;++y)std::memcpy(host.ptr(y),rgba.data()+size_t(y)*region.width*4,size_t(region.width)*4);
    }, [this] { return stop_event_.load()||!LicenseAllowed(); }},
      channel_id_,cfg->name,frame.pts_ns,result.timestamp,cfg->model.name,adapter_->TaskType(),
      pre_rescale_detections,result.detections,adapter_->SquareSnapshotCrop(),cfg->snapshot);
    std::lock_guard<std::mutex> lock(stats_mutex_);
    stats_snapshot_offer_.Add(snapshot_timer.ElapsedMs());
  }
}

void ReusedChannelWorker::StampSei(const FrameResult& result, std::optional<int64_t> generation) {
  if (!au_buffer_) return;
  auto cfg = LoadCfg();
  try {
    auto payload = sei::build_result_payload(channel_id_, result.frame_pts_ns, 0.0,
                                              result.detections, cfg->publish.sei.max_payload_bytes);
    if (payload.empty()) return;  // 预算裁剪后连一个目标都容不下,不写 det:[]
    // 按源编码构造:264 类型 6;265 前缀 SEI 类型 39(载荷一致,浏览器按 UUID 扫)
    auto stream = LoadStream();
    const auto codec = stream ? stream->Codec() : stream::VideoCodec::kH264;
    auto sei_nal = sei::build_sei_nal(payload, codec);
    au_buffer_->stamp(
        result.frame_pts_ns,
        [sei_nal, codec](const std::vector<uint8_t>& data) {
          return sei::inject_sei_annexb(data, sei_nal, codec);
        },
        NowMono(), generation);
  } catch (const std::exception& e) {
    // 打标失败绝不能影响推理主链路;日志限频同 v1:前 3 次 + 每 100 次。
    sei_stamp_errors_++;
    if (sei_stamp_errors_ <= 3 || sei_stamp_errors_ % 100 == 0) {
      AI_LOG(kError, kLogModule,
             "[" << channel_id_ << "] SEI 打标异常 #" << sei_stamp_errors_ << ": " << e.what());
    }
  }
}

// ---- 内部方法 ----

void ReusedChannelWorker::InitComponents() {
  if (!LicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");
  auto cfg = LoadCfg();
  bool need_es_branch = cfg->publish.enabled;

  auto new_stream =
      std::make_shared<stream::StreamSource>(cfg->stream.url, channel_id_, need_es_branch);
  stream_instance_id_.fetch_add(1);
  new_stream->SetErrorCallback([this](const std::string& msg) { OnStreamError(msg); });
  new_stream->SetCodecResolver(MakeCodecResolver(cfg, channel_id_));
  new_stream->SetVideoProgressResolver([cfg] {
    return stream::QuerySrsVideoProgress(cfg->publish.srs_api_base, cfg->stream.url);
  });
  new_stream->Start();
  StoreStream(new_stream);

  if (cfg->stream.reconnect.enabled) {
    reconnect_ = std::make_unique<stream::ReconnectStateMachine>(
        channel_id_, cfg->stream.reconnect.initial_delay, cfg->stream.reconnect.max_delay,
        cfg->stream.reconnect.backoff_factor, cfg->stream.watchdog_timeout_seconds,
        [this] { return ReconnectStream(); });
  }

  // Construct metadata only here. Load and destroy BPU/GLES on InferLoop.
  auto model=cfg->model;
  if(!model_root_.empty()&&std::filesystem::path(model.path).is_relative())
    model.path=(std::filesystem::path(model_root_)/model.path).string();
  adapter_=CreatePlatformAdapter(model);

  if (cfg->publish.enabled) {
    try {
      if (cfg->model.adapter == "locateanything_trt") {
        // 推理请求最多 28 秒；40 秒固定延迟从第一帧开始生效。
        // 768 MiB 支持 100 Mbps 约 48 秒压缩包及余量，绝不改动原始编码。
        au_buffer_ = std::make_shared<stream::AuDelayBuffer>(
            std::make_shared<stream::AdaptiveDelayController>(40.0, 40.0),
            1.2, int64_t(768) * 1024 * 1024);
      } else if (cfg->model.adapter == "yoloe_pt") {
        // 执行器往返与首次文本编码留足余量，随后按实际滞后自适应。
        au_buffer_ = std::make_shared<stream::AuDelayBuffer>(
            std::make_shared<stream::AdaptiveDelayController>(3.0, 3.0));
      } else {
        au_buffer_ = std::make_shared<stream::AuDelayBuffer>();
      }
      stream::StreamPublisher::Config pub_cfg;
      pub_cfg.wait_for_initial_buffer = adapter_->IsPrompted();
      pub_cfg.enabled = true;
      pub_cfg.rtmp_base = cfg->publish.rtmp_base;
      pub_cfg.watchdog_timeout_seconds = cfg->publish.watchdog_timeout_seconds;
      pub_cfg.srs_api_base = cfg->publish.srs_api_base;
      pub_cfg.reconnect_initial_delay = cfg->publish.reconnect.initial_delay;
      pub_cfg.reconnect_max_delay = cfg->publish.reconnect.max_delay;
      pub_cfg.reconnect_backoff_factor = cfg->publish.reconnect.backoff_factor;
      pub_cfg.flv_format = cfg->publish.flv_format;

      std::string target_url =
          cfg->publish.target_url.has_value() ? *cfg->publish.target_url : std::string();
      if (target_url.empty()) throw std::runtime_error("publish.target_url 不能为空");

      auto publisher = std::make_shared<stream::StreamPublisher>(
          [this]() -> GstElement* {
            auto s = LoadStream();
            return s ? s->GetEsSinkRef() : nullptr;  // 带引用,发布器用完释放
          },
          channel_id_, target_url, au_buffer_, pub_cfg,
          [this]() -> std::string {
            auto s = LoadStream();
            if (!s) return "unavailable";
            auto diag = s->GetEsQueueDiag();
            std::ostringstream oss;
            oss << "available=" << diag.available << " level=" << diag.current_level_buffers
                << "/" << diag.max_size_buffers << " au_seen=" << diag.au_seen
                << " au_shed=" << diag.au_shed << " shedding=" << diag.shedding;
            return oss.str();
          },
          [this]() { return CurrentStreamGeneration(); });
      publisher->SetLicenseCheck([this] { return LicenseAllowed(); });
      publisher->SetCodecProvider([this] {
        auto s = LoadStream();
        return s ? s->Codec() : stream::VideoCodec::kH264;
      });
      // 输入源断线恢复期间,发布看门狗不重建发布管线(reconnect_ 先于发布器创建、
      // 只 Stop 不释放,生命周期覆盖发布器)
      publisher->SetSourceRecoveringProvider([this] { return reconnect_ && reconnect_->IsRecovering(); });
      if (!LicenseAllowed()) throw std::runtime_error("LICENSE_REQUIRED");
      publisher->Start();
      std::lock_guard<std::mutex> lock(publisher_mutex_);
      publisher_ = std::move(publisher);
    } catch (const std::exception& e) {
      // 发布支路初始化失败不影响推理(v1 同语义)。
      log::Error(kLogModule, "[" + channel_id_ + "] 发布支路初始化失败(不影响推理): " + e.what());
      std::lock_guard<std::mutex> lock(publisher_mutex_);
      publisher_.reset();
    }
  }
}

void ReusedChannelWorker::InitModelComponents() {
  auto cfg=LoadCfg();auto model=cfg->model;
  if(!model_root_.empty()&&std::filesystem::path(model.path).is_relative())
    model.path=(std::filesystem::path(model_root_)/model.path).string();
  adapter_->SetRequestedInputSize(model.input_size.at(0),model.input_size.at(1));
  adapter_->Load(model.path,model.provider,model.engine_cache);
  const auto [h,w]=adapter_->InputSize();
  if(h!=model.input_size.at(0)||w!=model.input_size.at(1))throw std::runtime_error("模型实际输入尺寸与通道配置不一致");
  // Validate the normalization contract before Start acknowledges success.
  ResolvePreprocess(cfg->preprocess,adapter_->DefaultPreprocess());
  AI_LOG(kInfo,kLogModule,"["<<channel_id_<<"] BPU 模型已在推理线程加载 "<<h<<"x"<<w);
}

void ReusedChannelWorker::Cleanup() {
  snapshot_converter_.reset();
  if (adapter_) adapter_.reset();

  if (reconnect_) {
    try {
      reconnect_->Stop();
    } catch (...) {
    }
  }

  std::shared_ptr<stream::StreamPublisher> publisher;
  {
    // 先在锁内摘下,再在锁外 Stop()(会 join 线程)——不能持锁等待,否则
    // 这段时间 GetStats 全部被卡住。
    std::lock_guard<std::mutex> lock(publisher_mutex_);
    publisher = std::move(publisher_);
  }
  if (publisher) {
    try {
      publisher->Stop();
    } catch (const std::exception& e) {
      log::Error(kLogModule, "[" + channel_id_ + "] 发布支路停止失败: " + e.what());
    }
  }

  // SnapshotSink 生命周期由拥有它的一方(control_server::ChannelManager)
  // 管理,ReusedChannelWorker 不负责 stop 它——跟 v1 不同(v1 的 SnapshotStore
  // 是 worker 自己创建/持有的),这是 §7 第 8 步接入时的既定设计,不是
  // 本次遗漏。
  //
  // 拉流管线只由捕获线程停止(CaptureLoop 退出时):这里是推理线程,
  // 捕获线程此刻可能还在 PullFrame 里用着同一条管线,两边同时 Stop()
  // 会卡死整个通道(推理连续失败进 ERROR 时实测复现)。
}

std::optional<int64_t> ReusedChannelWorker::CurrentStreamGeneration() const {
  auto stream = LoadStream();
  if (!stream) return std::nullopt;
  int64_t instance = stream_instance_id_.load();
  int64_t internal = stream->GetStreamGeneration();
  return (instance << 32) ^ (internal & 0xFFFFFFFFLL);
}

std::pair<int, int> ReusedChannelWorker::GetTrueSourceSize(const CapturedFrame& frame) const {
  auto stream = LoadStream();
  if (stream) {
    auto size = stream->GetTrueSourceSize();
    if (size.has_value()) return *size;
  }
  return {frame.width, frame.height};
}

}  // namespace ai_service::pipeline
