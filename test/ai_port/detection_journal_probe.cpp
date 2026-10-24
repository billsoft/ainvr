#include "../../ai-service/src/analytics/observation_journal.hpp"
#include <cassert>
int main(int argc,char** argv){
 assert(argc==2);ai_service::FrameResult r;
 r.channel_id="processor";r.stream_url="rtmp://127.0.0.1:1935/live/test";r.timestamp=1792368001;
 r.frame_pts_ns=1000000000;r.frame_index=1;r.frame_width=1000;r.frame_height=1000;r.model_name="test";
 r.model_extra={{"label_catalog",{{"schema_version","1.0"},{"adapter","test_bpu"},{"labels",nlohmann::json::array({{{"class_id",0},{"label_id","person"},{"name","Person"},{"description",""}}})}}},
 {"analytics",{{"status","detection_only"},{"stream_session_id","detection-session"},{"tracks",nlohmann::json::array()}}}};
 ai_service::Detection d;d.label_id="person";d.bbox={100,100,50,100};r.detections.push_back(d);
 ai_service::analytics::ObservationJournal j(argv[1],r.channel_id);j.Stage(r);
 assert(j.Status().at("staged")==1);
}
