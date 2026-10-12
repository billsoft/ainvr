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
  void Load(const std::string& path,const std::string& provider,const std::string& cache) override;
  std::pair<int,int> InputSize() const override;
  pipeline::PreprocessConfig DefaultPreprocess() const override;
  bool IsMultiOutput() const override { return config_.adapter=="scrfd_bpu"; }
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
  std::vector<Detection> Postprocess(const std::vector<float>& output,const pipeline::ScaleInfo& scale,
                                     double confidence,double iou,int maximum) override;
  std::vector<Detection> PostprocessMulti(const std::vector<std::vector<float>>& output,
      const pipeline::ScaleInfo& scale,double confidence,double iou,int maximum) override;
 private:
  config::ModelConfig config_;
  nlohmann::json manifest_,description_;
  std::unique_ptr<ainvr::BpuImageRunner> runner_;
  std::vector<std::string> prompt_names_;
  std::vector<float> prompt_values_;
};
}
