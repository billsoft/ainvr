// Bounded manual hardware validation. Never launched by ordinary CTest.
#include "adapters/plate_hardware.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include <fstream>
#include <iostream>
#include <chrono>
int main(int argc,char** argv){try{
  if(argc!=5&&argc!=6)throw std::invalid_argument("usage: plate_probe detector.hbm recognition.hbm contract.json image.jpg [repeat 1..5]");
  std::ifstream contract(argv[3]);auto config=nlohmann::json::parse(contract);
  std::ifstream in(argv[4],std::ios::binary);std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(in)),{});
  auto [w,h]=ai_service::analytics::JpegDimensions(jpeg);
  if(w%2||h%2||w<16||h<16||size_t(w)*h>8*1024*1024||jpeg.size()>8*1024*1024)throw std::invalid_argument("Unsupported JPEG dimensions");
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(45);
  auto current=[&]{return std::chrono::steady_clock::now()<deadline;};
  ainvr::plate::Hardware hardware(argv[1],argv[2],ainvr::plate::Utf8Symbols(config.at("charset")));
  ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,w,h);
  while(!decoder.Submit(jpeg,0,50))if(!current())throw std::runtime_error("JPEG submit timeout");
  std::optional<ainvr::Nv12Frame> frame;
  while(!frame){if(!current())throw std::runtime_error("JPEG decode timeout");frame=decoder.Receive(50);}
  int repeat=argc==6?std::stoi(argv[5]):1;if(repeat<1||repeat>5)throw std::invalid_argument("repeat out of range");
  for(int i=0;i<repeat;++i){const auto started=std::chrono::steady_clock::now();auto result=hardware.Run(*frame,current);
    result["probe_iteration"]=i;result["probe_ms"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
    result["independent_evidence"]=false;std::cout<<result.dump()<<std::endl;}
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}}
