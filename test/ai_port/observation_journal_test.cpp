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
 nlohmann::json before;
 {
  ObservationJournal journal(root,"processor");journal.Stage(sample(1));before=journal.Status();
  bool rejected=false;try{ObservationJournal second(root,"processor");}catch(...){rejected=true;}assert(rejected);
 }
 {
  ObservationJournal journal(root,"processor");assert(journal.Status().at("producer_id")==before.at("producer_id"));
  assert(journal.Status().at("next_offset")=="1");journal.Stage(sample(2));journal.Stage(sample(3));
 }
 {
  ObservationJournal journal(root+"-quota","processor",1024*1024,1);journal.Stage(sample(1));
  bool full=false;try{journal.Stage(sample(2));}catch(...){full=true;}assert(full);assert(journal.Status().at("next_offset")=="1");
  const auto identity=std::filesystem::path(root+"-quota")/ObservationJournal::Hash("processor")/"producer.json";
  std::ifstream input(identity);const std::string before_state((std::istreambuf_iterator<char>(input)),{});
  for(int i=0;i<100;i++){try{journal.Stage(sample(2));assert(false);}catch(...){}}
  std::ifstream after_input(identity);const std::string after_state((std::istreambuf_iterator<char>(after_input)),{});
  assert(before_state==after_state);assert(journal.Status().at("full_rejections")==101);
  std::filesystem::remove(identity.parent_path()/"00000000000000000000.json");
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  journal.Stage(sample(2));assert(journal.Status().at("next_offset")=="2");
 }
 std::cout<<"Native ordered observation journal PASS\n";
}
