// Copyright AINVR. Real adapter output/control tests;zero neural calls.
#include <fstream>
#include <iostream>
#include <unistd.h>
#include "adapters/model_family_adapters.hpp"
using nlohmann::json;
using ai_service::adapters::LocateAnythingBpuAdapter;
void require(bool value){if(!value)throw std::runtime_error("LocateAnything adapter assertion failed");}
std::vector<std::vector<float>> values(const json& response){
  std::vector<std::vector<float>> out(4);
  for(size_t i=0;i<response.at("generated_ids").size();++i){
    out[0].push_back(response["generated_ids"][i].get<float>());
    out[1].push_back(response["token_logprobs"][i].is_null()?0:response["token_logprobs"][i].get<float>());
    out[2].push_back(response["token_logprobs"][i].is_null()?0:1);
  }
  out[3]={response.at("terminal").get<bool>()?1.0f:0.0f};return out;
}
int main(int argc,char**argv){
  if(argc!=2)return 2;
  std::ifstream f(argv[1]);json fixture;f>>fixture;
  ai_service::config::ModelConfig cfg;cfg.name="locateanything-3b";cfg.adapter="locateanything_bpu";
  cfg.provider="bpu";cfg.input_size={224,448};cfg.label_id="stable-id";cfg.label_name="display-name";
  ai_service::pipeline::ScaleInfo scale;scale.orig_w=3840;scale.orig_h=2160;
  size_t cases=0,boxes=0;
  for(const auto& c:fixture.at("cases")){
    cfg.description=c.at("query");
    auto owned=ai_service::adapters::CreateBpuRuntimeAdapter(cfg);auto& adapter=*owned;
    require(adapter.InputSize()==std::pair<int,int>{224,448});
    require(!adapter.SupportsFramePipeline() && adapter.IsMultiOutput() && adapter.ActualProvider()=="bpu");
    require(adapter.ReportsGenerationStatus() && !adapter.IsPrompted());
    const auto p=adapter.DefaultPreprocess();require(!p.letterbox && p.interpolation=="bicubic" && p.rgb_order && p.mean[0]==127.5 && p.std[0]==127.5);
    require(!adapter.ResultMetadata()["grounding"]["complete"].get<bool>());
    const auto detections=adapter.PostprocessMulti(values(c.at("response")),scale,.25,.45,300);
    require(detections.size()==c.at("expected_boxes").get<size_t>() && adapter.ResultMetadata()["grounding"]["complete"].get<bool>());
    for(const auto& d:detections)require(d.label_id==cfg.label_id && d.class_name==cfg.label_name && d.query_description==cfg.description);
    ++cases;boxes+=detections.size();
  }
  auto owned=ai_service::adapters::CreateBpuRuntimeAdapter(cfg);auto& adapter=*owned;
  auto point=values({{"generated_ids",{151668,152177,151927,151669,151645}},
      {"token_logprobs",{-.1,-.1,-.1,-.1,-.1}},{"terminal",true}});
  require(adapter.PostprocessMulti(point,scale,.25,.45,300).empty());
  const auto extra=adapter.ResultMetadata();require(extra["grounding"]["points"][0]["x"]==.5 && extra["grounding"]["points"][0]["y"]==.25);
  size_t rejected=0;
  auto reject=[&](const std::vector<std::vector<float>>& input){
    // A failed new output must not retain the preceding point as complete.
    adapter.PostprocessMulti(point,scale,.25,.45,300);
    require(adapter.ResultMetadata()["grounding"]["complete"].get<bool>());
    bool failure=false;
    try{adapter.PostprocessMulti(input,scale,.25,.45,300);}
    catch(const std::exception&){failure=true;}
    require(failure);
    const auto metadata=adapter.ResultMetadata().at("grounding");
    require(!metadata.at("complete").get<bool>() && metadata.at("points").empty());
    ++rejected;
  };
  auto bad=point;bad[3][0]=0;reject(bad);bad=point;bad[0][0]=1.5;reject(bad);
  bad=point;bad[2][0]=.5;reject(bad);bad=point;bad[1][0]=.1;reject(bad);
  bad=point;bad.pop_back();reject(bad);
  bool missing=false;try{adapter.Load("/home/sunrise/ainvr/test/no-locate-model.hbm","bpu","");}catch(const std::exception&){missing=true;}require(missing);
  const std::string anchor="/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1/vision-fp32-prefix-v4/model.hbm";
  require(std::filesystem::is_regular_file(anchor) && !std::filesystem::exists(anchor+".ainvr.json"));
  bool incomplete=false;
  auto anchor_cfg=cfg;anchor_cfg.path=anchor;
  auto anchor_adapter=ai_service::adapters::CreateBpuRuntimeAdapter(anchor_cfg);
  try{anchor_adapter->Load(anchor,"bpu","");}
  catch(const std::exception& error){incomplete=std::string(error.what()).find("complete-model manifest is missing")!=std::string::npos;}
  require(incomplete);
  bool wrong_family=false;auto invalid=cfg;invalid.name="different-model";
  try{ai_service::adapters::CreateBpuRuntimeAdapter(invalid);}catch(const std::invalid_argument&){wrong_family=true;}
  require(wrong_family);
  // Retention is model-owned metadata,read before any BPU/GLES load.
  const auto temporary=std::filesystem::path("/home/sunrise/ainvr/test/results")/
      ("locateanything-retention-control-"+std::to_string(::getpid()));
  require(!std::filesystem::exists(temporary));std::filesystem::create_directory(temporary);
  auto retention_cfg=cfg;retention_cfg.path=(temporary/"control-only.hbm").string();
  auto retention_adapter=ai_service::adapters::CreateBpuRuntimeAdapter(retention_cfg);
  const auto manifest_path=retention_cfg.path+".ainvr.json";
  const auto make_manifest=[&](const json& manifest){std::ofstream file(manifest_path);file<<manifest.dump();};
  json retention_manifest={{"model_family","locateanything-3b"},{"component_count",213},
    {"generation",{{"maximum_seconds",120}}},{"media_retention",{{"delay_seconds",125},
      {"maximum_bytes",int64_t(16)*1024*1024*1024},{"maximum_frames",18001},
      {"spool_directory","/mnt/ainvr-ssd/ainvr-au-cache"}}}};
  make_manifest(retention_manifest);const auto retention=retention_adapter->FrameRetention();
  require(retention.has_value() && retention->delay_seconds==125 && retention->maximum_frames==18001);
  auto grouped_manifest=retention_manifest;grouped_manifest["component_count"]=113;
  grouped_manifest["architecture"]="original36_official_four_groups";
  make_manifest(grouped_manifest);require(retention_adapter->FrameRetention()->delay_seconds==125);
  auto official_shared=grouped_manifest;official_shared["component_count"]=76;
  official_shared["architecture"]="original36_qwen_moonvit27_shared_programs";
  make_manifest(official_shared);require(retention_adapter->FrameRetention()->delay_seconds==125);
  size_t compact_layouts=0;
  for(int count:{113,117}){
    auto compact=grouped_manifest;compact["component_count"]=count;
    compact["architecture"]="original36_compact_affine_four_groups";
    make_manifest(compact);require(retention_adapter->FrameRetention()->delay_seconds==125);++compact_layouts;
  }
  size_t layout_rejected=0;
  for(int count:{0,112,114}){auto invalid=grouped_manifest;invalid["component_count"]=count;make_manifest(invalid);
    bool failed=false;try{retention_adapter->FrameRetention();}catch(const std::exception&){failed=true;}require(failed);++layout_rejected;}
  auto wrong_layout=grouped_manifest;wrong_layout.erase("architecture");make_manifest(wrong_layout);
  bool missing_layout=false;try{retention_adapter->FrameRetention();}catch(const std::exception&){missing_layout=true;}require(missing_layout);++layout_rejected;
  for(const auto& layout:std::vector<std::pair<int,std::string>>{
      {117,"original36_official_four_groups"},{113,"unknown"},{117,"unknown"},
      {75,"original36_qwen_moonvit27_shared_programs"},
      {77,"original36_qwen_moonvit27_shared_programs"},
      {76,"unknown"},{113,"original36_qwen_moonvit27_shared_programs"},
      {112,"original36_compact_affine_four_groups"},{114,"original36_compact_affine_four_groups"}}){
    auto invalid=grouped_manifest;invalid["component_count"]=layout.first;invalid["architecture"]=layout.second;
    make_manifest(invalid);bool failed=false;
    try{retention_adapter->FrameRetention();}catch(const std::exception&){failed=true;}
    require(failed);++layout_rejected;
  }
  size_t retention_rejected=0;
  for(const auto& changed:std::vector<json>{
      {{"delay_seconds",3}},{{"maximum_bytes",int64_t(32)*1024*1024*1024}},
      {{"maximum_frames",8192}},{{"spool_directory","/tmp/incorrect-spool"}}}){
    auto invalid_manifest=retention_manifest;invalid_manifest["media_retention"].update(changed);make_manifest(invalid_manifest);
    bool failed=false;try{retention_adapter->FrameRetention();}catch(const std::exception&){failed=true;}
    require(failed);++retention_rejected;
  }
  std::filesystem::remove(manifest_path);std::filesystem::remove(temporary);
  std::cout<<json({{"status","completed"},{"recorded_cases",cases},{"recorded_boxes",boxes},{"negative_output_cases",rejected},
      {"point_metadata_normalized",true},{"missing_model_rejected",missing},{"neural_calls",0},
      {"factory_owns_locateanything_subclass",true},{"real_anchor_without_complete_manifest_rejected",incomplete},
      {"wrong_model_family_rejected",wrong_family},
      {"retention_metadata_validated_before_load",true},{"grouped113_layout_validated",true},{"official76_shared_layout_validated",true},{"compact_layouts_validated",compact_layouts},{"invalid_layouts_rejected",layout_rejected},{"invalid_retention_contracts_rejected",retention_rejected},
      {"scope","Own inference subclass control/output routing only;not full BPU/service/SEI/archive acceptance"}}).dump()<<"\n";
}
