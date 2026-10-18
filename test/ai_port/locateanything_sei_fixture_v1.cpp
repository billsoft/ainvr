// Copyright AINVR. Real C++ SEI bytes for browser/recorder contract tests.
// Synthetic NAL framing only;not a real camera/SRS or neural inference test.
#include "stream/sei.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
namespace sei = ai_service::sei;
using nlohmann::json;
std::string hex(const std::vector<uint8_t>& bytes) {
  const char* digits="0123456789abcdef";std::string out;
  for(auto byte:bytes){out.push_back(digits[byte>>4]);out.push_back(digits[byte&15]);}return out;
}
int main(int argc,char**argv){
  if(argc!=2)return 2;
  const auto target=std::filesystem::absolute(argv[1]);
  if(target.parent_path()!=std::filesystem::path("/home/sunrise/ainvr/test/results") || std::filesystem::exists(target))
    throw std::invalid_argument("Expected a new task result file");
  json fixtures=json::array();
  for(auto codec:{sei::VideoCodec::kH264,sei::VideoCodec::kH265}){
    for(const auto kind:{"point","clear","budget","legacy","mixed"}){
      json extra=json::object();std::vector<ai_service::Detection> detections;
      if(std::string(kind)!="legacy"){
        json points=json::array();const int n=std::string(kind)=="clear"?0:std::string(kind)=="budget"?40:1;
        for(int i=0;i<n;++i)points.push_back({{"x",.5},{"y",.25},{"class_name","定位 } \"点"},
          {"label_id","stable-point"},{"query_description","Point to: person."},{"confidence",nullptr}});
        extra={{"grounding",{{"complete",true},{"coordinate_space","normalized_full_frame"},{"points",points}}}};
      }
      if(std::string(kind)=="legacy" || std::string(kind)=="mixed"){
        ai_service::Detection d;d.class_name="person";d.confidence=.9;d.bbox={1,2,3,4};detections.push_back(d);
      }
      const auto payload=sei::build_result_payload("point-contract",123000000,0,detections,1024,extra);
      if(payload.empty())throw std::runtime_error("Fixture lost all geometry");
      const auto nal=sei::build_sei_nal(payload,codec);
      const std::vector<uint8_t> au=codec==sei::VideoCodec::kH264?
        std::vector<uint8_t>{0,0,0,1,0x67,0x42,0,0,0,1,0x65,0x88,0x84}:
        std::vector<uint8_t>{0,0,0,1,0x40,1,0x0c,0,0,0,1,0x26,1,0x9a};
      const auto framed=sei::inject_sei_annexb(au,nal,codec);
      const auto parsed=sei::parse_sei_nal(nal,codec);
      if(parsed.size()!=1)throw std::runtime_error("Invalid codec roundtrip");
      fixtures.push_back({{"codec",codec==sei::VideoCodec::kH264?"h264":"h265"},{"kind",kind},
        {"payload",json::parse(payload)},{"payload_hex",hex(payload)},{"nal_hex",hex(nal)},
        {"annexb_hex",hex(framed)},{"uuid_and_payload_bytes",payload.size()+sei::SEI_UUID.size()}});
    }
  }
  const json report={{"scope","Actual C++ codec bytes;synthetic NALs,zero neural calls;not real stream acceptance"},
    {"neural_calls",0},{"status","generated"},{"fixtures",fixtures}};
  std::ofstream(target)<<report.dump(2)<<"\n";
  std::cout<<json({{"status","generated"},{"cases",fixtures.size()},{"neural_calls",0}}).dump()<<"\n";
}
