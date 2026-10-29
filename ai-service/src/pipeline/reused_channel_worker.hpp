// Copyright AINVR. Original channel business with S100P hardware adapters.
// 通道 Worker —— 对应 Python pipeline/channel.py(双线程架构:捕获线程 +
// 推理线程解耦)。详细行为规格和并发语义改写理由见
// docs/v1_parity_design.md §3.2。
//
// 识别快照归档通过 SnapshotSink 接入:SnapshotStore 由
// control_server::ChannelManager 按通道创建/持有(不是 worker 自己建),
// 通道重建时由 manager 重新 SetSnapshotSink。
//
// S100P: detached NV12 FrameRef -> PYM/GLES preprocessing -> BPU HBM.
// Model resources load/run/destroy on the inference thread. Archive downloads
// RGBA regions through Mali and retains the original SnapshotSink business API.
#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <opencv2/core.hpp>
#include <set>
#include <string>
#include <thread>

#include <nlohmann/json_fwd.hpp>

#include "../adapters/bpu_channel_adapter.hpp"
#include "managed_worker.hpp"
#include "../config/config.hpp"
#include "../output/result.hpp"
#include "../output/search_sampling_owner.hpp"
#include "../analytics/frame_analytics.hpp"
#include "../analytics/event_outbox.hpp"
#include "../analytics/observation_journal.hpp"
#include "../analytics/event_store.hpp"
#include "../analytics/event_worker.hpp"
#include "../output/result_buffer.hpp"
#include "../pipeline/frame_accounting.hpp"
#include "../platform/gles_preprocess.hpp"
#include "../stream/au_buffer.hpp"
#include "../stream/publisher.hpp"
#include "../stream/reconnect.hpp"
#include "../stream/source.hpp"
#include "../utils/timing.hpp"
#include "timing_observation.hpp"

namespace ai_service::pipeline {

class ReusedChannelWorker : public ChannelWorker {
 public:
  explicit ReusedChannelWorker(config::ChannelConfig cfg,
                          config::SnapshotStoreConfig snapshot_store_cfg = {},std::string model_root = "");
  virtual ~ReusedChannelWorker();

  ReusedChannelWorker(const ReusedChannelWorker&) = delete;
  ReusedChannelWorker& operator=(const ReusedChannelWorker&) = delete;

  // virtual:ChannelManager 的并发/串行语义用启停耗时可控的替身来测
  // (真实 Start() 要拉流+建 engine,单测里做不到可控的慢)。
  virtual void Start();
  void ValidateStart() const override;
  void ValidateSnapshotResources(const config::ChannelConfig& next) const override;
  virtual void Stop();
  bool SupportsAnalyticsReset() const override { return true; }
  bool ResetAnalytics(const std::string& generation) override;
  // Assigned before starting any worker thread; immutable while running.
  void SetLicenseCheck(std::function<bool()> check) { license_check_ = std::move(check); }
  void SetSearchProducerLeaseReader(config::SearchProducerLeaseReader reader) override {
    search_producer_reader_ = std::move(reader);
  }
  void SetSearchSamplingSource(std::shared_ptr<output::SearchSamplingSource> source) override {
    search_sampling_source_ = std::move(source);
  }
  bool LicenseAllowed() const noexcept {
    if (license_revoked_.load()) return false;
    if (!CurrentLicenseAllowed()) {
      license_revoked_.store(true);
      if (search_sampling_source_) search_sampling_source_->Reset();
      return false;
    }
    return !license_revoked_.load();
  }

  virtual ChannelState State() const { return state_.load(); }
  const std::string& ChannelId() const { return channel_id_; }

  ResultBuffer& GetResultBuffer() { return result_buffer_; }
  const ResultBuffer& GetResultBuffer() const { return result_buffer_; }

  // 归档扩展点——不设置(默认 nullptr)时 snapshot.enabled 无论真假都不会
  // 触发任何归档动作。只应在 Stop() 状态下调用(通道级重建时机)。
  void SetSnapshotSink(std::shared_ptr<SnapshotSink> sink) { snapshot_sink_ = std::move(sink); }

  // 当前生效配置的只读快照(线程安全,§3.2a 的原子替换读)。
  std::shared_ptr<const config::ChannelConfig> Config() const { return LoadCfg(); }

  // 应用热参数增量(§1.2 的 hot 分类字段);changed_fields 是本次 patch 里
  // 出现过的顶层字段名集合,用于精确判断哪些子对象需要真正替换。调用方
  // (control_server::ChannelManager)负责按 §1.2 的规则先把 restart 类
  // 字段拦下来,这里只处理已经确定是 hot 的部分。
  void ApplyHotPatch(const config::ChannelConfig& new_cfg,
                      const std::set<std::string>& changed_fields);

  // {state, elapsed_seconds, frame_count, inference_count, dropped_count,
  //  pull_timeout_count, consecutive_errors, inference_fps_actual,
  //  timing:{...}, result_buffer_size, publish?:{...}}
  nlohmann::json GetStats() const;

