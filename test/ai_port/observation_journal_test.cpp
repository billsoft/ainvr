#include "../../ai-service/src/analytics/observation_journal.hpp"
#include <cassert>
#include <iostream>
#include <thread>
using ai_service::analytics::ObservationJournal;
ai_service::FrameResult sample(int index){
 ai_service::FrameResult r;r.channel_id="processor";r.stream_url="rtmp://127.0.0.1:1935/live/test";
 r.timestamp=1792368000+index;r.frame_pts_ns=9007199254740993LL+index;r.frame_index=index;r.frame_width=1000;r.frame_height=1000;r.model_name="test";
 const double x=index==1?.2:index==2?.5:.9;
 r.model_extra={{"label_catalog",{{"schema_version","1.0"},{"adapter","test_bpu"},{"labels",nlohmann::json::array({{{"class_id",0},{"label_id","person"},{"name","Person"},{"description",""}}})}}},
 {"analytics",{{"status","active"},{"stream_session_id","native-session"},{"tracks",nlohmann::json::array({{{"track_id","t"},{"label_id","person"},{"state","confirmed"},{"observation","detected"},{"last_observed_pts_ns",std::to_string(r.frame_pts_ns)},{"bbox",{{"x",x*1000},{"y",400},{"w",20},{"h",20}}}}})}}}};
 return r;
}
int main(int argc,char** argv){
 assert(argc==2);const std::string root=argv[1];
 {
  using ai_service::analytics::RegionObservationCapabilities;
  auto r=sample(1);auto& catalog=r.model_extra["label_catalog"];
  catalog["adapter"]="analysis_pipeline";
  catalog["attributes"]={{"pose",{{"layout","coco17"}}}};
  catalog["labels"][0]["name"]="person";catalog["labels"][0]["source_adapter"]="yolo26_bpu";
  r.model_extra["analysis_pipeline"]={{"complete",false}};
  assert(RegionObservationCapabilities(r).empty());
  r.model_extra["analysis_pipeline"]["complete"]=true;
  assert(RegionObservationCapabilities(r).at("suspected_down").at("state")=="valid");
  r.model_extra["analysis_pipeline"]["unassociated_observations"]=nlohmann::json::array({{{"attributes",{{"pose",nlohmann::json::object()}}}}});
  assert(RegionObservationCapabilities(r).at("suspected_down").at("state")=="unknown");
  r.model_extra["analysis_pipeline"]["unassociated_observations"]=nlohmann::json::array();
  r.model_extra["analysis_pipeline"]["unassociated_omitted"]=1;
  assert(RegionObservationCapabilities(r).at("suspected_down").at("state")=="unknown");
  catalog.erase("attributes");catalog["labels"][0]["name"]="head";
  assert(RegionObservationCapabilities(r).empty());
  catalog["labels"][0]["name"]="no_helmet";
  assert(RegionObservationCapabilities(r).contains("helmet_violation"));
  catalog["labels"][0]["source_adapter"]="yoloe_bpu";
  assert(RegionObservationCapabilities(r).empty());
 }
 nlohmann::json before;
 {
  ObservationJournal journal(root,"processor");journal.Stage(sample(1));assert(journal.Flush());before=journal.Status();
  bool rejected=false;try{ObservationJournal second(root,"processor");}catch(...){rejected=true;}assert(rejected);
 }
 {
  ObservationJournal journal(root,"processor");assert(journal.Status().at("producer_id")==before.at("producer_id"));
  assert(journal.Status().at("next_offset")=="1");journal.Stage(sample(2));journal.Stage(sample(3));
 }
 {
  ObservationJournal journal(root+"-quota","processor",1024*1024,1);journal.Stage(sample(1));assert(journal.Flush());
  bool full=false;try{journal.Stage(sample(2));}catch(...){full=true;}assert(full);assert(journal.Status().at("next_offset")=="1");
  const auto identity=std::filesystem::path(root+"-quota")/ObservationJournal::Hash("processor")/"producer.json";
  std::ifstream input(identity);const std::string before_state((std::istreambuf_iterator<char>(input)),{});
  for(int i=0;i<100;i++){try{journal.Stage(sample(2));assert(false);}catch(...){}}
  std::ifstream after_input(identity);const std::string after_state((std::istreambuf_iterator<char>(after_input)),{});
  assert(before_state==after_state);assert(journal.Status().at("full_rejections")==101);
  std::filesystem::remove(identity.parent_path()/"00000000000000000000.json");
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  journal.Stage(sample(2));assert(journal.Flush());assert(journal.Status().at("next_offset")=="2");
 }
 {
  ObservationJournal journal(root+"-gap","processor");auto f=sample(1);
  f.model_extra["analytics"]["continuity_gap"]=true;journal.Stage(f);assert(journal.Flush());
  auto file=std::filesystem::path(root+"-gap")/ObservationJournal::Hash("processor")/"00000000000000000000.json";
  std::ifstream input(file);nlohmann::json record;input>>record;
  assert(record.at("gap")==true);
  assert(record.at("stream_session_id")=="native-session");
  assert(record.at("tracks").at(0).at("track_id")=="t");
 }
 {
  ObservationJournal journal(root+"-attributes","processor");auto f=sample(1);
  f.model_extra["analytics"]["status"]="detection_only";
  f.model_extra["analytics"]["tracks"]=nlohmann::json::array();
  ai_service::Detection d;d.class_id=0;d.label_id="person";d.bbox={10,20,30,40};
  d.model_extra={{"source_node","pose"},{"attributes",{{"pose",{{"schema_version","1.0"},{"status","observed"}}}}}};
  f.detections.push_back(d);journal.Stage(f);assert(journal.Flush());
  auto file=std::filesystem::path(root+"-attributes")/ObservationJournal::Hash("processor")/"00000000000000000000.json";
  std::ifstream input(file);nlohmann::json record;input>>record;
  assert(record.at("tracks").empty());
  assert(record.at("detections").at(0).at("attributes")==d.model_extra.at("attributes"));
  assert(record.at("detections").at(0).at("source_node")=="pose");
  assert(!record.at("detections").at(0).contains("track_id"));
 }
 {
  ObservationJournal journal(root+"-attribute-budget","processor");auto f=sample(1);
  f.model_extra["analytics"]["status"]="detection_only";f.model_extra["analytics"]["tracks"]=nlohmann::json::array();
  auto& catalog=f.model_extra["label_catalog"];catalog["adapter"]="yolo26_pose_bpu";
  catalog["labels"][0]["name"]="person";catalog["attributes"]={{"pose",{{"layout","coco17"}}}};
  for(int i=0;i<1000;++i){ai_service::Detection d;d.class_id=0;d.label_id="person";d.bbox={10,20,30,40};d.model_extra={{"attributes",{{"pose",std::string(1900,'x')}}}};f.detections.push_back(std::move(d));}
  journal.Stage(f);assert(journal.Flush());
  const auto file=std::filesystem::path(root+"-attribute-budget")/ObservationJournal::Hash("processor")/"00000000000000000000.json";
  std::ifstream input(file);nlohmann::json record;input>>record;
  assert(record.at("detections").size()==1000);
  assert(record.at("attribute_delivery").at("targets")==1000);
  assert(record.at("region_observations").at("suspected_down").at("state")=="unknown");
  assert(!record.at("detections")[0].contains("attributes"));
 }
 std::cout<<"Native ordered observation journal PASS\n";
}
