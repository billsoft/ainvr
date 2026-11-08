// AINVR. Replay recorded observations, never generate detections or touch live state.
#include "analytics/frame_analytics.hpp"
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
int main(int argc,char** argv){try{
 if(argc!=3)throw std::runtime_error("Usage: tracking_replay_probe observations.jsonl output.jsonl");
 std::ifstream in(argv[1]);std::ofstream out(argv[2]);if(!in||!out)throw std::runtime_error("Cannot open replay files");
 std::map<std::string,std::unique_ptr<ai_service::analytics::FrameAnalytics>> trackers;
 std::map<std::string,int64_t> last;
 std::string line;size_t frames=0;
 while(std::getline(in,line)){
  if(line.size()>1024*1024)throw std::runtime_error("Replay frame too large");
  auto j=nlohmann::json::parse(line);ai_service::FrameResult f;
  f.channel_id=j.at("channel_id");f.frame_pts_ns=j.at("frame_pts_ns");f.frame_index=j.at("frame_index");
  f.frame_width=j.at("frame_width");f.frame_height=j.at("frame_height");f.timestamp=j.at("timestamp");
  if(last.count(f.channel_id)&&f.frame_pts_ns<=last.at(f.channel_id))throw std::runtime_error("Replay source is not monotonic");
  for(const auto& d:j.at("detections")){
   ai_service::Detection b;const auto& box=d.at("bbox");b.bbox={box.at("x"),box.at("y"),box.at("w"),box.at("h")};
   b.class_id=d.at("class_id");b.label_id="class:"+std::to_string(b.class_id);b.class_name=d.value("class_name",b.label_id);
   b.confidence_known=d.contains("confidence")&&d.at("confidence").is_number();b.confidence=b.confidence_known?d.at("confidence").get<double>():0;
   f.detections.push_back(std::move(b));
  }
  auto& tracker=trackers[f.channel_id];if(!tracker){ai_service::analytics::Config c;c.enabled=true;tracker=std::make_unique<ai_service::analytics::FrameAnalytics>(c,true);}
  tracker->Apply(f,1,1,f.timestamp);last[f.channel_id]=f.frame_pts_ns;
  j["assigned_ids"]=nlohmann::json::array();for(const auto& d:f.detections)j["assigned_ids"].push_back(d.track_id);j["model_extra"]={{"analytics",f.model_extra.at("analytics")}};out<<j.dump()<<'\n';++frames;
 }
 std::cout<<"replayed="<<frames<<" channels="<<trackers.size()<<'\n';
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}