 protected:
  std::optional<config::SearchProducerLease> ReadSearchProducerLease() const noexcept {
    try {
      auto lease = search_producer_reader_ ? search_producer_reader_() : std::nullopt;
      return lease && lease->IsCurrent() ? lease : std::nullopt;
    } catch (...) { return std::nullopt; }
  }
  // Business tests override the hardware factory; production always uses BPU.
  virtual std::unique_ptr<adapters::BpuChannelAdapter> CreatePlatformAdapter(const config::ModelConfig& model);

 private:
  std::shared_ptr<analytics::EventOutbox> event_outbox_;
  std::shared_ptr<analytics::ObservationJournal> observation_journal_;
  std::atomic<uint64_t> observation_stage_failures_{0};
  std::unique_ptr<analytics::EventWorker> review_worker_;
  std::unique_ptr<analytics::EventWorker> notification_worker_;
  std::atomic<uint64_t> event_stage_failures_{0};
  std::function<bool()> license_check_;
  config::SearchProducerLeaseReader search_producer_reader_;
  std::shared_ptr<output::SearchSamplingSource> search_sampling_source_;
  // Once either worker observes revocation, both must finish this generation.
  // Only Start(), after joining the old threads, may clear the latch.
  mutable std::atomic<bool> license_revoked_{false};
  bool CurrentLicenseAllowed() const noexcept {
    try { return !license_check_ || license_check_(); }
    catch (...) { return false; }
  }
  // 捕获线程持有的不可变帧(跨线程安全共享)。
  struct CapturedFrame {
    int64_t seq = 0;
    int64_t epoch = 0;
    int64_t pts_ns = -1;
    int64_t duration_ns = 0;
    uint64_t search_sampling_token = 0; // Frozen before BPU dispatch, including pipelined frames.
    std::optional<output::SearchObservationTicket> search_observation;
    double captured_mono = 0.0;
    double captured_wall = 0.0;
    int width = 0, height = 0;
    // Immutable detached NV12 storage; no retained SDK decoder output buffer.
    std::shared_ptr<stream::FrameRef> ref;
    // §3.2a:(instance_id,internal_gen) 打包成一个值;nullopt = 采集时没有
    // 有效流(理论上不会发生,防御性保留)。
    std::optional<int64_t> stream_generation;
  };

  void CaptureLoop();
  void InferLoop();
  void InitComponents();
  void InitModelComponents();
  void Cleanup();

  // 返回 (frame_or_nullopt, stream_gone)。stream_gone=true 时调用方
  // (CaptureLoop)必须立即退出循环,不能继续用旧的 stream 引用。
  std::pair<std::shared_ptr<stream::FrameRef>, bool> PullFrameSafe();
  std::optional<CapturedFrame> PickNextFrame(int64_t last_consumed_seq, int* skipped,bool* expired_observation);
  void InferOneFrame(CapturedFrame frame, ainvr::BpuImageResult prepared);
  static TimingFrameIdentity TimingIdentity(const CapturedFrame& frame) {
    return {frame.seq, frame.pts_ns, frame.captured_wall, frame.epoch, frame.stream_generation};
  }
  void RecordTiming(TimingStage stage, double milliseconds, TimingFrameIdentity frame) noexcept;
  std::unique_ptr<analytics::FrameAnalytics> analytics_;
  std::mutex analytics_reset_mutex_;
  std::string analytics_reset_generation_;
  std::atomic<uint64_t> analytics_reset_epoch_{0};
  uint64_t analytics_applied_reset_epoch_=0; // inference-thread owned
  void InferPromptedFrame(CapturedFrame frame);
  bool ReconnectStream();
  void OnStreamError(const std::string& msg);
  // 捕获线程发现源流不可恢复(拉流异常/未开重连时管线停转):置 ERROR 并让两个线程退出。
  void FailFromCapture(const std::string& reason);
  // 最近一次让通道进 ERROR 的原因(启动失败/源流不可恢复/推理连续失败),
  // 随统计返回给界面;每次 Start() 清空。
  void SetLastError(std::string msg);
  void StampSei(const FrameResult& result, std::optional<int64_t> generation);

  std::optional<int64_t> CurrentStreamGeneration() const;
  std::pair<int, int> GetTrueSourceSize(const CapturedFrame& frame) const;
  void SetState(ChannelState s) { state_.store(s); }

  // ---- §3.2a:GCC 11(libstdc++ 目标工具链)不支持
  // std::atomic<std::shared_ptr<T>>(C++20 特化,static_assert 直接编译
  // 失败,已实测确认),改用"mutex 保护的 shared_ptr 成员 +
  // Load/Store 辅助方法"实现等价的原子替换语义:Load 在锁内拷贝一份
  // shared_ptr(拷贝本身会让引用计数增到 2,锁外这份局部拷贝在原对象被
  // Store 替换后依然存活,读者手里的数据不会被析构/改写),Store 在锁内
  // 整体替换指针。不是 lock-free,但正确性与 atomic shared_ptr 等价,
  // 这里的读写频率(每帧一次量级)远够不上需要 lock-free 的场景。----
  std::shared_ptr<const config::ChannelConfig> LoadCfg() const;
  void StoreCfg(std::shared_ptr<const config::ChannelConfig> cfg);
  std::shared_ptr<stream::StreamSource> LoadStream() const;
  void StoreStream(std::shared_ptr<stream::StreamSource> stream);

