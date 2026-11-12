// Copyright AINVR. Thread-affine, shared BPU models and GPU plate preparation.
#pragma once
#include "adapters/plate_decode.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/tensor_decode.hpp"
#include "platform/gles_preprocess.hpp"
#include "platform/vpu_decoder.hpp"
#include <functional>
#include <thread>
namespace ainvr::plate {
class Hardware {
 public:
  Hardware(const std::string& detector,const std::string& recognizer,std::vector<std::string> alphabet)
      :detect_(BpuModel::Acquire(detector)),recognize_(BpuModel::Acquire(recognizer)),alphabet_(std::move(alphabet)){
    if(alphabet_.size()!=78||alphabet_[0]!="#")throw std::invalid_argument("Plate alphabet contract mismatch");
    dd_=detect_->Describe();rd_=recognize_->Describe();
    Check(dd_,{1,3,640,640},{{1,300,14}});
    Check(rd_,{1,3,48,168},{{1,21,78},{1,5}});
  }
  nlohmann::json Run(const Nv12Frame& frame,const std::function<bool()>& current,
                     const std::optional<std::array<int,4>>& vehicle_region=std::nullopt,bool bt709=false,bool full_range=true,bool live_frame=false){
    if(owner_!=std::this_thread::get_id())throw std::logic_error("Plate hardware thread mismatch");
    auto check=[&]{if(!current||!current()||!BpuRuntimeHealthy())throw std::runtime_error("Plate task expired or hardware unavailable");};
    check();ImageTransform dt;dt.yuv_bt709=bt709;dt.yuv_full_range=full_range;
    int source_width=frame.width,source_height=frame.height,offset_x=0,offset_y=0;
    if(vehicle_region){const auto& r=*vehicle_region;
      if(r[0]<0||r[1]<0||r[2]<16||r[3]<16||int64_t(r[0])+r[2]>frame.width||int64_t(r[1])+r[3]>frame.height)
        throw std::invalid_argument("Vehicle ROI must belong to the retained frame");
      dt.source_region=std::array<float,4>{float(r[0]),float(r[1]),float(r[2]),float(r[3])};
      offset_x=r[0];offset_y=r[1];source_width=r[2];source_height=r[3];
    }
    auto detection=Infer(*detect_,dd_,images_.RunNv12(frame.pixels,frame.width,frame.height,dt));check();
    auto boxes=Decode(detection.at(0),source_width,source_height,live_frame?.01f:.25f);
    for(auto& d:boxes){d.box[0]+=offset_x;d.box[2]+=offset_x;d.box[1]+=offset_y;d.box[3]+=offset_y;
      for(auto& q:d.corners){q[0]+=offset_x;q[1]+=offset_y;}}

    nlohmann::json results=nlohmann::json::array();
    // Bounded candidate fanout; never turn one retained frame into unbounded BPU work.
    size_t count=0,recognized_count=0;
    for(auto& box:boxes){if(!live_frame&&count++>=4)break;check();
      auto distance=[](Point a,Point b){return std::hypot(a[0]-b[0],a[1]-b[1]);};
      int w=std::max(int(distance(box.corners[0],box.corners[1])),int(distance(box.corners[2],box.corners[3])));
      int h=std::max(int(distance(box.corners[0],box.corners[3])),int(distance(box.corners[1],box.corners[2])));
      nlohmann::json result={{"box",box.box},{"corners",box.corners},{"detection_score",box.score},{"double_row",box.double_row},{"plate_pixels",{w,h}}};
      if(w<16||h<12||w>2048||h>1024){result["status"]="unreadable_geometry";results.push_back(result);continue;}
      // Live detection is complete even when OCR has exhausted its per-frame
      // budget. Keep the target and explicit null attributes, never hide it.
      if(live_frame&&(box.score<.25f||recognized_count>=4)){
        result["status"]=box.score<.25f?"low_detection_score":"recognition_budget";
        results.push_back(std::move(result));continue;
      }
      ++recognized_count;
      // Model reference maps integer pixel centers to [0,w-1] and [0,h-1].
      // Convert to pixel edges for the shared GPU unit-square transform.
      auto corners=box.corners;for(auto& q:corners){q[0]=std::clamp(std::floor(q[0]),0.f,float(frame.width-1))+.5f;q[1]=std::clamp(std::floor(q[1]),0.f,float(frame.height-1))+.5f;}
      ImageTransform warp;warp.width=w;warp.height=h;warp.letterbox=false;warp.yuv_bt709=bt709;warp.yuv_full_range=full_range;
      auto m=Homography(corners,frame.width,frame.height);
      // Output UV=(pixel+.5)/extent -> reference pixel/(extent-1).
      const double sx=double(w)/(w-1),sy=double(h)/(h-1),ox=-.5/(w-1),oy=-.5/(h-1);
      for(int row=0;row<3;++row){m[row*3+2]+=m[row*3]*ox+m[row*3+1]*oy;m[row*3]*=sx;m[row*3+1]*=sy;}
      warp.projective_uv=m;
      auto rgba=images_.RunNv12Rgba(frame.pixels,frame.width,frame.height,warp);check();
      if(box.double_row){ImageTransform split;split.width=w*2;split.height=h-h/3;split.letterbox=false;split.plate_split_height=h;
        rgba=images_.RunRgbaRgba(rgba,w,h,split);w=split.width;h=split.height;}
      ImageTransform rt;rt.width=168;rt.height=48;rt.letterbox=false;rt.bgr=true;
      rt.mean={149.94f,149.94f,149.94f};rt.divisor={49.215f,49.215f,49.215f};
      auto recognized=Infer(*recognize_,rd_,images_.Run(rgba,w,h,rt));check();
      auto text=Ctc(recognized.at(0),alphabet_);const auto& colors=recognized.at(1);
      if(!std::all_of(colors.begin(),colors.end(),[](float v){return std::isfinite(v);}))throw std::runtime_error("Nonfinite plate color output");
      result["status"]=text.value.empty()?"unreadable":"candidate";result["text"]=text.value;
      result["character_scores"]=text.character_scores;result["color_index"]=std::max_element(colors.begin(),colors.end())-colors.begin();
      result["score_semantics"]="uncalibrated_model_softmax";results.push_back(std::move(result));
    }
    return {{"schema_version",1},{"status",results.empty()?"plate_not_detected":"candidates"},{"candidates",results},
      {"candidate_limit",live_frame?300:4},{"recognition_limit",4},{"recognized_count",recognized_count},{"detected_count",boxes.size()},{"image_backend","gles"},{"inference_backend","bpu"},{"accuracy_verified",false}};
  }
 private:
  static void Check(const nlohmann::json& d,const std::vector<int>& input,const std::vector<std::vector<int>>& outputs){
    if(d.at("inputs").size()!=1||d.at("inputs").at(0).at("shape").get<std::vector<int>>()!=input||d.at("outputs").size()!=outputs.size())
      throw std::invalid_argument("Plate HBM tensor contract mismatch");
    for(size_t i=0;i<outputs.size();++i)if(d.at("outputs").at(i).at("shape").get<std::vector<int>>()!=outputs[i])throw std::invalid_argument("Plate HBM output order mismatch");
  }
  static std::vector<std::vector<float>> Infer(BpuModel& model,const nlohmann::json& desc,const std::vector<float>& image){
    auto raw=model.Run(PackBpuFloatInputs(image,desc.at("inputs"),"",{}));std::vector<std::vector<float>> out;
    for(size_t i=0;i<raw.size();++i)out.push_back(DecodeTensor(raw[i],desc.at("outputs").at(i)));return out;
  }
  std::shared_ptr<BpuModel> detect_,recognize_;
  nlohmann::json dd_,rd_;std::vector<std::string> alphabet_;GlesPreprocessor images_;
  std::thread::id owner_=std::this_thread::get_id();
};
}
