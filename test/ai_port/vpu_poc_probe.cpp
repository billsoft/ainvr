// Copyright AINVR. Exercise the production VPU wrapper, including EOS reorder.
#include "platform/vpu_decoder.hpp"
#include "stream/media_source.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <iostream>
int main(int argc,char**argv){try{
  if(argc!=4 && argc!=5)throw std::runtime_error("Usage: probe media output.yuv report.json [maximum_frames 1..500]");
  size_t consumed=0; const auto maximum=argc==5?std::stoul(argv[4],&consumed):120UL;
  if(maximum<1||maximum>500||(argc==5&&consumed!=std::string(argv[4]).size()))throw std::runtime_error("Invalid frame bound");
  if(std::filesystem::exists(argv[2])||std::filesystem::exists(argv[3]))throw std::runtime_error("Output exists");
  ainvr::MediaSource source(argv[1]);auto info=source.Info();
  ainvr::VpuDecoder decoder(info.codec,info.width,info.height);
  std::map<uint64_t,std::optional<int64_t>> pending;
  nlohmann::json frames=nlohmann::json::array();uint64_t count=0;
  std::ofstream pixels(argv[2],std::ios::binary);if(!pixels)throw std::runtime_error("Cannot write pixels");
  auto receive=[&](int timeout){
    auto frame=decoder.Receive(timeout);if(!frame)return;
    auto match=pending.find(frame->pts);if(match==pending.end())throw std::runtime_error("Unknown or duplicate token");
    frames.push_back({{"token",frame->pts},{"pts_ns",match->second.value_or(-1)}});
    pending.erase(match);pixels.write(reinterpret_cast<const char*>(frame->pixels.data()),frame->pixels.size());
  };
  while(auto packet=source.Read()){
    if(count>=maximum)throw std::runtime_error("Limit exceeded");
    pending.emplace(count,packet->pts_ns);
    auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    while(!decoder.Submit(packet->bytes,count,50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("Input stalled");}
    ++count;receive(50);
  }
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  while(!decoder.Finish(50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("EOS stalled");}
  while(!pending.empty()&&std::chrono::steady_clock::now()<deadline)receive(100);
  if(!pending.empty())throw std::runtime_error("Unmatched input frames");
  pixels.close();if(!pixels)throw std::runtime_error("Pixel write failed");
  std::ofstream report(argv[3]);report<<nlohmann::json({{"frames",frames}}).dump(2);report.close();
  if(!report)throw std::runtime_error("Report write failed");return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
