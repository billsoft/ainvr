// AINVR. Offline real tracker -> hidden/predicted display -> SSD journal fixture.
// No decoder, BPU task, image encoding or production configuration access.
#include "../../ai-service/src/analytics/frame_analytics.hpp"
#include "../../ai-service/src/analytics/observation_journal.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service;
int main(int argc,char** argv){
  assert(argc==2);
  analytics::Config config;config.enabled=true;config.options.confirmation_hits=1;
  analytics::FrameAnalytics tracker(analytics::PhaseEffective(config));
  analytics::ObservationJournal journal(argv[1],"processor");
  std::string identity;
  for(int seq=0;seq<15;++seq){
    FrameResult frame;frame.channel_id="processor";frame.stream_url="rtmp://127.0.0.1:1935/live/quality";
    frame.frame_width=1000;frame.frame_height=1000;frame.model_name="native-quality-fixture";
    frame.frame_index=9007199254740995LL+seq;frame.frame_pts_ns=9007199254740993LL+int64_t(seq)*100000000;
    frame.timestamp=1792368000.0+seq*.1;
    const bool hidden=seq==11||seq==13,lost=seq==12;
    if(!lost){Detection d;d.bbox={100+seq*20.0,400,100,200};d.class_id=0;d.class_name="Person";d.label_id="person";d.confidence=hidden?.15:.9;d.confidence_known=true;frame.detections.push_back(d);}
    tracker.Apply(frame,1,1);
    if(seq<10)continue;
    if(hidden)frame.detections.clear();
    analytics::MarkHiddenObservations(frame);
    const auto& tracks=frame.model_extra.at("analytics").at("tracks");
    assert(!tracks.empty());
    if(identity.empty())identity=tracks[0].at("track_id").get<std::string>();
    assert(tracks[0].at("track_id")==identity);
    if(hidden)assert(tracks[0].at("display_kind")=="low_confidence");
    if(lost)assert(tracks[0].at("observation")=="lost"&&tracks[0].contains("predicted_bbox"));
    frame.model_extra["label_catalog"]={{"schema_version","1.0"},{"adapter","test_bpu"},
      {"labels",nlohmann::json::array({{{"class_id",0},{"label_id","person"},{"name","Person"},{"description",""}}})}};
    journal.Stage(frame);
  }
  std::cout<<"Native tracker quality journal PASS\n";
}
