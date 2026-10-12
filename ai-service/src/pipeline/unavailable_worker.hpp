// Copyright AINVR. Persisted channel configuration with an unavailable runtime.
// This worker cannot execute models or images. The original controller remains
// responsible for configuration, licensing, history, scheduling and deletion.
#pragma once
#include <mutex>
#include "managed_worker.hpp"
#include "../api/control_server.hpp"

namespace ai_service::pipeline {
class UnavailableWorker final : public ChannelWorker {
 public:
  explicit UnavailableWorker(const config::ChannelConfig& cfg)
      : config_(std::make_shared<const config::ChannelConfig>(cfg)),
        results_(cfg.result_buffer.max_frames) {}
  void ValidateStart() const override {
    const auto cfg = Config();
    throw api::ApiError(422, "bpu_model_not_ready",
        cfg->model.provider == "bpu"
          ? "该模型尚未完成 BPU 编译和在线链路验证；配置已保留，暂不能启动识别"
          : "本通道仍是 CPU 模型配置；必须转换并验证 BPU 模型后才能启动识别");
  }
  void Start() override { ValidateStart(); }
  void Stop() override {}
  ChannelState State() const override { return ChannelState::kIdle; }
  void SetLicenseCheck(std::function<bool()>) override {}
  void SetSnapshotSink(std::shared_ptr<SnapshotSink> sink) override {
    std::lock_guard lock(mutex_); sink_ = std::move(sink);
  }
  std::shared_ptr<const config::ChannelConfig> Config() const override {
    std::lock_guard lock(mutex_); return config_;
  }
  void ApplyHotPatch(const config::ChannelConfig& cfg,
                     const std::set<std::string>&) override {
    std::lock_guard lock(mutex_);
    results_.Resize(cfg.result_buffer.max_frames);
    config_ = std::make_shared<const config::ChannelConfig>(cfg);
  }
  nlohmann::json GetStats() const override {
    auto timing = nlohmann::json{{"count",0},{"mean_ms",0},{"p50_ms",0},{"p95_ms",0}};
    return {{"state","idle"},{"elapsed_seconds",0},{"frame_count",0},
      {"inference_count",0},{"dropped_count",0},{"consecutive_errors",0},
      {"inference_fps_actual",0},{"result_buffer_size",0},
      {"runtime_available",false},{"model_provider",Config()->model.provider},
      {"last_error","BPU 模型和在线执行链路尚未验证，CPU 推理已禁用"},
      {"timing",{{"preprocess",timing},{"inference",timing},
                 {"postprocess",timing},{"total",timing}}}};
  }
  ResultBuffer& GetResultBuffer() override { return results_; }
 private:
  mutable std::mutex mutex_;
  std::shared_ptr<const config::ChannelConfig> config_;
  std::shared_ptr<SnapshotSink> sink_;
  ResultBuffer results_;
};
}  // namespace ai_service::pipeline
