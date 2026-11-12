// Copyright AINVR. One source frame, model-owned transforms, bounded execution and one result.
#pragma once
#include "model_family_adapters.hpp"
#include "pipeline_merge.hpp"
#include "pipeline_limits.hpp"
#include "runtime_label_catalog.hpp"
#include <filesystem>
namespace ai_service::adapters {
class PipelineAdapter final:public BpuChannelAdapter {
 struct Node {std::string id;config::ModelConfig config;pipeline::PreprocessConfig preprocess;config::PostprocessConfig post;std::unique_ptr<BpuChannelAdapter> adapter;size_t outputs=0;};
 std::vector<Node> nodes_;std::string root_id_;std::vector<std::string> order_;bool parallel_;PipelineLabels labels_;int width_=0,height_=0;
 nlohmann::json metadata_=nlohmann::json::object();std::function<bool()> current_;
 public:
 PipelineAdapter(const config::ChannelConfig& cfg,const std::string& root):BpuChannelAdapter(cfg.model),root_id_(cfg.analysis_root_id),parallel_(cfg.analysis_execution=="parallel"){
  auto add=[&](std::string id,config::ModelConfig model,pipeline::PreprocessConfig pre,config::PostprocessConfig post){if(std::filesystem::path(model.path).is_relative())model.path=(std::filesystem::path(root)/model.path).string();auto adapter=CreateBpuRuntimeAdapter(model);nodes_.push_back({std::move(id),std::move(model),pre,post,std::move(adapter)});};
  metadata_["analysis_pipeline"]={{"configuration",config::ChannelConfigToJson(cfg,false).at("analysis_pipeline")}};
  add(root_id_,cfg.model,cfg.preprocess,cfg.postprocess);
  for(const auto& n:cfg.analysis_nodes)add(n.id,n.model,n.preprocess,n.postprocess);
  order_=cfg.analysis_order;
  if(order_.empty())for(const auto& n:nodes_)order_.push_back(n.id);
  // Stable catalog order preserves IDs across drag sorting. "primary" is only
  // the reserved identity of an imported legacy model, never a UI/model role.
  std::sort(nodes_.begin(),nodes_.end(),[](const Node& a,const Node& b){if(a.id=="primary"||b.id=="primary")return a.id=="primary"&&b.id!="primary";return a.id<b.id;});
 }
 nlohmann::json ValidateStartContract()const override {
  auto result=nlohmann::json::array();PipelineLabels preview;
  for(const auto& n:nodes_){
   auto manifest=n.adapter->ValidateStartContract();
   auto names=n.config.class_names.value_or(std::vector<std::string>{n.config.description});
   if(manifest.contains("class_names"))names=manifest.at("class_names").get<std::vector<std::string>>();
   auto catalog=n.config.adapter=="plate_bpu"?n.adapter->ResultMetadata().at("label_catalog"):RuntimeLabelCatalog(n.config,names);
   preview.Add(n.id,catalog,n.config.adapter!="yoloe_bpu");result.push_back(std::move(manifest));
  }
  return result;
 }
 void Load(const std::string&,const std::string&,const std::string&)override{
  std::sort(nodes_.begin(),nodes_.end(),[](const Node& a,const Node& b){if(a.id=="primary"||b.id=="primary")return a.id=="primary"&&b.id!="primary";return a.id<b.id;});
  labels_=PipelineLabels{};metadata_["compatible_label_catalogs"]=nlohmann::json::array();
  for(auto& n:nodes_){n.adapter->SetRequestedInputSize(n.config.input_size.at(0),n.config.input_size.at(1));n.adapter->SetCancellationProbe(current_);n.adapter->Load(n.config.path,n.config.provider,n.config.engine_cache);
   if(n.adapter->InputSize()!=std::pair{n.config.input_size.at(0),n.config.input_size.at(1)})throw std::runtime_error("Pipeline model dimensions differ from configuration");
   const auto extra=n.adapter->ResultMetadata();if(n.id=="primary")metadata_["compatible_label_catalogs"].push_back(extra.at("label_catalog"));labels_.Add(n.id,extra.at("label_catalog"),n.config.adapter!="yoloe_bpu");
  }
  labels_.SetPriority(order_);metadata_["label_catalog"]=labels_.Catalog();
  std::sort(nodes_.begin(),nodes_.end(),[&](const Node& a,const Node& b){return std::find(order_.begin(),order_.end(),a.id)<std::find(order_.begin(),order_.end(),b.id);});
 }
 void SetCancellationProbe(std::function<bool()> f)override{current_=std::move(f);}
 std::pair<int,int> InputSize()const override{return Root().adapter->InputSize();}
 pipeline::PreprocessConfig DefaultPreprocess()const override{return Root().adapter->DefaultPreprocess();}
 bool IsMultiOutput()const override{return true;}
 bool SupportsFramePipeline()const override{return false;} // Bound multi-model work to one source frame.
 bool SquareSnapshotCrop()const override{return Root().adapter->SquareSnapshotCrop();}
 std::string TaskType()const override{return Root().adapter->TaskType();}
 nlohmann::json ResultMetadata()const override{return metadata_;}
 ainvr::BpuImageResult RunFrame(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig&,bool bt709,bool full)override{
  width_=frame.width;height_=frame.height;ainvr::BpuImageResult merged;auto statuses=nlohmann::json::array();
  // A partially completed required detection set is not an empty observation.
  // Futures are joined before propagating errors, so the decoder lease stays alive.
  for(size_t begin=0;begin<nodes_.size();begin+=parallel_?2:1){
   const size_t end=std::min(nodes_.size(),begin+(parallel_?2:1));std::vector<std::future<ainvr::BpuImageResult>> futures;
   std::exception_ptr failure;
   try{for(size_t i=begin;i<end;++i){if(current_&&current_())throw std::runtime_error("Pipeline cancelled");auto& n=nodes_[i];auto pre=pipeline::ResolvePreprocess(n.preprocess,n.adapter->DefaultPreprocess());futures.push_back(n.adapter->RunFrameAsync(frame,pre,bt709,full));}}catch(...){failure=std::current_exception();}
   for(size_t k=0;k<futures.size();++k){try{auto r=futures[k].get();auto& n=nodes_[begin+k];n.outputs=r.outputs.size();for(auto& output:r.outputs)merged.outputs.push_back(std::move(output));merged.preprocess_ms+=r.preprocess_ms;merged.inference_ms+=r.inference_ms;merged.output_decode_ms+=r.output_decode_ms;statuses.push_back({{"node_id",n.id},{"model_name",n.config.name},{"status","complete"},{"preprocess_ms",r.preprocess_ms},{"inference_ms",r.inference_ms}});}catch(...){if(!failure)failure=std::current_exception();}}
   if(failure)std::rethrow_exception(failure);
  }
  merged.image_backend="model_owned_hardware";auto configuration=metadata_["analysis_pipeline"]["configuration"];metadata_["analysis_pipeline"]={{"configuration",configuration},{"schema_version",1},{"execution",parallel_?"parallel":"serial"},{"nodes",statuses},{"merge_policy","first_semantic_label_owner"},{"complete",true}};return merged;
 }
 std::vector<Detection> PostprocessMulti(const std::vector<std::vector<float>>& values,const pipeline::ScaleInfo&,double confidence,double iou,int maximum)override{return Decode(values,confidence,iou,maximum,false);}
 std::vector<Detection> PostprocessTracking(const std::vector<std::vector<float>>& values,const pipeline::ScaleInfo&,double confidence,double iou,int maximum)override{return Decode(values,confidence,iou,maximum,true);}
 private:
 const Node& Root()const{return *std::find_if(nodes_.begin(),nodes_.end(),[&](const Node& n){return n.id==root_id_;});}
 std::vector<Detection> Decode(const std::vector<std::vector<float>>& values,double confidence,double iou,int maximum,bool tracking){
  std::vector<Detection> result;size_t offset=0;
  std::vector<int> visible;for(const auto& n:nodes_)visible.push_back(n.post.max_detections);
  const auto candidates=PipelineCandidateLimits(visible);size_t node_index=0;
  for(auto& n:nodes_){if(offset+n.outputs>values.size())throw std::runtime_error("Incomplete pipeline tensor outputs");std::vector<std::vector<float>> own(values.begin()+offset,values.begin()+offset+n.outputs);offset+=n.outputs;
   const auto [h,w]=n.adapter->InputSize();const auto scale=pipeline::compute_scale(width_,height_,w,h);
   const auto threshold=n.id==root_id_?confidence:(tracking?std::min(0.1,n.post.conf_threshold):n.post.conf_threshold);
   const auto overlap=n.id==root_id_?iou:n.post.iou_threshold;const auto limit=tracking?std::min(maximum,candidates.at(node_index)):(n.id==root_id_?maximum:n.post.max_detections);++node_index;
   auto decoded=n.adapter->IsMultiOutput()?n.adapter->PostprocessMulti(own,scale,threshold,overlap,limit):n.adapter->Postprocess(own.at(0),scale,threshold,overlap,limit);
   for(auto& d:decoded){d.model_extra["task_type"]=n.adapter->TaskType();d.model_extra["model_name"]=n.config.name;}
   auto mapped=labels_.Map(n.id,std::move(decoded));for(auto& d:mapped)result.push_back(std::move(d));
  }
  if(result.size()>1000)throw std::runtime_error("Merged detection count exceeds tracking capacity");
  if(offset!=values.size())throw std::runtime_error("Unexpected pipeline tensor outputs");return result;
 }
};
}
