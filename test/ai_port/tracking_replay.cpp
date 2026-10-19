// Copyright AINVR. Offline tracking replay:recorded detections -> FrameAnalytics (no BPU, no video).
// Input  {"frames":[{"pts":ns,"w":W,"h":H,"dets":[{"b":{"x","y","w","h"},"p":conf,"c":"person"}]}]}
// Output {"frames":[{"pts":ns,"ids":["<track id or empty>" per input detection]}]}
#include "../../ai-service/src/analytics/frame_analytics.hpp"
#include <fstream>
#include <iostream>
using namespace ai_service;
int main(int argc,char** argv) {
  if(argc!=3) {std::cerr<<"usage: tracking_replay input.json output.json\n";return 2;}
  std::ifstream in(argv[1]);const auto input=nlohmann::json::parse(in);
  analytics::Config config;config.enabled=true;
  analytics::FrameAnalytics tracker(analytics::PhaseEffective(config));
  auto frames=nlohmann::json::array();
  std::map<std::string,int> classes;
  for(const auto& f:input.at("frames")) {
    FrameResult r;r.channel_id="replay";r.frame_pts_ns=f.at("pts").get<int64_t>();
    r.frame_width=f.at("w").get<int>();r.frame_height=f.at("h").get<int>();r.timestamp=0;
    for(const auto& d:f.at("dets")) {
      Detection x;const auto& b=d.at("b");
      x.bbox={b.at("x").get<double>(),b.at("y").get<double>(),b.at("w").get<double>(),b.at("h").get<double>()};
      x.class_name=d.at("c").get<std::string>();
      x.class_id=classes.emplace(x.class_name,int(classes.size())).first->second;
      x.confidence=d.at("p").get<double>();x.confidence_known=true;
      r.detections.push_back(x);
    }
    tracker.Apply(r,1,1);
    auto ids=nlohmann::json::array();
    for(const auto& d:r.detections) ids.push_back(d.track_id);
    auto coast=nlohmann::json::array();
    for(const auto& d:analytics::CoastDetections(r)) coast.push_back({{"t",d.track_id},{"b",d.bbox}});
    frames.push_back({{"pts",r.frame_pts_ns},{"ids",ids},{"coast",coast}});
  }
  std::ofstream(argv[2])<<nlohmann::json({{"frames",frames}}).dump()<<"\n";
  std::cout<<"{\"status\":\"completed\",\"frames\":"<<frames.size()<<"}\n";
}
