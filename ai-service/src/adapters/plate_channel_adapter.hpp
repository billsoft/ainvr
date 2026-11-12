// Copyright AINVR. Plate detector -> perspective correction -> OCR as one bounded capability.
#pragma once
#include "bpu_channel_adapter.hpp"
#include "plate_hardware.hpp"
#include "pipeline_limits.hpp"
#include <fstream>
#include <filesystem>
namespace ai_service::adapters {
class PlateChannelAdapter final:public BpuChannelAdapter {
 std::string detector_,recognizer_;std::unique_ptr<ainvr::plate::Hardware> hardware_;nlohmann::json candidates_=nlohmann::json::array(),manifest_;
 int frame_width_=0,frame_height_=0;
 std::function<bool()> current_=[] {return true;};
 nlohmann::json Verify(const std::string& path)const{const auto side=path+".ainvr.json";if(std::filesystem::file_size(side)>1024*1024)throw std::runtime_error("Plate manifest too large");std::ifstream f(side);auto m=nlohmann::json::parse(f);if(m.at("hbm_bytes").get<uintmax_t>()!=std::filesystem::file_size(path)||m.at("hbm_sha256")!=ModelFileDigest(path))throw std::runtime_error("Plate model contract mismatch");return m;}
 public:
 explicit PlateChannelAdapter(const config::ModelConfig& cfg):BpuChannelAdapter(cfg),detector_(cfg.path),recognizer_((std::filesystem::path(cfg.path).parent_path()/"plate-recog-color.hbm").string()){}
 nlohmann::json ValidateStartContract()const override{return {{"detector",Verify(detector_)},{"recognizer",Verify(recognizer_)}};}
 void Load(const std::string&,const std::string&,const std::string&)override{Verify(detector_);manifest_=Verify(recognizer_);hardware_=std::make_unique<ainvr::plate::Hardware>(detector_,recognizer_,ainvr::plate::Utf8Symbols(manifest_.at("charset")));}
 void SetCancellationProbe(std::function<bool()> f)override{current_=[cancel=std::move(f)]{return !cancel||!cancel();};}
 std::pair<int,int> InputSize()const override{return {640,640};}
 pipeline::PreprocessConfig DefaultPreprocess()const override{return {};}
 bool SupportsFramePipeline()const override{return false;}
 std::string TaskType()const override{return "object_detection";}
 nlohmann::json ResultMetadata()const override{return {{"execution_backend","s100p_bpu"},{"label_catalog",{{"schema_version","1.0"},{"adapter","plate_bpu"},{"labels",nlohmann::json::array({{{"class_id",0},{"label_id","plate"},{"name","license_plate"},{"description",""}}})}}}};}
 ainvr::BpuImageResult RunFrame(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig&,bool bt709,bool full)override{
  if(!PlateSourceSupported(frame.width,frame.height))throw std::runtime_error("Plate source exceeds 8388608 pixels");if(!hardware_)throw std::runtime_error("Plate node not loaded");const auto started=std::chrono::steady_clock::now();
  frame_width_=frame.width;frame_height_=frame.height;
  candidates_=hardware_->Run(frame,current_,std::nullopt,bt709,full,true).at("candidates");
  ainvr::BpuImageResult result;result.outputs={{}};result.image_backend="gles";result.inference_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();return result;
 }
 std::future<ainvr::BpuImageResult> RunFrameAsync(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& pre,bool bt709,bool full)override{return std::async(std::launch::deferred,[this,&frame,pre,bt709,full]{return RunFrame(frame,pre,bt709,full);});}
 std::vector<Detection> Postprocess(const std::vector<float>&,const pipeline::ScaleInfo&,double confidence,double,int maximum)override{
  std::vector<Detection> detections;for(const auto& row:candidates_){const auto score=row.at("detection_score").get<double>();if(score<confidence||int(detections.size())>=maximum)continue;auto box=row.at("box").get<std::array<double,4>>();box[0]=std::clamp(box[0],0.,double(frame_width_));box[2]=std::clamp(box[2],0.,double(frame_width_));box[1]=std::clamp(box[1],0.,double(frame_height_));box[3]=std::clamp(box[3],0.,double(frame_height_));if(box[2]<=box[0]||box[3]<=box[1])continue;Detection d;d.class_name="license_plate";d.label_id="plate";d.confidence=score;d.bbox={box[0],box[1],box[2]-box[0],box[3]-box[1]};d.model_extra["attributes"]={{"plate_text",{{"type","string"},{"value",row.contains("text")&&!row.at("text").get<std::string>().empty()?row.at("text"):nlohmann::json(nullptr)},{"status",row.at("status")},{"score_semantics","uncalibrated"}}},{"plate_color",{{"type","enum"},{"value",row.contains("color_index")?row.at("color_index"):nlohmann::json(nullptr)}}},{"double_row",{{"type","boolean"},{"value",row.at("double_row")}}}};detections.push_back(std::move(d));}return detections;
 }
};
}
