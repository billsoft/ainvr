// Copyright AINVR. Compare the same real decoded images, sequential vs overlapped.
#include "adapters/bpu_channel_adapter.hpp"
#include "stream/source.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>

int main(int argc,char** argv){
 try{
  if(argc!=3||std::filesystem::exists(argv[2]))throw std::invalid_argument("config JSON, new report");
  std::ifstream file(argv[1]);auto cfg=ai_service::config::ChannelConfigFromJson(nlohmann::json::parse(file));
  ai_service::stream::StreamSource source(cfg.stream.url,"pipeline-parity",false);source.Start();
  std::vector<std::shared_ptr<ai_service::stream::FrameRef>> frames;
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);
  while(frames.size()<8&&std::chrono::steady_clock::now()<deadline){auto f=source.PullFrameRef(100);if(f)frames.push_back(f);}
  source.Stop();if(frames.size()!=8)throw std::runtime_error("Insufficient real frames");
  auto path=std::filesystem::path(cfg.model.path);if(path.is_relative())path=std::filesystem::path("/home/sunrise/ainvr/ai-service")/path;
  cfg.model.path=path.string();
  ai_service::adapters::BpuChannelAdapter adapter(cfg.model);
  adapter.Load(path.string(),"bpu","");auto pre=adapter.DefaultPreprocess();
  auto run=[&](int i){const auto& f=*frames[i%frames.size()];return adapter.RunFrame(f.nv12,pre,f.bt709,f.full_range);};
  auto async=[&](int i){const auto& f=*frames[i%frames.size()];return adapter.RunFrameAsync(f.nv12,pre,f.bt709,f.full_range);};
  run(0);constexpr int count=64;
  std::vector<ainvr::BpuImageResult> reference;auto start=std::chrono::steady_clock::now();
  for(int i=0;i<count;++i)reference.push_back(run(i));
  double serial=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  start=std::chrono::steady_clock::now();auto previous=async(0);
  for(int i=0;i<count;++i){
   std::future<ainvr::BpuImageResult> next;if(i+1<count)next=async(i+1);
   auto actual=previous.get();
   if(actual.outputs!=reference[i].outputs||actual.image_backend!=reference[i].image_backend)
    throw std::runtime_error("Pipeline output mismatch at frame "+std::to_string(i));
   previous=std::move(next);
  }
  double pipelined=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  nlohmann::json report={{"passed",true},{"frames_compared",count},{"distinct_real_frames",frames.size()},
   {"model",cfg.model.name},{"metadata",adapter.ResultMetadata()},
   {"serial_fps",count/serial},{"pipeline_fps",count/pipelined},
   {"outputs_exactly_equal",true},{"image_backend",reference[0].image_backend},
   {"scope","Same eight actual decoded 4K frames repeated 64 times, same HBM and preprocessing; not a new accuracy dataset"}};
  std::ofstream out(argv[2]);out<<report.dump(2)<<'\n';std::cout<<report.dump()<<'\n';
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
