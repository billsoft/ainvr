// Copyright AINVR. Explicit, bounded, one-model-at-a-time hardware smoke probe.
// Run under the main runner's timeout 30s. Never registered with ordinary CTest.
#include "adapters/model_family_adapters.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include "platform/vpu_decoder.hpp"
#include "model_capabilities_probe_checks.hpp"
#include <openssl/evp.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>

namespace {
using ainvr::capabilities_probe::Require;
using Clock=std::chrono::steady_clock;
std::string Digest(const std::vector<uint8_t>& bytes) {
  unsigned char hash[EVP_MAX_MD_SIZE];unsigned size=0;
  Require(EVP_Digest(bytes.data(),bytes.size(),hash,&size,EVP_sha256(),nullptr)==1&&size==32,
      "Fixture SHA256 failed");
  std::ostringstream out;out<<std::hex<<std::setfill('0');
  for(unsigned i=0;i<size;++i)out<<std::setw(2)<<unsigned(hash[i]);return out.str();
}
}

int main(int argc,char** argv) {
  nlohmann::json report={{"passed",false},{"model_loaded",false},{"inference_verified",false},
    {"scene_accuracy_verified",false},{"frontend_unblock_authorized",false}};
  try {
    const auto deadline=Clock::now()+std::chrono::seconds(29);
    auto check_time=[&] {Require(Clock::now()<deadline,"Probe exceeded 29s cooperative deadline; runner must enforce timeout 30s");};
    Require(argc==3||argc==4||argc==5,
        "Usage: ainvr_model_capabilities_probe MODEL_DIR PRESET [--load | --infer JPEG]");
    const bool infer=argc==5&&std::string(argv[3])=="--infer";
    const bool load=infer||(argc==4&&std::string(argv[3])=="--load");
    Require(argc==3||load,"Expected --load or --infer JPEG");
    const std::map<std::string,std::string> presets={
      {"detect-coco-yolo26s","yolo26_bpu"},{"detect-coco-yolo26m","yolo26_bpu"},
      {"face-det-scrfd-2g5","scrfd_bpu"},{"face-det-scrfd-500m","scrfd_bpu"},
      {"helmet-head-yolo26s","yolo26_bpu"},{"helmet-face-yolo26s","yolo26_bpu"},
      {"fire-smoke-yolo26n","yolo26_bpu"},{"human-pose-yolo26s","yolo26_pose_bpu"}};
    const std::string name=argv[2];const auto found=presets.find(name);
    Require(found!=presets.end(),"Unknown capability preset");
    ai_service::config::ModelConfig cfg;cfg.name=name;cfg.adapter=found->second;
    cfg.provider="bpu";cfg.input_size={640,640};
    cfg.path=(std::filesystem::path(argv[1])/(name+".hbm")).string();
    std::ifstream input(cfg.path+".ainvr.json");Require(bool(input),"Missing installed sidecar");
    const auto source=nlohmann::json::parse(input);
    const auto classes=source.at("class_names").get<std::vector<std::string>>();
    cfg.class_names=classes;
    auto adapter=ai_service::adapters::CreateBpuRuntimeAdapter(cfg);
    const auto contract=adapter->ValidateStartContract(); // digest + full layout validation, no SDK
    report.update({{"model",name},{"adapter",cfg.adapter},{"contract_valid",true},
      {"hbm_sha256",contract.at("hbm_sha256")},{"classes",classes},
      {"preprocess",contract.at("preprocess")},{"task_type",adapter->TaskType()},
      {"sidecar_production_approved",source.value("production_approved",false)}});
    check_time();
    if(load) {
      adapter->Load(cfg.path,"bpu","");check_time();
      const auto pre=adapter->DefaultPreprocess();
      report["model_loaded"]=true;report["runtime_metadata"]=adapter->ResultMetadata();
      report["runtime_preprocess"]={{"rgb_order",pre.rgb_order},{"normalize",pre.normalize},
        {"mean",pre.mean},{"std",pre.std},{"letterbox",pre.letterbox},{"padding_color",pre.padding_color}};
      if(infer) {
        const auto fixture=std::filesystem::canonical(argv[4]);
        Require(std::filesystem::is_regular_file(fixture),"Fixture must be a regular JPEG file");
        const auto size=std::filesystem::file_size(fixture);
        Require(size>0&&size<=8*1024*1024,"JPEG byte limit is 8MiB");
        std::ifstream file(fixture,std::ios::binary);std::vector<uint8_t> jpeg(size);
        Require(bool(file.read(reinterpret_cast<char*>(jpeg.data()),jpeg.size())),"Cannot read entire JPEG fixture");
        const auto [width,height]=ai_service::analytics::JpegDimensions(jpeg);
        Require(width>=16&&height>=16&&width%2==0&&height%2==0&&
            size_t(width)*height<=8*1024*1024,"JPEG dimensions unsupported by bounded JPU probe");
        report["fixture"]={{"path",fixture.string()},{"sha256",Digest(jpeg)},
          {"image_size",{width,height}},{"bytes",size},{"distinct_images",1}};
        report["decode_backend"]="jpu";report["requested_frames"]=3;
        report["frames"]=nlohmann::json::array();
        // StrictVisible is the existing JPU->NV12 reader; no software decoder/resize.
        ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,width,height);
        while(true) {check_time();if(decoder.Submit(jpeg,0,50))break;}
        std::optional<ainvr::Nv12Frame> frame;
        while(!frame) {check_time();frame=decoder.Receive(50);}
        Require(frame->width==width&&frame->height==height&&frame->pixels.size()==size_t(width)*height*3/2,
            "JPU NV12 dimensions/size differ from JPEG source");
        const auto [input_h,input_w]=adapter->InputSize();
        const auto scale=ai_service::pipeline::compute_scale(width,height,input_w,input_h);
        bool bounds_valid=true;size_t detection_count=0;
        for(int index=0;index<3;++index) {
          check_time();
          // JPU JPEG output is full-range BT.601, unlike limited-range video.
          const auto result=adapter->RunFrame(*frame,pre,false,true);check_time();
          Require(!result.image_backend.empty()&&result.image_backend.find("cpu")==std::string::npos,
              "Hardware image preprocessing required");
          Require(!result.outputs.empty(),"No BPU output tensors");
          std::vector<size_t> output_sizes;
          for(const auto& output:result.outputs) {
            Require(!output.empty(),"Empty BPU output tensor");output_sizes.push_back(output.size());
            for(float value:output)Require(std::isfinite(value),"Non-finite BPU output");
          }
          const auto started=Clock::now();
          const auto detections=adapter->IsMultiOutput()
            ?adapter->PostprocessMulti(result.outputs,scale,.3,.45,300)
            :adapter->Postprocess(result.outputs.at(0),scale,.3,.45,300);
          auto row=ainvr::capabilities_probe::CheckDetections(detections,width,height,classes,
              cfg.adapter=="yolo26_pose_bpu",contract.at("hbm_sha256").get<std::string>());
          bounds_valid=bounds_valid&&row.at("source_coordinate_bounds_valid").get<bool>();
          detection_count+=detections.size();
          row.update({{"frame",index+1},{"image_backend",result.image_backend},
            {"output_sizes",output_sizes},{"raw_outputs_all_finite",true},
            {"preprocess_ms",result.preprocess_ms},{"inference_ms",result.inference_ms},
            {"output_decode_ms",result.output_decode_ms},
            {"postprocess_ms",std::chrono::duration<double,std::milli>(Clock::now()-started).count()}});
          row["sample_detections"]=nlohmann::json::array();
          // Small audit sample; checks above cover ALL detections and points.
          for(size_t i=0;i<detections.size()&&i<3;++i) {
            const auto& d=detections[i];nlohmann::json item={{"class_id",d.class_id},
              {"class_name",d.class_name},{"confidence",d.confidence},{"bbox",d.bbox},{"model_extra",d.model_extra}};
            if(d.landmarks)item["landmarks"]=*d.landmarks;
            row["sample_detections"].push_back(item);
          }
          ainvr::capabilities_probe::AllFinite(row);
          report["frames"].push_back(row);check_time();
        }
        report["completed_frames"]=report["frames"].size();
        report["raw_outputs_all_finite"]=true;
        report["source_coordinate_bounds_valid"]=bounds_valid;
        report["nonempty_detections"]=detection_count>0;
        report["inference_completed"]=true;
        report["inference_verified"]=bounds_valid;
        report["detection_schema_exercised"]=detection_count>0;
        report["smoke_passed"]=bounds_valid;
        // Invalid pose points remain auditable, but must have score=0 / visible=0.
        Require(bounds_valid,"Valid source-coordinate bounds failed; see raw and invalid point counts");
      }
    }
    check_time();report["passed"]=true;std::cout<<report.dump(2)<<'\n';return 0;
  } catch(const std::exception& e) {
    report["error"]=e.what();std::cout<<report.dump(2)<<'\n';return 1;
  }
}
