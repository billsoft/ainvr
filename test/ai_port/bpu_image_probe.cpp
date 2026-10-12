// Copyright AINVR. Bounded hardware validation, not user-model accuracy validation.
#include "platform/bpu_image_runner.hpp"
#include "stream/media_source.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
int main(int argc,char** argv) {
  try {
    if(argc!=5)throw std::invalid_argument("Usage: probe input_url nv12_model.hbm frames report.json");
    const int limit=std::stoi(argv[3]);
    if(limit<1||limit>60)throw std::invalid_argument("Frame limit must be 1..60");
    if(std::filesystem::exists(argv[4]))throw std::runtime_error("Report already exists");
    using Clock=std::chrono::steady_clock;
    auto begin=Clock::now(),deadline=begin+std::chrono::seconds(90);
    ainvr::MediaSource source(argv[1],5000);auto info=source.Info();
    ainvr::VpuDecoder decoder(info.codec,info.width,info.height);
    ainvr::BpuImageRunner runner(argv[2],ainvr::BpuImageContract::Nv12EmbeddedPreprocess);
    auto shape=runner.Description().at("inputs").at(0).at("shape").get<std::vector<int>>();
    if(shape.size()!=4)throw std::runtime_error("Not a fixed NV12 image model");
    ainvr::ImageTransform transform;transform.height=shape[1];transform.width=shape[2];
    transform.yuv_bt709=info.bt709;transform.yuv_full_range=info.full_range;
    transform.divisor={1,1,1};
    uint64_t submitted=0,read=0;bool started=false;
    std::map<uint64_t,std::optional<int64_t>> pending;
    nlohmann::json frames=nlohmann::json::array();
    auto receive=[&](int timeout){
      auto frame=decoder.Receive(timeout);if(!frame)return false;
      auto match=pending.find(frame->pts);
      if(match==pending.end())throw std::runtime_error("Unexpected or duplicate decoded timestamp");
      auto pts=match->second;pending.erase(match);
      if(frames.size()>=size_t(limit))return true;
      auto result=runner.Run(*frame,transform);
      nlohmann::json outputs=nlohmann::json::array();
      for(auto& values:result.outputs){
        double sum=0;float maximum=-INFINITY,minimum=INFINITY;
        for(float value:values){if(!std::isfinite(value))throw std::runtime_error("Non-finite BPU output");
          sum+=value;maximum=std::max(maximum,value);minimum=std::min(minimum,value);}
        if(values.empty())throw std::runtime_error("Empty BPU output");
        outputs.push_back({{"elements",values.size()},{"sum",sum},{"minimum",minimum},{"maximum",maximum}});
      }
      frames.push_back({{"token",frame->pts},{"pts_ns",pts.value_or(-1)},
        {"image_backend",result.image_backend},{"preprocess_ms",result.preprocess_ms},
        {"inference_ms",result.inference_ms},{"output_decode_ms",result.output_decode_ms},
        {"outputs",outputs}});return true;
    };
    while(frames.size()<size_t(limit)&&Clock::now()<deadline){
      if(++read>600)throw std::runtime_error("Compressed input packet limit exceeded");
      auto packet=source.Read();if(!packet)break;
      if(!started){if(!packet->key_frame)continue;started=true;}
      pending.emplace(submitted,packet->pts_ns);
      auto submit_deadline=Clock::now()+std::chrono::seconds(5);
      while(!decoder.Submit(packet->bytes,submitted,50)){
        receive(50);
        if(Clock::now()>submit_deadline)throw std::runtime_error("Decoder input stalled");
      }
      ++submitted;receive(50);
    }
    if(frames.size()<size_t(limit)){
      auto drain_deadline=Clock::now()+std::chrono::seconds(5);
      while(!decoder.Finish(50)){receive(50);if(Clock::now()>drain_deadline)throw std::runtime_error("Decoder EOS stalled");}
      while(frames.size()<size_t(limit)&&Clock::now()<drain_deadline)receive(50);
    }
    if(frames.size()!=size_t(limit))throw std::runtime_error("Did not collect the requested number of hardware frames");
    source.Cancel();
    nlohmann::json report={{"passed",true},{"purpose","official HBM hardware interface validation; not user-model conversion or accuracy acceptance"},
      {"source_width",info.width},{"source_height",info.height},{"source_bt709",info.bt709},
      {"source_full_range",info.full_range},{"model",runner.Description()},{"frames",frames},
      {"cpu_inference",false},{"cpu_image_processing",false},
      {"elapsed_ms",std::chrono::duration<double,std::milli>(Clock::now()-begin).count()}};
    std::ofstream file(argv[4]);file<<report.dump(2)<<"\n";file.close();
    if(!file)throw std::runtime_error("Report write failed");
    std::cout<<"Validated "<<frames.size()<<" frames through VPU -> hardware image processing -> BPU\n";
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
