// Copyright AINVR. BPU execution behind the reused channel/model contract.
#pragma once
#include "base_adapter.hpp"
#include "config/config.hpp"
#include "platform/bpu_image_runner.hpp"
#include "platform/bpu_prompt_engine.hpp"
#include "detection_decode.hpp"
namespace ai_service::adapters {
class BpuChannelAdapter : public BaseModelAdapter {
 public:
  explicit BpuChannelAdapter(config::ModelConfig config);
  static nlohmann::json ValidateModel(const config::ModelConfig& config);
  // Task-owned preflight;metadata only,no SDK/GLES allocation.
  virtual nlohmann::json ValidateStartContract() const { return ValidateModel(config_); }
  void Load(const std::string& path,const std::string& provider,const std::string& cache) override;
  std::pair<int,int> InputSize() const override;
  pipeline::PreprocessConfig DefaultPreprocess() const override;
  bool IsMultiOutput() const override { return config_.adapter=="scrfd_bpu"; }
  // Generation error reporting is independent of the prompted execution API.
  virtual bool ReportsGenerationStatus() const { return IsPrompted(); }
  bool SquareSnapshotCrop() const override { return config_.adapter=="yoloface_bpu"; }
  std::string TaskType() const override {
    if(config_.adapter=="yoloe_bpu")return "object_detection";
    return (config_.adapter=="yoloface_bpu"||config_.adapter=="scrfd_bpu")
      ?"face_detection":BaseModelAdapter::TaskType();
  }
  std::string ActualProvider() const override { return "bpu"; }
  nlohmann::json ResultMetadata() const override;
  virtual ainvr::BpuImageResult RunFrame(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& preprocess,
                                bool bt709,bool full_range);
  virtual std::future<ainvr::BpuImageResult> RunFrameAsync(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& preprocess,
                                bool bt709,bool full_range);
  virtual bool SupportsFramePipeline() const { return true; }
  virtual void SetCancellationProbe(std::function<bool()>) {}
  std::vector<Detection> Postprocess(const std::vector<float>& output,const pipeline::ScaleInfo& scale,
                                     double confidence,double iou,int maximum) override;
  std::vector<Detection> PostprocessMulti(const std::vector<std::vector<float>>& output,
      const pipeline::ScaleInfo& scale,double confidence,double iou,int maximum) override;
 protected:
  static std::string ModelFileDigest(const std::string& path);
  const config::ModelConfig& ModelConfig() const{return config_;}
  const nlohmann::json& ModelManifest() const{return manifest_;}
  const nlohmann::json& ModelDescription() const{return description_;}
  const std::vector<std::string>& ActivePromptNames() const{return prompt_names_;}
 private:
  config::ModelConfig config_;
  nlohmann::json manifest_,description_;
  std::unique_ptr<ainvr::BpuImageRunner> runner_;
  std::vector<std::string> prompt_names_;
  std::vector<float> prompt_values_;
};
}