  std::string channel_id_;
  std::string model_root_;
  config::SnapshotStoreConfig snapshot_store_cfg_;

  mutable std::mutex cfg_mutex_;
  std::shared_ptr<const config::ChannelConfig> cfg_;
  std::atomic<ChannelState> state_{ChannelState::kIdle};
  std::atomic<bool> stop_event_{false};

  std::thread capture_thread_;
  std::thread infer_thread_;

  mutable std::mutex stream_mutex_;
  std::shared_ptr<stream::StreamSource> stream_;
  std::atomic<int64_t> stream_instance_id_{0};
  std::unique_ptr<ainvr::GlesPreprocessor> snapshot_converter_;
  std::unique_ptr<adapters::BpuChannelAdapter> adapter_;
  ResultBuffer result_buffer_;
  std::unique_ptr<stream::ReconnectStateMachine> reconnect_;
  // HTTP 线程(GetStats)读、推理线程(Cleanup)释放——shared_ptr + 锁:
  // 读方在锁内拷一份局部 shared_ptr,出锁后对象不会被另一线程析构。
  std::shared_ptr<stream::StreamPublisher> LoadPublisher() const;
  mutable std::mutex publisher_mutex_;
  std::shared_ptr<stream::StreamPublisher> publisher_;
  std::shared_ptr<stream::AuDelayBuffer> au_buffer_;
  std::shared_ptr<SnapshotSink> snapshot_sink_;
  int64_t sei_stamp_errors_ = 0;

  std::mutex frame_mutex_;
  std::condition_variable frame_cond_;
  std::optional<CapturedFrame> latest_frame_;
  // Absorb bursty delivery without unbounded latency or 8K memory growth.
  std::deque<CapturedFrame> pending_frames_;
  std::atomic<int64_t> stream_epoch_{0};
  int64_t frame_seq_ = 0;

  mutable std::mutex stats_mutex_;
  TimingObservation timing_observation_; // API-only; never copied into a FrameResult.
  utils::TimingStats stats_preprocess_{200};
  utils::TimingStats stats_frame_map_{200};
  utils::TimingStats stats_map_context_{200};
  utils::TimingStats stats_map_gst_{200};
  utils::TimingStats stats_map_egl_{200};
  utils::TimingStats stats_map_register_{200};
  utils::TimingStats stats_map_get_{200};
  uint64_t map_reused_count_ = 0;
  uint64_t map_registered_count_ = 0;
  utils::TimingStats stats_frame_unmap_{200};
  utils::TimingStats stats_snapshot_offer_{200};
  utils::TimingStats stats_archive_admission_wait_{200};
  utils::TimingStats stats_sei_stamp_{200};
  utils::TimingStats stats_inference_{200};
  utils::TimingStats stats_postprocess_{200};
  utils::TimingStats stats_total_{200};
  utils::TimingStats stats_period_{200};
  utils::TimingStats stats_frame_age_{200};
  utils::TimingStats stats_infer_total_{200};
  utils::TimingStats stats_pull_wait_{200};
  utils::TimingStats stats_pull_drop_{200};
  utils::TimingStats stats_loop_wall_{200};
  // 源帧到达间隔,用来估算源帧率(区分抽帧跳过 / 过载丢帧,见 frame_accounting.hpp)
  utils::TimingStats stats_capture_period_{200};
  double last_capture_mono_ = 0.0;
  int64_t inference_count_ = 0;
  int64_t dropped_count_ = 0;  // = sampled_skip_count_ + overload_drop_count_ + archive_backpressure_skip_count_,兼容旧前端
  int64_t sampled_skip_count_ = 0;
  int64_t archive_backpressure_skip_count_ = 0;
  int64_t overload_drop_count_ = 0;
  double last_infer_s_ = 0.0;  // 上一帧推理耗时,判定跳帧是否算力所致;stats_mutex_ 保护
  int64_t frame_count_ = 0;
  int64_t pull_timeout_count_ = 0;
  int consecutive_errors_ = 0;
  double last_infer_time_ = 0.0;
  // next_deadline_ 只由推理线程读写;HTTP 线程(ApplyHotPatch 热改帧率)
  // 只置 reset_deadline_,由推理线程在下一轮开头消费——两个线程直接写同
  // 一个 double 是数据竞争(Python 版靠 GIL 才"看起来没问题")。
  double next_deadline_ = 0.0;
  std::atomic<bool> reset_deadline_{false};

  // Capture 线程写、HTTP 线程(GetStats)读。
  std::atomic<double> start_time_{0.0};
  mutable std::mutex error_mutex_;
  std::optional<std::string> last_error_;
  std::mutex init_mutex_;
  std::condition_variable init_cond_;
  bool init_ready_ = false;
  bool infer_ready_ = false;
  std::optional<std::string> init_error_;
};

}  // namespace ai_service::pipeline
