// Copyright AINVR. Offline startup/router guards;fake bytes cannot prove HBM loading.
#include "adapters/model_family_adapters.hpp"
#include "pipeline/reused_channel_worker.hpp"
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
using nlohmann::json;
void require(bool value){if(!value)throw std::runtime_error("Start-contract assertion failed");}
int main(int argc,char**argv){try{
 if(argc!=2)throw std::runtime_error("New fixture directory required");
 const std::filesystem::path root(argv[1]);require(!std::filesystem::exists(root));std::filesystem::create_directory(root);
 const auto path=root/"fixture.hbm";{std::ofstream f(path);f<<"AINVR offline metadata fixture; not an HBM\n";}
 ai_service::config::ChannelConfig cfg;cfg.id="offline-locate";cfg.stream.url="rtmp://127.0.0.1/live/xm";
 cfg.inference_fps=1.0/60;auto& c=cfg.model;c.name="locateanything-3b";c.adapter="locateanything_bpu";c.provider="bpu";c.path=path.string();c.input_size={224,448};c.max_new_tokens=256;c.description="person";c.label_id="person";c.label_name="Person";
 json original={{"schema_version",1},{"target","rdk_s100p"},{"adapter","locateanything_bpu"},
  {"model_family","locateanything-3b"},{"architecture","original36_qwen_moonvit27_shared_programs"},
  {"component_count",76},{"physical_hbm_files",46},{"text_layers",36},{"vision_blocks",27},{"vocabulary_size",152681},
  {"input_size",{224,448}},{"input_contract","complete-hbm-components-rgb-chw-v1"},
  {"output_contract","locateanything_geometry_tokens_v1"},{"image_resample","pillow9-bicubic-rgb8"},
  {"hbm_sha256","651992fc8633df56c5c02f3a53afe20ba36d64a64900944896f703293dff6a7f"},{"generation",{{"socket","/home/sunrise/ainvr/data/ai/offline-never-connect.sock"},{"contract_sha256",std::string(64,'a')},{"maximum_seconds",180},{"mode","slow"}}}};
 auto save=[&](const json&m){std::ofstream f(path.string()+".ainvr.json");f<<m.dump();};save(original);
 auto validate=[&](const ai_service::config::ChannelConfig&value){ai_service::pipeline::ReusedChannelWorker worker(value,{},"/home/sunrise/ainvr/ai-service");worker.ValidateStart();};
 validate(cfg);auto adapter=ai_service::adapters::CreateBpuRuntimeAdapter(c);require(adapter->ValidateStartContract()==original);
 int negatives=0;
 auto reject=[&](const ai_service::config::ChannelConfig&value){bool failed=false;try{validate(value);}catch(const std::exception&){failed=true;}require(failed);++negatives;};
 for(const auto&entry:std::vector<std::pair<std::string,json>>{{"component_count",75},{"physical_hbm_files",45},{"text_layers",35},{"vision_blocks",26},{"vocabulary_size",32768},{"target","other"},{"adapter","yoloe_bpu"},{"input_size",json::array({448,448})},{"output_contract","end2end_xyxy_score_class"},{"image_resample","bilinear"},{"hbm_sha256",std::string(64,'0')}}){auto m=original;m[entry.first]=entry.second;save(m);reject(cfg);}
 for(const auto&entry:std::vector<std::pair<std::string,json>>{{"mode","fast"},{"maximum_seconds",0},{"socket","/tmp/other.sock"},{"contract_sha256",std::string(64,'z')}}){auto m=original;m["generation"][entry.first]=entry.second;save(m);reject(cfg);}
 save(original);for(const auto&provider:{"cpu","cuda"}){auto bad=cfg;bad.model.provider=provider;reject(bad);}
 auto bad=cfg;bad.model.max_new_tokens=257;reject(bad);bad=cfg;bad.model.input_size={448,448};reject(bad);
 // Validation is still performed by the unchanged detector implementation.
 auto yolo=cfg;yolo.model.name="yoloe-26x";yolo.model.adapter="yoloe_bpu";yolo.model.path="/home/sunrise/ainvr/ai-service/models/derived/s100p/yoloe-26x.hbm";yolo.model.input_size={640,640};yolo.model.max_new_tokens=64;yolo.model.description="helmet";yolo.inference_fps=10;
 validate(yolo);
 std::cout<<json({{"status","passed"},{"positive_offline_model_router_controls",2},{"negative_controls",negatives},{"existing8_slot_real_manifest_validated",true},{"fake_artifact",true},{"scope","Only metadata/router checks;no SDK load,no inference,no production changes"},{"neural_calls",0}}).dump()<<'\n';
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
