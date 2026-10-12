// Copyright AINVR. Read actual published inference metadata, never inject it.
#include "stream/media_source.hpp"
#include "stream/sei.hpp"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>

int main(int argc,char** argv) {
  try {
    if(argc!=5)throw std::invalid_argument("Expected output URL, channel ID, label ID, new report");
    if(std::filesystem::exists(argv[4]))throw std::runtime_error("Report exists");
    ainvr::MediaSource source(argv[1],5000);const auto info=source.Info();
    const auto codec=info.codec==ainvr::Codec::H264?ai_service::stream::VideoCodec::kH264:ai_service::stream::VideoCodec::kH265;
    auto samples=nlohmann::json::array();
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(25);
    for(int packets=0;packets<240&&std::chrono::steady_clock::now()<deadline;++packets) {
      auto packet=source.Read();if(!packet)break;
      const auto starts=ai_service::sei::find_annexb_nals(packet->bytes);
      for(size_t i=0;i<starts.size();++i) {
        const size_t begin=starts[i].first;
        size_t end=i+1<starts.size()?starts[i+1].first-starts[i+1].second:packet->bytes.size();
        while(end>begin&&packet->bytes[end-1]==0)--end;
        if(end<=begin)continue;
        std::vector<uint8_t> nal(packet->bytes.begin()+begin,packet->bytes.begin()+end);
        if(ai_service::stream::NalType(codec,nal[0])!=(codec==ai_service::stream::VideoCodec::kH264?6:39))continue;
        for(const auto& [type,payload]:ai_service::sei::parse_sei_nal(nal,codec)) {
          const auto& uuid=ai_service::sei::SEI_UUID;
          if(type!=5||payload.size()<uuid.size()||!std::equal(uuid.begin(),uuid.end(),payload.begin()))continue;
          auto metadata=nlohmann::json::parse(payload.begin()+uuid.size(),payload.end());
          if(metadata.at("ch")!=argv[2])throw std::runtime_error("Wrong inference channel on published stream");
          if(metadata.at("det").empty())continue;
          for(const auto& detection:metadata.at("det")) {
            if(detection.at("l")!=argv[3]||detection.at("c")!=0||detection.at("p").get<double>()<.25)
              throw std::runtime_error("Runtime YOLOE label/confidence did not reach SEI output");
          }
          samples.push_back(metadata);
        }
      }
      if(samples.size()>=3)break;
    }
    source.Cancel();
    if(samples.size()<3)throw std::runtime_error("Insufficient real detection SEI readback");
    nlohmann::json report={{"passed",true},{"source_size",{info.width,info.height}},
      {"scope","Actual production YOLOE inference -> original SEI publisher -> SRS -> demux/SEI readback"},
      {"samples",samples},{"injected_test_metadata",false},{"video_reencoded",false}};
    std::ofstream(argv[4])<<report.dump(2)<<'\n';
    std::cout<<"PASS actual YOLOE labels in "<<samples.size()<<" SRS output SEI frames\n";
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
