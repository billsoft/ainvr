// Copyright AINVR. Pure result routing tests, not an HBM inference probe.
#include <fstream>
#include <iostream>
#include "adapters/locateanything_result_decode.hpp"
using nlohmann::json;
using ai_service::adapters::DecodeLocateAnythingGeometry;
void require(bool value) { if (!value) throw std::runtime_error("Geometry assertion failed"); }
json response(std::vector<int> ids) {
  return {{"generated_ids", ids}, {"token_logprobs", std::vector<double>(ids.size(), -.1)}, {"terminal", true}};
}
int main(int argc,char**argv) {
  if (argc != 2) return 2;
  std::ifstream f(argv[1]); json fixtures; f >> fixtures;
  size_t boxes=0,cases=0,negative=0;
  for (const auto& c : fixtures.at("cases")) {
    const auto result=DecodeLocateAnythingGeometry(c.at("response"),3840,2160,c.at("query"),"stable-id","display-name",300);
    require(result.detections.size()==c.at("expected_boxes").get<size_t>() && result.points.empty());
    for(const auto& d:result.detections) {
      require(d.label_id=="stable-id" && d.class_name=="display-name" && d.query_description==c.at("query"));
      require(d.bbox[0]>=0 && d.bbox[1]>=0 && d.bbox[0]+d.bbox[2]<=3840.00001 && d.bbox[1]+d.bbox[3]<=2160.00001);
    }
    boxes+=result.detections.size();++cases;
  }
  auto b=response({151668,151777,151877,152477,152577,151669,151645});
  const auto result=DecodeLocateAnythingGeometry(b,3840,2160,"person","id","Person",10);
  require(result.detections.size()==1);
  require(std::abs(result.detections[0].bbox[0]-384)<1e-8);
  require(std::abs(result.detections[0].bbox[1]-432)<1e-8);
  require(std::abs(result.detections[0].bbox[2]-2688)<1e-8);
  require(std::abs(result.detections[0].bbox[3]-1512)<1e-8);
  auto point=response({151668,152177,151927,151669,151645});
  const auto pr=DecodeLocateAnythingGeometry(point,3840,2160,"point","id","Point",10);
  require(pr.detections.empty() && pr.points.size()==1 && pr.points[0]["x"]==1920 && pr.points[0]["y"]==540);
  auto unknown=b;unknown["token_logprobs"][1]=nullptr;
  require(!DecodeLocateAnythingGeometry(unknown,3840,2160,"q","id","",10).detections[0].confidence_known);
  auto empty=response({151668,4064,151669,151645});
  require(DecodeLocateAnythingGeometry(empty,3840,2160,"q","id","",10).detections.empty());
  auto reject=[&](const json& value,int w=3840,int h=2160,int maximum=10) {
    bool thrown=false;try {DecodeLocateAnythingGeometry(value,w,h,"q","id","",maximum);}catch(const std::exception&){thrown=true;}
    require(thrown);++negative;
  };
  auto bad=b;bad["terminal"]=false;reject(bad);
  bad=b;bad["generated_ids"][6]=4064;reject(bad);
  bad=b;bad["generated_ids"][1]=152681;reject(bad);
  bad=b;bad["generated_ids"][1]=151676;reject(bad);
  bad=b;bad["generated_ids"][3]=151677;reject(bad);
  bad=b;bad["generated_ids"].erase(5);bad["token_logprobs"].erase(5);reject(bad);
  bad=b;bad["token_logprobs"][1]=.1;reject(bad);
  bad=b;bad["token_logprobs"].erase(0);reject(bad);
  reject(b,0);reject(b,3840,2160,0);
  std::cout<<json({{"status","completed"},{"recorded_response_cases",cases},{"recorded_boxes",boxes},
    {"negative_cases",negative},{"synthetic_geometry_controls",4},{"neural_calls",0},
    {"scope","Pure shared-result decoding;not full BPU model/SEI/archive acceptance"}}).dump()<<"\n";
}
