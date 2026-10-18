// Copyright AINVR. Each model owns its output parser; execution/SEI are shared.
#pragma once
#include <algorithm>
#include <memory>
#include <utility>
#include "bpu_channel_adapter.hpp"
#include "locateanything_bpu_adapter.hpp"

namespace ai_service::adapters {
inline config::ModelConfig RequireModelFamily(config::ModelConfig cfg,const char* family) {
  if(cfg.adapter!=family)throw std::invalid_argument("Model adapter family does not match its runtime class");
  return cfg;
}

// InputSize/DefaultPreprocess come from this instance's validated HBM manifest.
// No runtime class inherits a shared hard-coded frame resolution.
class EndToEndBpuAdapter : public BpuChannelAdapter {
 public:
  std::vector<Detection> Postprocess(const std::vector<float>& values,
      const pipeline::ScaleInfo& scale,double confidence,double iou,int maximum) override {
    const auto& port=ModelDescription().at("outputs").at(0);
    const ainvr::DenseTensor tensor{port.at("name"),port.at("shape").get<std::vector<int64_t>>(),values};
    auto detections=ainvr::DecodeEndToEnd(tensor,scale,
        ModelManifest().at("class_names").get<std::vector<std::string>>(),{confidence,iou,maximum});
    if(SquareSnapshotCrop())for(auto& d:detections){
      const double side=std::max(d.bbox[2],d.bbox[3]);
      d.bbox[0]+=(d.bbox[2]-side)/2;d.bbox[1]+=(d.bbox[3]-side)/2;
      d.bbox[2]=d.bbox[3]=side;
    }
    return detections;
  }
 protected:
  EndToEndBpuAdapter(config::ModelConfig cfg,const char* family)
      :BpuChannelAdapter(RequireModelFamily(std::move(cfg),family)){}
};
class Yolo26BpuAdapter final : public EndToEndBpuAdapter {
 public:
  explicit Yolo26BpuAdapter(config::ModelConfig cfg):EndToEndBpuAdapter(std::move(cfg),"yolo26_bpu"){}
};
class YoloFaceBpuAdapter final : public EndToEndBpuAdapter {
 public:
  explicit YoloFaceBpuAdapter(config::ModelConfig cfg):EndToEndBpuAdapter(std::move(cfg),"yoloface_bpu"){}
  bool SquareSnapshotCrop() const override{return true;}
  std::string TaskType() const override{return "face_detection";}
};
class ScrfdBpuAdapter final : public BpuChannelAdapter {
 public:
  explicit ScrfdBpuAdapter(config::ModelConfig cfg):BpuChannelAdapter(RequireModelFamily(std::move(cfg),"scrfd_bpu")){}
  bool IsMultiOutput() const override{return true;}
  std::string TaskType() const override{return "face_detection";}
  std::vector<Detection> PostprocessMulti(const std::vector<std::vector<float>>& values,
      const pipeline::ScaleInfo& scale,double confidence,double iou,int maximum) override {
    const auto& ports=ModelDescription().at("outputs");
    if(ports.size()!=values.size())throw std::runtime_error("Incomplete SCRFD BPU outputs");
    std::vector<ainvr::DenseTensor> tensors;
    for(size_t i=0;i<values.size();++i)
      tensors.push_back({ports[i].at("name"),ports[i].at("shape").get<std::vector<int64_t>>(),values[i]});
    return ainvr::DecodeScrfd(tensors,scale,{confidence,iou,maximum});
  }
};
class YoloeBpuAdapter : public BpuChannelAdapter {
 public:
  explicit YoloeBpuAdapter(config::ModelConfig cfg):BpuChannelAdapter(RequireModelFamily(std::move(cfg),"yoloe_bpu")){}
  std::string TaskType() const override{return "object_detection";}
  std::vector<Detection> Postprocess(const std::vector<float>& values,
      const pipeline::ScaleInfo& scale,double confidence,double iou,int maximum) override {
    const auto& port=ModelDescription().at("outputs").at(0);
    const ainvr::DenseTensor tensor{port.at("name"),port.at("shape").get<std::vector<int64_t>>(),values};
    const auto& names=ActivePromptNames();const auto& cfg=ModelConfig();
    auto detections=ainvr::DecodeYoloeRaw(tensor,scale,names,{confidence,iou,maximum});
    for(auto& d:detections){
      d.query_description=names.at(size_t(d.class_id));
      if(!cfg.prompts.empty()){
        const auto& label=cfg.prompts.at(size_t(d.class_id));
        d.label_id=label.label_id;d.class_name=label.label_name;
      }else{
        d.label_id=cfg.label_id;
        if(names.size()>1&&!d.label_id.empty())d.label_id+=":"+std::to_string(d.class_id);
        if(names.size()==1&&!cfg.label_name.empty())d.class_name=cfg.label_name;
      }
    }
    return detections;
  }
};
class Yoloe8BpuAdapter final : public YoloeBpuAdapter {
 public:
  explicit Yoloe8BpuAdapter(config::ModelConfig cfg):YoloeBpuAdapter(std::move(cfg)){
    if(ModelConfig().name=="yoloe-26x-32")throw std::invalid_argument("32-slot model cannot use the8-slot runtime");
  }
};
class Yoloe32BpuAdapter final : public YoloeBpuAdapter {
 public:
  explicit Yoloe32BpuAdapter(config::ModelConfig cfg):YoloeBpuAdapter(std::move(cfg)){
    if(ModelConfig().name!="yoloe-26x-32")throw std::invalid_argument("32-slot runtime requires its own model contract");
  }
};
inline std::unique_ptr<BpuChannelAdapter> CreateBpuRuntimeAdapter(const config::ModelConfig& cfg){
  if(cfg.adapter=="yolo26_bpu")return std::make_unique<Yolo26BpuAdapter>(cfg);
  if(cfg.adapter=="yoloface_bpu")return std::make_unique<YoloFaceBpuAdapter>(cfg);
  if(cfg.adapter=="scrfd_bpu")return std::make_unique<ScrfdBpuAdapter>(cfg);
  if(cfg.adapter=="yoloe_bpu"){
    if(cfg.name=="yoloe-26x-32")return std::make_unique<Yoloe32BpuAdapter>(cfg);
    return std::make_unique<Yoloe8BpuAdapter>(cfg);
  }
  if(cfg.adapter=="locateanything_bpu")
    return std::make_unique<LocateAnythingBpuAdapter>(cfg);
  throw std::invalid_argument("Unsupported BPU model runtime");
}
} // namespace ai_service::adapters
