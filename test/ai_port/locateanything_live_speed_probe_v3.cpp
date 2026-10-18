// Copyright AINVR. Real4K VPU/GLES/113HBM/native adapter/JSON/SEI encoding;isolated speed only.
#include "adapters/model_family_adapters.hpp"
#include "stream/media_source.hpp"
#include "stream/sei.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <optional>
int main(int argc,char**argv){
  using Clock=std::chrono::steady_clock;using nlohmann::json;
  if(argc!=4)return 2;
  if(std::filesystem::exists(argv[3]))return 3;
  json report={{"status","starting"},{"evaluation_only",true},{"release_approved",false},
    {"accuracy_verified",false},{"production_channel_modified",false},{"stream_published",false},
    {"archive_verified",false},{"cpu_neural_fallback",false},{"cpu_pixel_processing",false},{"runs",json::array()}};
  auto save=[&]{std::ofstream file(argv[3]);file<<report.dump(2)<<"\n";if(!file)throw std::runtime_error("Report write failed");};
  try{
    save();const auto start=Clock::now();
    ainvr::MediaSource source(argv[1],5000);const auto info=source.Info();
    ainvr::VpuDecoder decoder(info.codec,info.width,info.height);
    std::optional<ainvr::Nv12Frame> captured;bool started=false;uint64_t number=0;
    const auto capture_deadline=Clock::now()+std::chrono::seconds(25);
    for(int packets=0;packets<1200 && !captured && Clock::now()<capture_deadline;++packets){
      auto packet=source.Read();if(!packet)break;if(!started){if(!packet->key_frame)continue;started=true;}
      if(!decoder.Submit(packet->bytes,number++,100))throw std::runtime_error("VPU packet submission failed");
      captured=decoder.Receive(100);
    }
    source.Cancel();if(!captured)throw std::runtime_error("No actual VPU frame received");
    report["capture_seconds"]=std::chrono::duration<double>(Clock::now()-start).count();
    report["source_size"]={captured->width,captured->height};report["source_pts"]=captured->pts;
    if(captured->width!=3840)throw std::runtime_error("Expected current4K input");
    ai_service::config::ModelConfig cfg;cfg.name="locateanything-3b";cfg.adapter="locateanything_bpu";
    cfg.provider="bpu";cfg.path=argv[2];cfg.input_size={224,448};cfg.description="person";cfg.max_new_tokens=128;
    cfg.label_id="isolated-speed-person";cfg.label_name="Person";
    auto adapter=ai_service::adapters::CreateBpuRuntimeAdapter(cfg);const auto setup=Clock::now();
    adapter->Load(cfg.path,cfg.provider,"");report["adapter_setup_seconds"]=std::chrono::duration<double>(Clock::now()-setup).count();
    report["status"]="running";save();
    for(int run=0;run<2;++run){
      const auto begin=Clock::now();auto result=adapter->RunFrame(*captured,adapter->DefaultPreprocess(),info.bt709,info.full_range);
      const auto post=Clock::now();ai_service::pipeline::ScaleInfo scale;scale.orig_w=captured->width;scale.orig_h=captured->height;
      auto detections=adapter->PostprocessMulti(result.outputs,scale,.25,.45,300);const auto metadata=adapter->ResultMetadata();
      json items=json::array();for(const auto& d:detections)items.push_back({{"class_id",d.class_id},{"label_id",d.label_id},{"class_name",d.class_name},{"query_description",d.query_description},{"confidence",d.confidence},{"bbox",d.bbox}});
      const auto payload=ai_service::sei::build_result_payload("locate-speed-v3",0,0,detections,1024,metadata);
      const auto nal=ai_service::sei::build_sei_nal(payload);const auto decoded=ai_service::sei::parse_sei_nal(nal);
      if(decoded.size()!=1 || decoded[0].second!=payload)throw std::runtime_error("SEI metadata roundtrip failed");
      report["runs"].push_back({{"index",run},{"same_actual_frame",true},{"image_backend",result.image_backend},
        {"preprocess_ms",result.preprocess_ms},{"inference_ms",result.inference_ms},
        {"postprocess_json_sei_ms",std::chrono::duration<double,std::milli>(Clock::now()-post).count()},
        {"frame_to_json_sei_seconds",std::chrono::duration<double>(Clock::now()-begin).count()},
        {"generated_ids",result.outputs[0]},{"terminal",result.outputs[3][0]==1},{"detections",items},
        {"metadata",metadata},{"sei_bytes",nal.size()},{"sei_roundtrip_exact",true}});save();
    }
    report["status"]="completed";report["scope"]="Same real4K VPU frame twice through native subclass,GLES preprocessing,local backend all113HBM components,geometry,commonJSON and SEI encoding;not stream publication,archive,UI or quality acceptance";save();return 0;
  }catch(const std::exception& error){report["status"]="failed";report["error"]=error.what();save();std::cerr<<error.what()<<"\n";return 1;}
}
