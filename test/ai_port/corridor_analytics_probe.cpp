// Copyright AINVR. Real hardware-decoded fixture -> BPU -> production analytics.
#include "adapters/bpu_channel_adapter.hpp"
#include "analytics/frame_analytics.hpp"
#include "analytics/candidate_results.hpp"
#include <fstream>
#include <filesystem>
#include <iostream>
int main(int argc,char**argv){try{
 if((argc<5||argc>7)||std::filesystem::exists(argv[4]))throw std::runtime_error("Usage: model raw_nv12 frame_report new_report [sample_stride 1..25] [line_x 0..1]");
 size_t consumed=0;const auto stride=argc>=6?std::stoul(argv[5],&consumed):5UL;
 if(stride<1||stride>25||(argc>=6&&consumed!=std::string(argv[5]).size()))throw std::runtime_error("Invalid stride");
 size_t line_consumed=0;const double line_x=argc==7?std::stod(argv[6],&line_consumed):.5;
 if(!std::isfinite(line_x)||line_x<=0||line_x>=1||(argc==7&&line_consumed!=std::string(argv[6]).size()))throw std::runtime_error("Invalid line position");
 ai_service::config::ModelConfig model;model.name="yolo26x";model.path=argv[1];
 ai_service::adapters::BpuChannelAdapter adapter(model);adapter.Load(model.path,"bpu","");
 auto pre=adapter.DefaultPreprocess();auto [h,w]=adapter.InputSize();
 auto scale=ai_service::pipeline::compute_scale(1920,1080,w,h);
 std::ifstream meta(argv[3]);auto frames=nlohmann::json::parse(meta).at("frames");
 if(frames.empty()||frames.size()>500)throw std::runtime_error("Expected 1..500 verified frames");
 std::ifstream pixels(argv[2],std::ios::binary);if(!pixels)throw std::runtime_error("Cannot open pixels");
 ai_service::analytics::Config config;config.enabled=true;
 config.options.rules={{"fixture-line","line","class:0",{{line_x,.25},{line_x,.9}},5}};
 ai_service::analytics::FrameAnalytics analytics(config);
 auto results=nlohmann::json::array();size_t targets=0,tracked=0;
 for(size_t i=0;i<frames.size();i+=stride){
  ainvr::Nv12Frame image;image.width=1920;image.height=1080;image.pts=i;
  image.pixels.resize(1920*1080*3/2);pixels.seekg(i*image.pixels.size());
  pixels.read(reinterpret_cast<char*>(image.pixels.data()),image.pixels.size());
  if(!pixels)throw std::runtime_error("Truncated verified fixture");
  auto output=adapter.RunFrame(image,pre,false,false);
  if(output.outputs.size()!=1)throw std::runtime_error("Unexpected output count");
  auto candidates=adapter.Postprocess(output.outputs[0],scale,.1,.45,1000);
  auto visible=adapter.Postprocess(output.outputs[0],scale,.25,.45,300);
  ai_service::FrameResult frame;frame.channel_id="corridor-hardware-probe";
  frame.frame_width=1920;frame.frame_height=1080;frame.frame_index=i;
  frame.frame_pts_ns=frames.at(i).at("pts_ns").get<int64_t>();frame.model_name=model.name;
  frame.detections=candidates;analytics.Apply(frame,1,1);
  ai_service::analytics::CopyTrackIdentities(frame.detections,visible);
  frame.detections=visible;targets+=visible.size();
  for(const auto& d:visible)if(!d.track_id.empty())++tracked;
  results.push_back({{"frame",frame.ToDict()},{"image_backend",output.image_backend},
    {"inference_ms",output.inference_ms},{"preprocess_ms",output.preprocess_ms}});
 }
 if(targets==0||tracked==0)throw std::runtime_error("No actual detections or track associations");
 nlohmann::json report={{"status","PASS"},{"scope","BPU tracking and test-line events; no manually annotated accuracy claim"},
 {"rule",{{"type","line"},{"label","class:0"},{"points",{{line_x,.25},{line_x,.9}}},{"anchor","observed_bbox_bottom_center"}}},{"sample_stride",stride},{"processed_frames",results.size()},{"detections",targets},{"tracked_detections",tracked},
 {"color_assumption","unspecified source color uses production BT601 limited default"},
 {"results",results}};
 std::ofstream dest(argv[4]);dest<<report.dump(2)<<'\n';if(!dest)throw std::runtime_error("Report write failed");
 std::cout<<"PASS: "<<results.size()<<" frames, "<<targets<<" detections, "<<tracked<<" associations\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
